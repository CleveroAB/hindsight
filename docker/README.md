# Hindsight agent image

This image is the sandbox the Codex-backed `AgentRunner` (agent layer) spawns
per run to write and execute real backtests. It bundles Python + the data
stack (pandas/numpy/yfinance/pandas-datareader/requests/bs4/lxml), the Codex
CLI, and `AGENTS.md` — the instructions the in-container Codex agent follows
(file protocol, realism rules, result shape). See `../PROTOCOL.md` for the
full contract and `AGENTS.md` in this directory for the agent-facing spec.

## Prerequisites

- Docker daemon running locally.
- Codex CLI auth available on the host at `~/.codex`. The runner mounts it
  **read-only at `/codex-host`**, and the entrypoint copies just `auth.json`
  into a writable, container-local `CODEX_HOME` (`/root/.codex`). So `codex exec`
  reuses your host login with no separate auth step, while your real Codex home
  — which holds live state and is often gigabytes (sessions, plugins, logs) —
  is never written to by the container.

  > Codex refuses to start if its home is read-only
  > (`failed to initialize in-process app-server client: Read-only file system`),
  > which is why the copy-to-writable-home step exists.

## Build

```sh
bun run docker:build
# equivalent to:
docker build -t hindsight-agent:latest ./docker
```

Re-run this whenever `docker/Dockerfile`, `docker/entrypoint.sh`, or
`docker/AGENTS.md` changes. The image is tagged `hindsight-agent:latest`; the
runner expects that exact tag.

## How the runner invokes it

For every run (`initial`, `refine`, `rerun`, `refresh`) the agent layer's
`CodexRunner` does the rough equivalent of:

```sh
docker run --rm --name hindsight-<sessionId>-<runId> \
  -e HS_KIND=<initial|refine|rerun|refresh> \
  -e HS_MODEL=<codex model, e.g. gpt-5.6-sol>   \  # initial/refine only
  -e HS_EFFORT=<reasoning effort, e.g. medium>  \  # initial/refine only
  -e HS_PROMPT="<the user's prompt or refinement text>" \  # initial/refine only
  -e HS_IMAGES="<newline-separated /work/uploads/* paths>" \  # only when images are attached
  -v <hostWorkDir>:/work \
  -v ~/.codex:/codex-host:ro \
  hindsight-agent:latest
```

`<hostWorkDir>` is the session's persistent working directory on the host
(`${HINDSIGHT_DATA_DIR}/work/<id>/`, per `PROTOCOL.md` §1) — it's where
`params.json`, `strategy.py`, `data/`, `events.ndjson`, `result.json`, and
`agent.log` all live, and it survives across runs for that session.

- `initial` / `refine`: `entrypoint.sh` runs `codex exec` in `/work`, which
  reads `AGENTS.md` from there (seeded from `/app/AGENTS.md` on first run)
  and follows the file protocol to write `strategy.py`, fetch data, run the
  backtest, and produce `result.json`.
- `rerun` / `refresh`: no LLM call at all — `entrypoint.sh` just executes the
  existing `/work/strategy.py` directly (the run manager has already
  rewritten `params.json`, and for `refresh` cleared `data/`, before the
  container starts).

The runner tails `/work/events.ndjson` as the container runs and treats a
non-zero exit code, or a missing/invalid `result.json`, as a failed run.

## Interrupting a run

The runner hard-kills an in-flight run via `docker kill` on the container
name it chose at `docker run` time; `entrypoint.sh` propagates whatever exit
code the underlying process (`codex exec` or `python strategy.py`) produced
in the non-interrupted case.
