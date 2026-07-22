// ============================================================================
// Tunnel gate. Hindsight is a local-only app, but a strategy can be shared by
// exposing the server through a tunnel (`cloudflared tunnel --url
// http://localhost:3000`, or ngrok). This middleware makes that safe: for any
// request that arrived THROUGH a tunnel, only the read-only share page exists —
// every other path (the app, the whole API, /_next assets) 404s.
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
// Every tunnel request is logged to the dev-server terminal with the visitor's
// real IP, including denied probes, so shared-link traffic can be monitored.
//
// NOTE (Next version): `proxy.ts` / `proxy()` is the Next 16+ convention
// (Node.js runtime by default). On Next 14/15 this file was `middleware.ts`
// exporting `middleware()`.
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server';

/** The one path family tunnel visitors may reach (token charset = nanoid's). */
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

/** All IPs the forwarding headers mention, in order. */
function forwardedIps(request: NextRequest): string[] {
  const ips: string[] = [];
  const xff = request.headers.get('x-forwarded-for');
  if (xff) ips.push(...xff.split(','));
  for (const h of ['cf-connecting-ip', 'x-real-ip']) {
    const v = request.headers.get(h);
    if (v) ips.push(v);
  }
  return ips.map((ip) => ip.trim()).filter(Boolean);
}

export function proxy(request: NextRequest) {
  const ips = forwardedIps(request);
  const viaTunnel = request.headers.has('cf-ray') || ips.some((ip) => !isPrivateIp(ip));
  if (!viaTunnel) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const allowed = SHARE_PATH.test(pathname);
  const ip = ips.find((candidate) => !isPrivateIp(candidate)) ?? ips[0] ?? 'unknown';
  console.log(
    `[share] ${allowed ? 'allow' : 'DENY '} ${request.method} ${pathname} from ${ip} ua="${
      request.headers.get('user-agent') ?? ''
    }"`,
  );

  if (!allowed) return new NextResponse('Not found', { status: 404 });
  return NextResponse.next();
}
