#!/usr/bin/env bash
#
# install.sh — put the atlassian (Jira) CLI on PATH as `atlassian`.
#
# Symlinks this skill's atlassian.py into a bin dir using its own resolved
# location, so it works wherever the repo lives. atlassian.py reads its config
# (ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN) from the environment or
# the nearest .env, so the symlink keeps working.
#
#   bash install.sh                  # link into ~/.local/bin
#   bash install.sh /usr/local/bin   # or a bin dir of your choice
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/atlassian.py"
BIN_DIR="${1:-$HOME/.local/bin}"

[[ -f "$SRC" ]] || { echo "install: $SRC not found" >&2; exit 1; }

mkdir -p "$BIN_DIR"
chmod +x "$SRC"
ln -sf "$SRC" "$BIN_DIR/atlassian"
echo "atlassian: linked $SRC -> $BIN_DIR/atlassian"

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not on your PATH — add it, or run via the full path." ;;
esac
