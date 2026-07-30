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
bun run test
bun run build
```

All four must pass. There is no CI — running them locally is the check.

## Tests

`bun test` — Bun's runner is built in, so there are no extra dependencies. Specs
live in `tests/`, one file per module, and take ~15s end to end; most of that is
`mockRunner.test.ts`, which drives a real mock run rather than faking timers.

```bash
bun test                      # everything
bun test tests/proxy.test.ts  # one file
bun test --watch              # while working
```

Two areas are worth extra care when you touch them:

- **`tests/proxy.test.ts`** — the tunnel gate. This is the only thing keeping a
  share link from exposing the whole app and API (see [SECURITY.md](SECURITY.md)).
  Add a case for every new path or header you teach it about.
- **`tests/agentEvents.test.ts` and `tests/resultNormalize.test.ts`** — the
  agent-output contract, PROTOCOL.md §3/§4. The agent is an LLM writing to a
  file, so a parser change wants a malformed-input case next to the happy path.

Tests that touch disk must call `withTempDataDir()` from `tests/helpers.ts`,
which points `HINDSIGHT_DATA_DIR` at a throwaway directory — never write to the
real `./data`.

Not covered yet, and welcome: the API route handlers, the run manager's
lifecycle and SSE fan-out, and the React components.

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
