#!/bin/sh
# Package a Squire release asset for a given Rust target triple.
# Expects the web UI to be built already (`pnpm run build-web`) and the
# release binary to exist. Produces:
#   dist/squire-<target>.tar.gz (+ .sha256), or .zip for Windows targets
# The archive contains a single executable named `squire` (`squire.exe` on
# Windows).
set -eu

if [ "$#" -gt 0 ]; then
  target="$1"
else
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os_part="apple-darwin" ;;
    Linux) os_part="unknown-linux-gnu" ;;
    MINGW*|MSYS*|CYGWIN*) os_part="pc-windows-msvc" ;;
    *) echo "error: unsupported OS: $os (pass target triple explicitly)" >&2; exit 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) arch_part="aarch64" ;;
    x86_64|amd64) arch_part="x86_64" ;;
    *) echo "error: unsupported architecture: $arch (pass target triple explicitly)" >&2; exit 1 ;;
  esac
  target="$arch_part-$os_part"
fi
repo_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
out_dir="$repo_root/dist"
staging="$(mktemp -d)"

trap 'rm -rf "$staging"' EXIT

case "$target" in
  *-windows-*) exe=".exe" ;;
  *) exe="" ;;
esac

candidate_native="$repo_root/server/target/release/squire-server$exe"
candidate_target="$repo_root/server/target/$target/release/squire-server$exe"

if [ -x "$candidate_target" ]; then
  binary="$candidate_target"
elif [ -x "$candidate_native" ]; then
  binary="$candidate_native"
else
  echo "error: release binary not found." >&2
  echo "looked in:" >&2
  echo "  $candidate_target" >&2
  echo "  $candidate_native" >&2
  echo "build it first: pnpm run build-web && cargo build --release --manifest-path server/Cargo.toml --target $target" >&2
  exit 1
fi

# Ship the binary as `squire` regardless of the cargo package name.
cp "$binary" "$staging/squire$exe"
chmod 755 "$staging/squire$exe"
if [ -f "$repo_root/README.md" ]; then
  cp "$repo_root/README.md" "$staging/README.md"
fi

mkdir -p "$out_dir"
case "$target" in
  *-windows-*)
    # Windows users expect a zip. 7-Zip ships on GitHub's Windows runners.
    if ! command -v 7z >/dev/null 2>&1; then
      echo "error: 7z is required to package a Windows release" >&2
      exit 1
    fi
    asset="$out_dir/squire-$target.zip"
    rm -f "$asset"
    (cd "$staging" && 7z a -tzip -bso0 -bsp0 "$asset" "squire$exe" README.md)
    ;;
  *)
    asset="$out_dir/squire-$target.tar.gz"
    tar -czf "$asset" -C "$staging" squire README.md
    ;;
esac

# Checksums (macOS shasum, Linux sha256sum).
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$out_dir" && sha256sum "$(basename "$asset")" > "$(basename "$asset").sha256")
else
  (cd "$out_dir" && shasum -a 256 "$(basename "$asset")" > "$(basename "$asset").sha256")
fi

echo "wrote $asset"
cat "$asset.sha256"
