# Security

## Threat model (read this before deploying)

Hindsight is a **local, single-user app that ships with authentication off**.
The API can create sessions, run agent containers, read local files under its
data dir, and start tunnels. By default the security model assumes only you can
reach it:

- **Never bind it to a public interface or put it on a VPS as-is.** Anyone who
  can reach port 3000 has full control of the app (and, in codex mode, can make
  it spend your API credits and run containers on your machine).
- Devices on your LAN can reach a dev server bound to `0.0.0.0`. If that's not
  what you want, keep it on `localhost` (Next's default is fine).

### Putting it on a public domain

Set **both** `HINDSIGHT_AUTH_USER` and `HINDSIGHT_AUTH_PASSWORD`. `proxy.ts`
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

## What the app does to stay safe

- **Share links** are the one thing deliberately exposed to the public, in both
  deployment shapes. The Share button starts a `cloudflared` quick tunnel, and
  `proxy.ts` gates every request that arrives through a tunnel: only
  `GET /share/<token>` (a static, no-JS, read-only HTML page) is reachable — the
  app, the API, and all assets return 404. Tokens carry ~190 bits of entropy;
  revoking a share invalidates its token immediately.
- **Real backtests run inside a disposable Docker container.** The container is
  the sandbox: only the per-session workdir is mounted read-write, your
  `~/.codex` is mounted read-only (just `auth.json` is copied in), and the
  container is removed after the run.
- Uploaded images are validated by magic bytes, renamed to server-generated
  names, and size-capped; user input never forms a filesystem path or a shell
  command (all processes are spawned with argv arrays, no shell).

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories)
on this repository ("Report a vulnerability"), or email carl@clevero.se.
You should get a response within a few days. Please don't open public issues
for security problems.
