#!/bin/bash
# Smoke-tests the Android release inside Termux's own userland
# (termux/termux-docker): Android's C library, Termux's packages and paths.
#
#   termux-smoke.sh SQUIRE_BINARY SERVER_ASSETS_DIR
#
# Checks, in order: the binary loads; the Termux packages the installer
# offers install; the server starts, serves its UI and installs the
# first-run plugins over HTTPS (the patched certificate verifier); Termux's
# Chromium runs headless through Squire's own launch options; and procps
# sits where Squire looks for it.
set -euo pipefail

squire=$1
assets=$2

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n== %s\n' "$*"
}

step "binary loads on Android's C library"
"$squire" --version

step "Termux packages the installer offers"
# apt rather than pkg: pkg may stop to ask for a mirror.
apt-get update -q
apt-get install -yq x11-repo
apt-get update -q
apt-get install -yq nodejs chromium lsof procps curl

step "procps where Squire looks for it"
for tool in ps pgrep; do
  [ -x "$PREFIX/bin/$tool" ] || fail "$PREFIX/bin/$tool is missing"
done
"$PREFIX/bin/ps" -p $$ -o lstart= -o comm=
"$PREFIX/bin/pgrep" -P 1 >/dev/null || true

step "server starts and installs plugins over HTTPS"
export SQUIRE_HOME="$TMPDIR/squire-home"
log="$TMPDIR/squire.out"
"$squire" --no-browser >"$log" 2>&1 &
pid=$!
show_logs() {
  printf -- '--- terminal output\n'
  cat "$log" || true
  printf -- '--- squire.log\n'
  cat "$SQUIRE_HOME/logs/squire.log" 2>/dev/null || true
}
stop_server() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap 'stop_server' EXIT

deadline=$((SECONDS + 60))
until curl -fsS -o /dev/null http://127.0.0.1:4296/; do
  kill -0 "$pid" 2>/dev/null || { show_logs; fail "the server exited during startup"; }
  [ "$SECONDS" -lt "$deadline" ] || { show_logs; fail "the UI did not answer within 60 seconds"; }
  sleep 1
done
echo "UI answers on port 4296"

# First run installs the default plugins from the marketplace, which is
# reqwest over HTTPS: the request the upstream verifier panics on.
deadline=$((SECONDS + 300))
until [ -n "$(find "$SQUIRE_HOME/plugins" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)" ]; do
  kill -0 "$pid" 2>/dev/null || { show_logs; fail "the server exited while installing plugins"; }
  [ "$SECONDS" -lt "$deadline" ] || { show_logs; fail "no plugin installed within 5 minutes"; }
  sleep 2
done
ls "$SQUIRE_HOME/plugins"
if grep -q 'panicked' "$log" "$SQUIRE_HOME/logs/squire.log" 2>/dev/null; then
  show_logs
  fail "the server panicked"
fi
stop_server
trap - EXIT

step "Termux's Chromium through Squire's launch options"
chromium=$(command -v chromium-browser || command -v chromium) ||
  fail "Termux's chromium package installed no chromium-browser or chromium command"
case "$chromium" in
  "$PREFIX/bin/"*) echo "found $chromium" ;;
  *) fail "chromium is at $chromium, outside $PREFIX/bin where Squire looks" ;;
esac
work=$(mktemp -d)
mkdir -p "$work/node_modules"
tar -xzf "$assets/playwright-core.tgz" -C "$work/node_modules"
mv "$work/node_modules/package" "$work/node_modules/playwright-core"
cp "$assets/browser-platform.cjs" "$assets/browser-launch.cjs" "$work/"
cat >"$work/probe.cjs" <<'EOF'
"use strict";
const reported = process.platform;
const { termuxPrefix } = require("./browser-platform.cjs");
const { launchOptions } = require("./browser-launch.cjs");
const { chromium } = require("playwright-core");
if (reported !== "android") throw new Error(`Termux Node.js reported ${reported}, not android`);
if (!termuxPrefix) throw new Error("browser-platform.cjs did not detect Termux");
const options = launchOptions(
  { launchStrategy: "executable-path", canonicalPath: process.argv[2] },
  true,
  { width: 800, height: 600 },
  require("node:path").join(require("node:os").tmpdir(), "squire-smoke-downloads"),
);
(async () => {
  const browser = await chromium.launch(options);
  const page = await browser.newPage();
  await page.goto("data:text/html,<title>Squire Probe</title><button>Ready</button>");
  const title = await page.title();
  const snapshot = await page.locator("body").ariaSnapshot();
  await browser.close();
  if (title !== "Squire Probe") throw new Error(`unexpected title ${title}`);
  console.log(`launched ${process.argv[2]}: title=${title} snapshot=${JSON.stringify(snapshot)}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF
(cd "$work" && node probe.cjs "$chromium")

step "all Termux checks passed"
