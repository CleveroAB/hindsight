# ============================================================================
# Hindsight agent image
# ----------------------------------------------------------------------------
# This image is spawned once per run by the CodexRunner (agent layer) as:
#   docker run --rm --name <n> -e HS_KIND=<initial|refine|rerun|refresh> \
#     [-e HS_MODEL -e HS_PROMPT] -v <hostWorkDir>:/work -v <codexHome>:/codex-host:ro \
#     hindsight-agent:latest
#
# The host Codex home is mounted read-only at /codex-host; the entrypoint copies
# just auth.json into a writable container-local CODEX_HOME (Codex refuses to
# start when its home is read-only).
#
# For `initial`/`refine` the entrypoint runs the Codex CLI against /work (which
# Codex reads AGENTS.md from). For `rerun`/`refresh` it just re-executes the
# previously-generated /work/strategy.py — no LLM involved, no network needed
# for the CLI itself (the strategy script may still hit the network for data).
# ============================================================================

FROM python:3.12-slim

# ---------------------------------------------------------------------------
# OS packages: ca-certificates/curl/git are needed to install & run the Codex
# CLI and for git-based tooling the agent might invoke; Node.js 20 is required
# to run the Codex CLI (an npm package).
# ---------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Codex CLI. NOTE: pin this to match the host's codex-cli version (0.144.6 at
# the time this image was authored) if the host and container drift — the
# on-disk auth/session format under ~/.codex must stay compatible.
# ---------------------------------------------------------------------------
RUN npm install -g @openai/codex@0.144.6

# ---------------------------------------------------------------------------
# Python deps for backtests: data fetch (yfinance/pandas-datareader/requests +
# scraping via bs4/lxml), date handling, and the numeric stack. No pip cache
# kept, to keep the image lean.
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
        pandas \
        numpy \
        yfinance \
        pandas-datareader \
        requests \
        beautifulsoup4 \
        lxml \
        python-dateutil

# ---------------------------------------------------------------------------
# Agent instructions + entrypoint. AGENTS.md is copied to /app and re-copied
# into /work on first run (a session may reuse/persist its own copy across
# refine runs); entrypoint.sh dispatches on HS_KIND.
# ---------------------------------------------------------------------------
RUN mkdir -p /app
COPY AGENTS.md /app/AGENTS.md
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# /work is the mounted per-session host directory (see PROTOCOL.md §1).
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
