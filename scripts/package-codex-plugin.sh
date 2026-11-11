#!/bin/sh
# Packages the Squire plugin in codex/ as a distributable zip.
#
# Usage:
#   scripts/package-codex-plugin.sh [--mcp-url URL]
#
# The plugin connects to Squire's hosted Remote Access endpoint,
# https://use-squire.com/mcp, which is the same for every account and computer.
# The URL is injected at package time only so a build can target a local site
# Worker during development. The archive is written to the shared dist folder (default:
# <repo>/dist, override with CODEX_DIST_DIR) as
# squire-codex-plugin-<version>.zip (+ .sha256). The archive root is the single
# plugin folder, which is what the ChatGPT plugin upload expects:
#
#   squire/plugin.json
#   squire/.codex-plugin/plugin.json
#   squire/mcp.json
#   squire/.mcp.json
#   squire/assets/...
set -eu

usage() {
  cat >&2 <<'EOF'
usage: scripts/package-codex-plugin.sh [--mcp-url URL]

  --mcp-url URL   MCP endpoint baked into the package. Defaults to
                  SQUIRE_MCP_URL, then https://use-squire.com/mcp. Override
                  only to test against a local site Worker, for example
                  http://localhost:5888/mcp
  -h, --help      Show this help
EOF
}

mcp_url="${SQUIRE_MCP_URL:-https://use-squire.com/mcp}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mcp-url)
      if [ "$#" -lt 2 ]; then
        echo "error: --mcp-url needs a value" >&2
        usage
        exit 2
      fi
      mcp_url="$2"
      shift 2
      ;;
    --mcp-url=*)
      mcp_url="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      # pnpm forwards a literal `--` separator; ignore it.
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$mcp_url" in
  https://*|http://*) ;;
  *)
    echo "error: --mcp-url must start with http:// or https:// (got: $mcp_url)" >&2
    exit 2
    ;;
esac

# Normalize one trailing slash so the baked URL is stable.
mcp_url="${mcp_url%/}"

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
src="$repo_root/codex"
dist="${CODEX_DIST_DIR:-$repo_root/dist}"
manifest="$src/plugins/squire/plugin.json"

if [ ! -f "$manifest" ]; then
  echo "error: missing plugin manifest: $manifest" >&2
  exit 1
fi

version="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$manifest")"
asset_name="squire-codex-plugin-$version.zip"

# Package the plugin with its stable folder name as the archive root.
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$src/plugins/squire" "$staging/squire"
find "$staging" -name '.DS_Store' -delete

# Fill the placeholder and fail loudly if anything survives un-rendered.
python3 - "$staging" "$mcp_url" <<'PY'
import os
import sys

root, url = sys.argv[1], sys.argv[2]
placeholder = "{{MCP_URL}}"
unrendered = []

for dirpath, _dirnames, filenames in os.walk(root):
    for name in filenames:
        path = os.path.join(dirpath, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, IsADirectoryError):
            continue
        if placeholder not in text:
            continue
        text = text.replace(placeholder, url)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        if placeholder in text:
            unrendered.append(os.path.relpath(path, root))

if unrendered:
    sys.exit("error: unrendered placeholders: " + ", ".join(sorted(unrendered)))
PY

mkdir -p "$dist"
rm -f "$dist/$asset_name" "$dist/$asset_name.sha256"
(cd "$staging" && zip -qr "$dist/$asset_name" squire)

# Checksums (macOS shasum, Linux sha256sum).
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dist" && sha256sum "$asset_name" > "$asset_name.sha256")
else
  (cd "$dist" && shasum -a 256 "$asset_name" > "$asset_name.sha256")
fi

echo "wrote $dist/$asset_name"
echo "mcp url: $mcp_url"
cat "$dist/$asset_name.sha256"
