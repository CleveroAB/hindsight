#!/usr/bin/env bash
# ============================================================================
# Hindsight agent container entrypoint.
# ----------------------------------------------------------------------------
# Invoked as: entrypoint.sh   (no args; everything comes via env + /work mount)
# Env:
#   HS_KIND   - initial | refine | rerun | refresh | chat  (required; defaults below)
#               `chat` is one reply with no tools and no /work: the agent
#               answers HS_PROMPT under HS_SYSTEM on stdout (brainstorming an
#               idea before any strategy exists — lib/server/ideas)
#   HS_PROVIDER - which agent runs initial/refine: codex (default) | claude
#   HS_MODEL  - model name (initial/refine only; codex defaults to gpt-5.6-sol)
#   HS_EFFORT - reasoning effort (initial/refine only; when set, passed to
#               codex as `-c model_reasoning_effort=<value>` and to Claude Code
#               as `--effort <value>`; else the agent's own default)
#   HS_PROMPT - the user's strategy prompt / refinement text (initial/refine)
#   HS_IMAGES - newline-separated /work/uploads/* paths for images the user
#               attached to this turn; each becomes a `codex exec -i <path>`
# Mounts:
#   /work          - the session's working dir (see PROTOCOL.md §1)
#   /codex-host:ro - the host's Codex home, read-only (credentials source)
#   /claude-host/token:ro - Claude Code's credential (HS_PROVIDER=claude): a
#                    `claude setup-token` token, or an Anthropic API key
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
#
# The container may run as the host's own user (`docker run --user`, so the
# files it writes under /work stay that user's — see lib/server/agent/dockerUser).
# That user has no home in the image, so give it a writable one.
if [ -z "${HOME:-}" ] || [ ! -w "${HOME}" ]; then
  export HOME=/tmp/agent-home
  mkdir -p "$HOME"
fi
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME"
if [ -f /codex-host/auth.json ]; then
  cp /codex-host/auth.json "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
fi

# ---------------------------------------------------------------------------
# chat: one answer, no tools, nothing mounted but credentials. Handled before
# anything touches /work, which a chat does not have. Only the answer goes to
# stdout: Claude Code's JSON envelope, or Codex's last message.
# ---------------------------------------------------------------------------
if [ "${HS_KIND:-initial}" = "chat" ]; then
  scratch="$(mktemp -d)"
  cd "$scratch"
  if [ "${HS_PROVIDER:-codex}" = "claude" ]; then
    if [ ! -f /claude-host/token ]; then
      echo "no Claude credential mounted at /claude-host/token" >&2
      exit 1
    fi
    claude_token="$(tr -d '\r\n' < /claude-host/token)"
    case "$claude_token" in
      sk-ant-api*) export ANTHROPIC_API_KEY="$claude_token" ;;
      *) export CLAUDE_CODE_OAUTH_TOKEN="$claude_token" ;;
    esac
    exec claude -p "${HS_PROMPT:-}" \
      --model "${HS_MODEL:-sonnet}" \
      --effort "${HS_EFFORT:-low}" \
      --system-prompt "${HS_SYSTEM:-}" \
      --tools "" \
      --output-format json < /dev/null
  fi
  codex exec --skip-git-repo-check -s read-only \
    -m "${HS_MODEL:-gpt-5.6-sol}" \
    -c "model_reasoning_effort=${HS_EFFORT:-low}" \
    -o "$scratch/answer.txt" \
    -- "${HS_SYSTEM:-}"$'\n\n'"${HS_PROMPT:-}" < /dev/null > "$scratch/log.txt" 2>&1 \
    || { tail -c 2000 "$scratch/log.txt" >&2; exit 1; }
  exec cat "$scratch/answer.txt"
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
    if [ "${HS_PROVIDER:-codex}" = "claude" ]; then
      # ---- Claude Code ------------------------------------------------------
      echo "[entrypoint] HS_KIND=${HS_KIND:-initial}: invoking claude"

      # The credential is a file, never an env var on the docker command line
      # (which any local user could read from the process list).
      if [ -f /claude-host/token ]; then
        claude_token="$(tr -d '\r\n' < /claude-host/token)"
        case "$claude_token" in
          sk-ant-api*) export ANTHROPIC_API_KEY="$claude_token" ;;
          *) export CLAUDE_CODE_OAUTH_TOKEN="$claude_token" ;;
        esac
      else
        echo "[entrypoint] ERROR: no Claude credential mounted at /claude-host/token"
        exit 1
      fi

      # Claude Code reads its instructions from CLAUDE.md; they are the same
      # ones Codex reads from AGENTS.md, refreshed each run so both agree.
      cp -f /work/AGENTS.md /work/CLAUDE.md

      # Claude Code has no image flag: it opens files itself, so say where the
      # attached images are. Missing ones are skipped, as for Codex below.
      claude_prompt="${HS_PROMPT:-}"
      if [ -n "${HS_IMAGES:-}" ]; then
        listed=""
        while IFS= read -r img; do
          [ -z "$img" ] && continue
          if [ -f "$img" ]; then
            listed="${listed}"$'\n'"- ${img}"
            echo "[entrypoint] attaching image: $img"
          else
            echo "[entrypoint] WARNING: attached image not found, skipping: $img"
          fi
        done <<< "${HS_IMAGES}"
        if [ -n "$listed" ]; then
          claude_prompt="${claude_prompt}"$'\n\n'"The images attached to this turn are saved at these paths. Open each one with your Read tool before you start:${listed}"
        fi
      fi

      claude_effort=()
      if [ -n "${HS_EFFORT:-}" ]; then
        claude_effort+=(--effort "${HS_EFFORT}")
        echo "[entrypoint] reasoning effort: ${HS_EFFORT}"
      fi

      # IS_SANDBOX tells Claude Code that running as root with permission
      # checks off is deliberate: this is a disposable container with only
      # /work mounted read-write, the same footing Codex runs on below.
      export IS_SANDBOX=1
      exec claude -p "$claude_prompt" \
        --model "${HS_MODEL:-sonnet}" \
        ${claude_effort[@]+"${claude_effort[@]}"} \
        --dangerously-skip-permissions < /dev/null
    fi

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
    # root is set with -C/--cd. `-i/--image` accepts one or more values, so `--`
    # must end option parsing before the prompt. Without it, an attached image
    # makes the image option consume the prompt and Codex falls back to stdin.
    # stdin is redirected from /dev/null: with a prompt argument present, Codex
    # otherwise waits on / appends piped stdin ("Reading additional input from
    # stdin...") which is never supplied in a detached container run.
    exec codex exec --dangerously-bypass-approvals-and-sandbox -C /work \
      -m "${HS_MODEL:-gpt-5.6-sol}" \
      ${effort_args[@]+"${effort_args[@]}"} \
      ${image_args[@]+"${image_args[@]}"} \
      -- "${HS_PROMPT:-}" < /dev/null
    ;;
esac
