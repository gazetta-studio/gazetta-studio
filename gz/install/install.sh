#!/bin/sh
# Installs gz from GitHub Releases (design-agent-access.md Q39).
#   curl -fsSL https://gazetta.studio/install/gz.sh | sh
# GZ_VERSION picks a version (default: latest); GZ_INSTALL_DIR the folder
# (default: ~/.local/bin). GZ_DOWNLOAD_BASE replaces the download URL (tests).
set -eu

repo="gazetta-studio/gazetta-studio"
dir="${GZ_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "gz: unsupported system $(uname -s); use install.ps1 on Windows" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "gz: unsupported processor $(uname -m)" >&2; exit 1 ;;
esac

version="${GZ_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$version" ] || { echo "gz: couldn't find the latest version" >&2; exit 1; }

archive="gz_${version}_${os}_${arch}.tar.gz"
base="${GZ_DOWNLOAD_BASE:-https://github.com/$repo/releases/download/v$version}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/$archive" "$base/$archive"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
expected=$(grep " $archive\$" "$tmp/checksums.txt" | cut -d ' ' -f 1)
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f 1)
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "gz: checksum mismatch for $archive" >&2; exit 1; }

tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$dir"
install -m 0755 "$tmp/gz" "$dir/gz"
install -m 0755 "$tmp/gazetta-cli" "$dir/gazetta-cli"
echo "Installed gz $version in $dir"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH to run gz." ;;
esac
