#!/bin/sh
# Start a disposable onboarding instance. This never reads or writes ~/.squire.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_HOME=$(mktemp -d "${TMPDIR:-/tmp}/squire-onboarding.XXXXXXXX")

cleanup() {
  rm -rf -- "$TEST_HOME"
}
trap cleanup EXIT

printf '{ "ports": { "web": 4396 } }\n' > "$TEST_HOME/settings.json"
printf '\nIsolated onboarding: http://127.0.0.1:4395/\n'
printf 'Temporary data: %s\n' "$TEST_HOME"
printf 'Stop with Ctrl+C; this test profile will then be deleted.\n\n'

cd "$ROOT"
pnpm run build-ui
SQUIRE_HOME="$TEST_HOME" \
SQUIRE_DEV_WEB_PORT=4395 \
SQUIRE_DEV_BACKEND=http://127.0.0.1:4396 \
pnpm exec concurrently --kill-others --success first --names server,web \
  'cargo run --manifest-path server/Cargo.toml -- --no-browser' \
  'wait-on tcp:127.0.0.1:4396 && pnpm --filter squire-web run dev'
