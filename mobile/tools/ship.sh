#!/usr/bin/env bash
# Build the iPhone app in the cloud and publish an install link.
#
#   API_BASE_URL=https://<machine>.<tailnet>.ts.net:8443 tools/ship.sh
#   BUILD_ONLY=1 …   stop after the IPA is built      FRESH=1 …   don't reuse the last build
#
# 1. exact build (https://exact.appdrop.app) compiles the app into an IPA: no Mac needed.
#    It needs a build token in ~/.exact-build-token (an Expo device login; see
#    https://exact.appdrop.app/agents.md, step 0).
# 2. AppDrop (https://appdrop.app) signs the IPA and prints a link; open it on the iPhone.
#
# API_BASE_URL is the Hindsight API server's address as the phone reaches it. It is written
# into the build (app.json's `env`), never into this repo: with none, app.ts talks to the
# local mock harness, which is what the tests want. The address is public in the build, so
# it must not be a secret; access is the tailnet's.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${API_BASE_URL:?Set API_BASE_URL to the address of the API server, e.g. https://machine.tailnet.ts.net:8443}"
SERVICE=https://exact.appdrop.app
TOKEN_FILE="$HOME/.exact-build-token"
[ -s "$TOKEN_FILE" ] || { echo "No build token at $TOKEN_FILE. See $SERVICE/agents.md, step 0." >&2; exit 1; }
EXACT_DIR=${EXACT:-../../exact}
COMMIT=$(git -C "$EXACT_DIR" rev-parse HEAD)
mkdir -p .exact
LAST=.exact/exact-build-id
auth() { curl -sS -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$@"; }
field() { python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read(), strict=False).get(sys.argv[1], ""))' "$1"; }

# The upload: the app's sources plus the address, without local state or the test harness.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/app"
tar cf - --exclude=./node_modules --exclude=./.exact --exclude=./target --exclude=./.env.local --exclude=./dist \
  --exclude=./tools --exclude=./server.ts . | tar xf - -C "$stage/app"
printf 'API_BASE_URL=%s\n' "$API_BASE_URL" > "$stage/app/.env"
tar czf "$stage/app.tar.gz" -C "$stage/app" .

# A rebuild on the last successful build skips native compilation when only the app changed.
query="exact=$COMMIT"
if [ -s "$LAST" ] && [ "${FRESH:-}" != 1 ]; then query="$query&base=$(cat "$LAST")"; fi
echo "Building for $API_BASE_URL (Exact $COMMIT)…" >&2
started=$(auth -X POST "$SERVICE/build?$query" -H 'Content-Type: application/gzip' --data-binary "@$stage/app.tar.gz")
id=$(printf '%s' "$started" | field id)
[ -n "$id" ] || { echo "The build was not accepted: $started" >&2; exit 1; }

while :; do
  status_json=$(auth "$SERVICE/$id/")
  status=$(printf '%s' "$status_json" | field status)
  case "$status" in succeeded | failed) break ;; esac
  sleep 3
done
if [ "$status" != succeeded ]; then
  echo "The build failed:" >&2
  printf '%s' "$status_json" | field error | tail -c 6000 >&2
  exit 1
fi
printf '%s' "$id" > "$LAST"
auth -o .exact/Hindsight.ipa "$SERVICE/$id.ipa"
echo "Built .exact/Hindsight.ipa ($(du -h .exact/Hindsight.ipa | cut -f1))." >&2
[ "${BUILD_ONLY:-}" = 1 ] && exit 0

# The first publish makes the link; later ones publish a new version to the same link
# (its key is kept by AppDrop in ~/.appdrop), and an installed copy is offered the update.
LINK=.exact/appdrop-link
if [ -s "$LINK" ]; then
  # exact build stamps every IPA as build 1, so an update reuses the published build number;
  # --force tells AppDrop that is intended.
  bun x appdrop .exact/Hindsight.ipa --update "$(cat "$LINK")" --force
else
  bun x appdrop .exact/Hindsight.ipa | tee "$stage/appdrop.out"
  grep -o 'https://appdrop\.app/d/[A-Za-z0-9_-]*' "$stage/appdrop.out" | tail -1 > "$LINK" || true
fi
[ -s "$LINK" ] && echo "Install link: $(cat "$LINK")" >&2
