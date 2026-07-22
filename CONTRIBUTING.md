# Contributing to Hindsight

Thanks for your interest! Issues and pull requests are welcome.

## Getting set up

```bash
bun install
bun run seed  # optional: three example strategies
bun run dev   # http://localhost:3000 — runs the mock agent, no Docker/keys needed
```

Requirements: **[Bun](https://bun.sh) 1.x** and **Node ≥ 20.9** (Next.js runs on Node). The mock agent (default) makes the
whole app usable offline, so most UI/API work needs nothing else. Only work on
the real agent path needs Docker + a Codex CLI login (see the README).

## Before you open a PR

```bash
bun run typecheck
bun run lint
bun run build
```

All three must pass. There is no test suite yet — if you're adding one, that's
a very welcome PR.

## Ground rules

- **PROTOCOL.md is the contract.** If your change alters an API route, an SSE
  frame, or the agent file protocol (`events.ndjson` / `result.json` /
  `params.json`), update PROTOCOL.md in the same PR.
- Keep the two agent backends in parity: a UI feature must work in `mock` mode,
  not just `codex` mode.
- Match the existing code style (the codebase is heavily commented at module
  level; follow that pattern rather than inline-commenting every line).
- For security issues, see [SECURITY.md](SECURITY.md) — please don't open a
  public issue.

## Scope

Hindsight is deliberately a **local, single-user** tool. PRs that add accounts,
multi-tenancy, or hosted-deployment scaffolding are out of scope for now.
