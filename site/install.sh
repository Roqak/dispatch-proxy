#!/bin/sh
# Dispatch installer for macOS and Linux.
#   curl -fsSL https://<site>/install.sh | sh
# macOS: installs Dispatch.app into /Applications (or ~/Applications).
# Linux: installs the AppImage to ~/.local/bin/dispatch plus a desktop entry.
set -eu

REPO="Roqak/dispatch"
API="https://api.github.com/repos/$REPO/releases?per_page=10"

say() { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

case "$(uname -s)" in
  Darwin) OS=mac;   PATTERN='_universal\.app\.tar\.gz$' ;;
  Linux)  OS=linux; PATTERN='_amd64\.AppImage$'
          [ "$(uname -m)" = "x86_64" ] || die "Linux builds are x86_64 only (found $(uname -m))" ;;
  *) die "unsupported OS: $(uname -s). On Windows, use install.ps1" ;;
esac

# Releases come newest first; take the first asset that matches this platform,
# so a release missing a platform's build falls back to the previous one.
say "Finding the latest Dispatch release for $OS"
URL=$(curl -fsSL -H "Accept: application/vnd.github+json" "$API" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | sed 's/.*"\(https[^"]*\)"/\1/' \
  | grep -E "$PATTERN" | head -n 1) || true
[ -n "${URL:-}" ] || die "no $OS build found in recent releases (https://github.com/$REPO/releases)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "Downloading $(basename "$URL")"
curl -fL --progress-bar -o "$TMP/pkg" "$URL"

if [ "$OS" = mac ]; then
  DEST=/Applications
  [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
  tar -xzf "$TMP/pkg" -C "$TMP"
  [ -d "$TMP/Dispatch.app" ] || die "archive did not contain Dispatch.app"
  rm -rf "$DEST/Dispatch.app"
  mv "$TMP/Dispatch.app" "$DEST/"
  xattr -dr com.apple.quarantine "$DEST/Dispatch.app" 2>/dev/null || true
  say "Installed to $DEST/Dispatch.app"
  echo "    Open it from Launchpad, or run: open -a Dispatch"
else
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN" "$HOME/.local/share/applications"
  install -m 755 "$TMP/pkg" "$BIN/dispatch"
  cat > "$HOME/.local/share/applications/dispatch.desktop" <<EOF
[Desktop Entry]
Name=Dispatch
Comment=Native API client
Exec=$BIN/dispatch
Terminal=false
Type=Application
Categories=Development;
EOF
  say "Installed to $BIN/dispatch"
  case ":$PATH:" in *":$BIN:"*) ;; *) echo "    Add $BIN to your PATH to run 'dispatch' from a terminal." ;; esac
  echo "    AppImages need FUSE 2; if it won't start, install libfuse2 (e.g. sudo apt install libfuse2)."
fi
