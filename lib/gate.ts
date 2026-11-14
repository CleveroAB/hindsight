// ============================================================================
// The front-door gate. Hindsight has two deployment shapes, and this gate is
// what makes each one safe. Which shape you're in is decided by one thing:
// whether HINDSIGHT_AUTH_USER + HINDSIGHT_AUTH_PASSWORD are both set.
//
//   UNSET — "local + quick-tunnel share" (the default).
//     The app is yours alone on localhost/LAN. A strategy can still be shared
//     by exposing the web server through a tunnel (`cloudflared tunnel --url
//     http://localhost:3000`, or ngrok); for any request that arrived THROUGH
//     a tunnel, only the read-only share page exists — every other path (the
//     app, the whole API, /_next assets) 404s. See tunnelGate().
//
//   SET — "hosted on a public domain".
//     The IP heuristic below can't help here (every legitimate request now
//     arrives from a public address), so it is switched off entirely and
//     replaced by HTTP Basic auth on everything. See authGate().
//
// The gate runs TWICE on a browser request, on purpose: once in Next's
// `proxy.ts` (the web front door) and again in the Bun API server
// (`server/index.ts`), which Next reaches through a rewrite that forwards the
// visitor's headers. Either layer alone is sufficient; the API server never
// relies on the web server having been the only way in. It is written against
// the web-standard `Request`/`Response` so both runtimes share one copy.
//
// In BOTH shapes `/share/<token>` is public: a share link has to work for
// whoever you send it to. The page it serves is a static, no-JavaScript,
// read-only HTML document with no /_next assets and no API access, so
// allowlisting exactly this path exposes exactly that one page. The token
// carries ~190 bits of entropy and revoking the share invalidates it.
//
// How tunnel traffic is recognized — by ADDRESS, not header presence: Next's
// own dev server stamps `X-Forwarded-For: ::1` on plain local requests, so
// "has a forwarding header" would misclassify everything. Instead we collect
// every IP in the forwarding headers and ask whether any of them is public.
// A tunnel daemon (cloudflared, ngrok) always records the visitor's real
// public address (cloudflared additionally sets Cf-Connecting-Ip/Cf-Ray);
// a remote visitor can prepend junk to X-Forwarded-For but cannot remove the
// real IP the daemon appends — so "some public IP in the chain" is
// spoof-proof in the direction that matters. Purely local traffic only ever
// shows loopback/private addresses. (LAN devices — private IPs — count as
// local: the app was always reachable on your LAN.) `Cf-Ray` presence is an
// extra fail-closed signal: no local browser sends it.
//
// Share-page hits are logged to the server terminal with the visitor's real
// IP — including denied probes — so shared-link traffic can be monitored.
// ============================================================================

/** The one path family that is public in both shapes (token charset = nanoid's). */
const SHARE_PATH = /^\/share\/[A-Za-z0-9_-]{1,64}\/?$/;

/** Loopback, RFC1918/4193, link-local, and IPv4-mapped forms thereof. */
function isPrivateIp(raw: string): boolean {
  let ip = raw.trim().toLowerCase();
  if (!ip) return true; // nothing to judge — don't let junk flip us to "tunnel"
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  // IPv6
  if (ip.includes(':')) {
    return (
      ip === '::1' ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') || // unique-local fc00::/7
      ip.startsWith('fe80') // link-local
    );
  }
  // IPv4
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts;
  return (
    a === 127 || // loopback
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) // link-local
  );
}

function pathnameOf(request: Request): string {
  return new URL(request.url).pathname;
}

/** All IPs the forwarding headers mention, in order. */
function forwardedIps(request: Request): string[] {
  const ips: string[] = [];
  const xff = request.headers.get('x-forwarded-for');
  if (xff) ips.push(...xff.split(','));
  for (const h of ['cf-connecting-ip', 'x-real-ip']) {
    const v = request.headers.get(h);
    if (v) ips.push(v);
  }
  return ips.map((ip) => ip.trim()).filter(Boolean);
}

/** Who is actually calling — the first public IP in the forwarding chain. */
function visitorIp(request: Request): string {
  const ips = forwardedIps(request);
  return ips.find((candidate) => !isPrivateIp(candidate)) ?? ips[0] ?? 'unknown';
}

function logVisit(tag: string, allowed: boolean, request: Request, ip: string, quiet: boolean): void {
  if (quiet) return;
  console.log(
    `[${tag}] ${allowed ? 'allow' : 'DENY '} ${request.method} ${pathnameOf(request)} from ${ip} ua="${
      request.headers.get('user-agent') ?? ''
    }"`,
  );
}

// ---------------------------------------------------------------------------
// Basic auth — the public-domain shape
// ---------------------------------------------------------------------------

interface Credentials {
  user: string;
  password: string;
}

/** Configured only when BOTH vars are non-empty. A half-set pair must not
 *  silently degrade an internet-facing deployment back to "no auth". */
function configuredCredentials(): Credentials | null {
  const user = process.env.HINDSIGHT_AUTH_USER;
  const password = process.env.HINDSIGHT_AUTH_PASSWORD;
  if (!user || !password) return null;
  return { user, password };
}

function decodeBasic(header: string | null): Credentials | null {
  if (!header) return null;
  const space = header.indexOf(' ');
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== 'basic') return null;
  let decoded: string;
  try {
    const binary = atob(header.slice(space + 1).trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes); // credentials are UTF-8 (RFC 7617)
  } catch {
    return null; // not valid base64
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** Constant-time compare. Hashing first makes the comparison fixed-width, so
 *  neither the content nor the LENGTH of the secret leaks through timing. */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function challenge(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      // charset=UTF-8 tells the browser how to encode non-ASCII credentials.
      'WWW-Authenticate': 'Basic realm="Hindsight", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

/** Public-domain shape: everything needs credentials except the share page. */
async function authGate(request: Request, expected: Credentials, quiet: boolean): Promise<Response | null> {
  if (SHARE_PATH.test(pathnameOf(request))) {
    logVisit('share', true, request, visitorIp(request), quiet);
    return null;
  }

  const offered = decodeBasic(request.headers.get('authorization'));
  if (!offered) return challenge(); // no header yet — every browser's first hit

  // Check both halves before combining: short-circuiting on the username would
  // reveal, by timing, whether the username alone was right.
  const [userOk, passwordOk] = await Promise.all([
    secretEquals(offered.user, expected.user),
    secretEquals(offered.password, expected.password),
  ]);
  if (userOk && passwordOk) return null;

  // Wrong credentials were actually presented — that's worth seeing in the log.
  logVisit('auth', false, request, visitorIp(request), quiet);
  return challenge();
}

/** Local shape: tunnel traffic sees the share page and nothing else. */
function tunnelGate(request: Request, quiet: boolean): Response | null {
  const ips = forwardedIps(request);
  const viaTunnel = request.headers.has('cf-ray') || ips.some((ip) => !isPrivateIp(ip));
  if (!viaTunnel) return null;

  const allowed = SHARE_PATH.test(pathnameOf(request));
  logVisit('share', allowed, request, visitorIp(request), quiet);

  if (!allowed) return new Response('Not found', { status: 404 });
  return null;
}

/**
 * Judge one request. Returns the refusal to send (404 for tunnel traffic off
 * the share page, 401 for missing/wrong credentials), or `null` to let the
 * request through. `quiet` suppresses the audit line — the API server passes
 * it so a visit already logged by the web front door isn't logged twice.
 */
export async function frontDoor(request: Request, options: { quiet?: boolean } = {}): Promise<Response | null> {
  const quiet = options.quiet === true;
  const expected = configuredCredentials();
  return expected ? authGate(request, expected, quiet) : tunnelGate(request, quiet);
}
