#!/usr/bin/env bash
#
# install.sh — put the LSP client on PATH as `lsp`.
#
# Symlinks this skill's lsp.py into a bin dir using its own resolved location, so it
# works wherever the repo lives. The language servers themselves (pyright, gopls,
# typescript-language-server, intelephense) are installed separately — see SKILL.md.
#
#   bash install.sh                  # link into ~/.local/bin
#   bash install.sh /usr/local/bin   # or a bin dir of your choice
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/lsp.py"
BIN_DIR="${1:-$HOME/.local/bin}"

[[ -f "$SRC" ]] || { echo "install: $SRC not found" >&2; exit 1; }

mkdir -p "$BIN_DIR"
chmod +x "$SRC"
ln -sf "$SRC" "$BIN_DIR/lsp"
echo "lsp: linked $SRC -> $BIN_DIR/lsp"

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not on your PATH — add it, or run via the full path." ;;
esac
