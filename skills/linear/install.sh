#!/usr/bin/env bash
#
# install.sh — put the linear CLI on PATH as `linear`.
#
# Symlinks this skill's linear.py into a bin dir using its own resolved location,
# so it works regardless of where the repo lives (no hardcoded paths). linear.py
# resolves the repo .env relative to its real path, so the symlink keeps working.
#
#   bash install.sh            # link into ~/.local/bin
#   bash install.sh /usr/local/bin   # or a bin dir of your choice
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/linear.py"
BIN_DIR="${1:-$HOME/.local/bin}"

[[ -f "$SRC" ]] || { echo "install: $SRC not found" >&2; exit 1; }

mkdir -p "$BIN_DIR"
chmod +x "$SRC"
ln -sf "$SRC" "$BIN_DIR/linear"
echo "linear: linked $SRC -> $BIN_DIR/linear"

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not on your PATH — add it, or run via the full path." ;;
esac
