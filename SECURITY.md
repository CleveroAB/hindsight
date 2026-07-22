# Security

## Threat model (read this before deploying)

Hindsight is a **local, single-user app with no authentication**. The API can
create sessions, run agent containers, read local files under its data dir, and
start tunnels. The security model assumes only you can reach it:

- **Never bind it to a public interface or put it on a VPS as-is.** Anyone who
  can reach port 3000 has full control of the app (and, in codex mode, can make
  it spend your API credits and run containers on your machine).
- Devices on your LAN can reach a dev server bound to `0.0.0.0`. If that's not
  what you want, keep it on `localhost` (Next's default is fine).

## What the app does to stay safe

- **Share links** are the one supported way to expose anything publicly. The
  Share button starts a `cloudflared` quick tunnel, and `proxy.ts` gates every
  request that arrives through a tunnel: only `GET /share/<token>` (a static,
  no-JS, read-only HTML page) is reachable — the app, the API, and all assets
  return 404. Tokens carry ~190 bits of entropy; revoking a share invalidates
  its token immediately.
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
