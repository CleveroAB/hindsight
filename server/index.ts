// ============================================================================
// The Hindsight API server — one small Bun process that owns ALL server state:
// the session store, the run manager (live agent runs + SSE fan-out), the
// share tunnel and the signal scheduler. Every client talks to it:
//
//   web app   Next.js serves only the React UI and forwards `/api/*` and
//             `/share/*` here (a rewrite in next.config.mjs).
//   iOS app   `mobile/` (Exact) calls the same routes, plus the compact
//             `/api/mobile/*` views, over the tailnet listener below.
//
// Two listeners, one route table:
//
//   local     HINDSIGHT_API_HOST:HINDSIGHT_API_PORT (default 127.0.0.1:8787).
//             Guarded by the front-door gate (lib/gate.ts) — the same policy
//             Next applies, re-checked here so this server never depends on
//             the web server having been the only way in.
//
//   tailnet   127.0.0.1:HINDSIGHT_TAILNET_PORT — started only when that var
//             is set, and meant to sit behind `tailscale serve`, which
//             terminates HTTPS for tailnet devices only and stamps each
//             request with the caller's `Tailscale-User-Login`. Requests
//             without that header are refused, so the listener is useless to
//             anything but a signed-in tailnet device (Funnel traffic carries
//             no identity headers and is refused too). The header is trusted
//             ONLY here, because `tailscale serve` is the only thing in front
//             of this port; the local listener ignores it.
//
// Run it with `bun run api` (or `bun run dev`, which also starts Next).
// ============================================================================

import { frontDoor } from '@/lib/gate';
import { getSignalScheduler } from '@/lib/server/signals/scheduler';
import { ROUTES, type Handler } from './router';

type Guard = (request: Request) => Promise<Response | null> | Response | null;

const json = (body: unknown, status: number): Response => Response.json(body, { status });

/** Local listener: the shared front-door policy; the web server already logged the visit. */
const localGuard: Guard = (request) => frontDoor(request, { quiet: true });

/** Tailnet listener: a signed-in tailnet user, optionally from an allowlist. */
function tailnetGuard(allowed: string[]): Guard {
  return (request) => {
    const login = request.headers.get('tailscale-user-login')?.trim().toLowerCase();
    if (!login) return json({ error: 'This address is only reachable from your tailnet.' }, 401);
    if (allowed.length > 0 && !allowed.includes(login)) {
      console.log(`[tailnet] DENY  ${request.method} ${new URL(request.url).pathname} from ${login}`);
      return json({ error: 'This tailnet user may not use Hindsight.' }, 403);
    }
    return null;
  };
}

/**
 * Cross-origin browsers are refused by default (no CORS headers at all): the
 * API is unauthenticated on localhost, so a web page you merely visit must not
 * be able to call it. HINDSIGHT_CORS_ORIGINS (comma-separated) opts specific
 * origins in; the word `loopback` admits any page served from this machine
 * (http://127.0.0.1:<port> or http://localhost:<port>) — the phone app's
 * mock-agent harness sets it, since the Exact web host picks its own port.
 */
const corsOrigins = (process.env.HINDSIGHT_CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const corsLoopback = corsOrigins.includes('loopback');
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function corsHeaders(request: Request): Record<string, string> | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (!corsOrigins.includes(origin) && !(corsLoopback && LOOPBACK_ORIGIN.test(origin))) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
    Vary: 'Origin',
  };
}

type BunRequest = Request & { params: Record<string, string> };
type MethodTable = Record<string, (request: BunRequest) => Promise<Response>>;

/** Bun's native route table, every handler behind `guard`. */
function routesFor(guard: Guard): Record<string, MethodTable> {
  const wrap = (handler: Handler) => async (request: BunRequest): Promise<Response> => {
    const refusal = await guard(request);
    if (refusal) return refusal;
    let response: Response;
    try {
      response = await handler(request, { params: Promise.resolve(request.params) });
    } catch (err) {
      console.error(`[api] ${request.method} ${new URL(request.url).pathname} failed:`, err);
      response = json({ error: 'The server had a problem. Try again.' }, 500);
    }
    const cors = corsHeaders(request);
    if (cors) for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  };

  const table: Record<string, MethodTable> = {};
  for (const [path, methods] of Object.entries(ROUTES)) {
    const entry: MethodTable = {};
    for (const [method, handler] of Object.entries(methods)) entry[method] = wrap(handler);
    // A preflight is answered only for an opted-in origin; otherwise it 404s
    // like any unknown route and the browser blocks the real request.
    entry.OPTIONS = async (request) => {
      const cors = corsHeaders(request);
      return cors ? new Response(null, { status: 204, headers: cors }) : json({ error: 'Not found' }, 404);
    };
    table[path] = entry;
  }
  return table;
}

function listen(hostname: string, port: number, guard: Guard) {
  return Bun.serve({
    hostname,
    port,
    // SSE streams idle between heartbeats and a manual signal check can run
    // for minutes; neither should be cut off by an idle timer.
    idleTimeout: 0,
    routes: routesFor(guard),
    fetch: () => json({ error: 'Not found' }, 404),
  });
}

const host = process.env.HINDSIGHT_API_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.HINDSIGHT_API_PORT || process.env.PORT || 8787);
const local = listen(host, port, localGuard);
console.log(`[api] listening on http://${local.hostname}:${local.port}`);

const tailnetPort = Number(process.env.HINDSIGHT_TAILNET_PORT || 0);
if (tailnetPort > 0) {
  const allowed = (process.env.HINDSIGHT_TAILNET_USERS ?? '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  const tailnet = listen('127.0.0.1', tailnetPort, tailnetGuard(allowed));
  console.log(
    `[api] tailnet listener on http://127.0.0.1:${tailnet.port} ` +
      `(put \`tailscale serve\` in front; ${allowed.length ? `users: ${allowed.join(', ')}` : 'any tailnet user'})`,
  );
}

// Activated strategies keep their scheduled checks from the moment the server
// is up, without waiting for a route to be touched.
// A promise nobody awaited must not take the server down with it (Bun exits
// on an unhandled rejection): log it and keep serving, as the Next.js server
// this replaced did.
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection:', reason);
});

getSignalScheduler().init();
