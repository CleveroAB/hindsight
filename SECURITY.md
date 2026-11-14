# Security

## Threat model (read this before deploying)

Hindsight is a **local, single-user app that ships with authentication off**.
The API can create sessions, run agent containers, read local files under its
data dir, and start tunnels. By default the security model assumes only you can
reach it:

- **Never bind it to a public interface or put it on a VPS as-is.** Anyone who
  can reach port 3000 (the web UI) or 8787 (the API server, bound to
  `127.0.0.1` by default) has full control of the app (and, in codex mode, can
  make it spend your API credits and run containers on your machine).
- Devices on your LAN can reach a dev server bound to `0.0.0.0`. If that's not
  what you want, keep it on `localhost` (Next's default is fine).

### Putting it on a public domain

Set **both** `HINDSIGHT_AUTH_USER` and `HINDSIGHT_AUTH_PASSWORD`. The front-door
gate (`lib/gate.ts`, run by `proxy.ts` and again by the API server)
then challenges every path with HTTP Basic auth — the app, the whole API, and
all assets — leaving only `/share/<token>` public so share links keep working.
Setting only one of the two leaves auth off, by design: a half-finished config
fails loudly (no access at all is never the failure mode) rather than quietly
serving an open app. What this does *not* give you:

- It's **one shared credential**, not per-user identity, and there is no lockout
  or rate limit on failed attempts. Use a long random password. For anything
  stronger, front it with Cloudflare Access, Tailscale, or an OIDC proxy —
  Basic auth composes fine underneath any of them.
- Basic credentials travel on **every** request, so terminate TLS in front of it.
- Auth controls *access*, not *spend*. An authenticated user can start unbounded
  concurrent runs (runs are tracked per session), and runs have no wall-clock
  cap. Watch your Codex usage.

### The iPhone app

The phone reaches the API server through a **second listener**
(`HINDSIGHT_TAILNET_PORT`, off unless set) meant to sit behind
`tailscale serve`: HTTPS with the machine's `*.ts.net` certificate, reachable
only from devices signed in to your tailnet. The listener refuses any request
without the `Tailscale-User-Login` header `tailscale serve` adds, so it is not
an open port for other local proxies, and Tailscale **Funnel** traffic (which
carries no identity) is refused. `HINDSIGHT_TAILNET_USERS` limits it to named
logins on a shared tailnet. Don't put anything other than `tailscale serve` in
front of that port: the identity header is only as trustworthy as the proxy
that sets it. The app stores no credential, and its build embeds only the
server's tailnet address.

## What the app does to stay safe

- **Share links** are the one thing deliberately exposed to the public, in both
  deployment shapes. The Share button starts a `cloudflared` quick tunnel, and
  the front-door gate checks every request that arrives through a tunnel — in
  `proxy.ts` and again in the API server: only
  `GET /share/<token>` (a static, no-JS, read-only HTML page) is reachable — the
  app, the API, and all assets return 404. Tokens carry ~190 bits of entropy;
  revoking a share invalidates its token immediately.
- **Real backtests run inside a disposable Docker container.** The container is
  the sandbox: only the per-session workdir is mounted read-write, your
  `~/.codex` is mounted read-only (just `auth.json` is copied in), and the
  container is removed after the run.
- **Other websites can't call the API from your browser.** The API server sends
  no CORS headers and answers no preflight unless an origin is named in
  `HINDSIGHT_CORS_ORIGINS`.
- Uploaded images are validated by magic bytes, renamed to server-generated
  names, and size-capped; user input never forms a filesystem path or a shell
  command (all processes are spawned with argv arrays, no shell).

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories)
on this repository ("Report a vulnerability"), or email carl@clevero.se.
You should get a response within a few days. Please don't open public issues
for security problems.
