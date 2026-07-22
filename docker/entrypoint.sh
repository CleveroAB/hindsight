#!/usr/bin/env bash
# ============================================================================
# Hindsight agent container entrypoint.
# ----------------------------------------------------------------------------
# Invoked as: entrypoint.sh   (no args; everything comes via env + /work mount)
# Env:
#   HS_KIND   - initial | refine | rerun | refresh   (required; defaults below)
#   HS_MODEL  - codex model name (initial/refine only; defaults to gpt-5.6-sol)
#   HS_EFFORT - codex reasoning effort (initial/refine only; when set, passed
#               as `-c model_reasoning_effort=<value>`; else codex's default)
#   HS_PROMPT - the user's strategy prompt / refinement text (initial/refine)
#   HS_IMAGES - newline-separated /work/uploads/* paths for images the user
#               attached to this turn; each becomes a `codex exec -i <path>`
# Mounts:
#   /work          - the session's working dir (see PROTOCOL.md §1)
#   /codex-host:ro - the host's Codex home, read-only (credentials source)
# ============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Codex home. The host's ~/.codex is mounted READ-ONLY at /codex-host because
# (a) it holds the user's live state and must never be written to by this
# disposable container, and (b) it can be gigabytes (sessions, plugins, logs).
# But Codex *requires* a writable home (it errors with
# "failed to initialize in-process app-server client: Read-only file system"),
# so build a minimal, container-local one containing just the credentials.
# ---------------------------------------------------------------------------
export CODEX_HOME="${CODEX_HOME:-/root/.codex}"
mkdir -p "$CODEX_HOME"
if [ -f /codex-host/auth.json ]; then
  cp /codex-host/auth.json "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
fi

# Make sure /work exists (it should, as a bind mount) and has an AGENTS.md —
# Codex reads AGENTS.md from its working directory for instructions. On a
# session's very first run this seeds it from the image's copy; subsequent
# runs reuse whatever's already in /work (so a user could hand-edit it, though
# nothing here relies on that).
mkdir -p /work
if [ ! -f /work/AGENTS.md ]; then
  cp /app/AGENTS.md /work/AGENTS.md
fi

# The runner tails this file for progress (PROTOCOL.md §3); make sure it
# exists even if the agent crashes before writing anything, so the tail
# doesn't error on a missing file.
touch /work/events.ndjson

# Mirror all stdout/stderr into agent.log (debug only, per PROTOCOL.md §1)
# while still passing it through to the container's own stdout/stderr so
# `docker logs` keeps working.
exec > >(tee -a /work/agent.log) 2>&1

cd /work

case "${HS_KIND:-initial}" in
  rerun|refresh)
    # No LLM involved: params.json has already been rewritten by the run
    # manager (and data/ cleared for `refresh`); strategy.py is reused as-is.
    echo "[entrypoint] HS_KIND=${HS_KIND}: re-executing existing strategy.py (no LLM)"
    exec python /work/strategy.py
    ;;
  initial|refine|*)
    # Full agent run: let Codex write (or edit) strategy.py, fetch data, and
    # run the backtest, following /work/AGENTS.md. --dangerously-bypass-approvals-and-sandbox
    # is safe here because we're already inside a disposable, network-scoped
    # container with only /work mounted read-write.
    echo "[entrypoint] HS_KIND=${HS_KIND:-initial}: invoking codex"

    # Images the user attached to this turn -> `-i <path>` args. Built as an
    # array so paths stay single arguments, and each file is checked to exist:
    # codex exits non-zero on a missing -i path, which would fail the whole run
    # over a vanished upload rather than just losing the picture.
    image_args=()
    if [ -n "${HS_IMAGES:-}" ]; then
      while IFS= read -r img; do
        [ -z "$img" ] && continue
        if [ -f "$img" ]; then
          image_args+=(-i "$img")
          echo "[entrypoint] attaching image: $img"
        else
          echo "[entrypoint] WARNING: attached image not found, skipping: $img"
        fi
      done <<< "${HS_IMAGES}"
    fi

    # Reasoning effort -> `-c model_reasoning_effort=<value>`. Only when set:
    # the container's CODEX_HOME has no config.toml (only auth.json is copied),
    # so an unset HS_EFFORT means codex's own default.
    effort_args=()
    if [ -n "${HS_EFFORT:-}" ]; then
      effort_args+=(-c "model_reasoning_effort=${HS_EFFORT}")
      echo "[entrypoint] reasoning effort: ${HS_EFFORT}"
    fi

    # NOTE: `codex exec` takes exactly ONE positional (the prompt); the working
    # root is set with -C/--cd. Passing a trailing path here is an arg-parse
    # error (`unexpected argument '.'`, exit 2), so don't.
    # stdin is redirected from /dev/null: with a prompt argument present, Codex
    # otherwise waits on / appends piped stdin ("Reading additional input from
    # stdin...") which is never supplied in a detached container run.
    exec codex exec --dangerously-bypass-approvals-and-sandbox -C /work \
      -m "${HS_MODEL:-gpt-5.6-sol}" \
      ${effort_args[@]+"${effort_args[@]}"} \
      ${image_args[@]+"${image_args[@]}"} \
      "${HS_PROMPT:-}" < /dev/null
    ;;
esac
