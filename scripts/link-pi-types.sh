#!/usr/bin/env bash
#
# link-pi-types.sh — make `tsc` (and the unit tests) resolve real pi types.
#
# The source imports the pi API under two scopes — `@mariozechner/*` (older name)
# and `@earendil-works/*` (current) — plus `@sinclair/typebox`. At runtime pi's
# loader aliases these to the installed `@earendil-works/pi-coding-agent`; nothing
# is in this repo's node_modules. Rather than `npm install` pi's heavy native
# runtime just for types, this links the globally-installed pi package (the exact
# version you run) into node_modules under every name the source uses.
#
# pi must be on PATH (always true in a pi-config repo). node_modules is gitignored,
# so re-run this after a fresh clone / `npm ci`:  npm run setup:types
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PI_BIN="$(command -v pi || true)"
[[ -n "$PI_BIN" ]] || {
    echo "link-pi-types: 'pi' not found on PATH — install pi first." >&2
    exit 1
}

# Resolve the pi package root from its bin (following symlinks): <pkg>/dist/cli.js
PI_PKG="$(node -e 'const fs=require("fs"),p=require("path");console.log(p.resolve(fs.realpathSync(process.argv[1]),"..",".."));' "$PI_BIN")"
[[ -f "$PI_PKG/dist/index.d.ts" ]] || {
    echo "link-pi-types: could not locate pi types at '$PI_PKG'" >&2
    exit 1
}

PI_TUI="$PI_PKG/node_modules/@earendil-works/pi-tui"
TYPEBOX="$PI_PKG/node_modules/typebox"

link() { # link <target> <name-under-node_modules>
    local target="$1"
    local name="$2"
    local dest="$ROOT/node_modules/$name"
    [[ -e "$target" ]] || {
        echo "link-pi-types: missing dependency '$target'" >&2
        exit 1
    }
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    ln -s "$target" "$dest"
}

# Repo imports both scopes for the coding-agent API and pi-tui; typebox is `Type`.
link "$PI_PKG" "@earendil-works/pi-coding-agent"
link "$PI_PKG" "@mariozechner/pi-coding-agent"
link "$PI_TUI" "@earendil-works/pi-tui"
link "$PI_TUI" "@mariozechner/pi-tui"
link "$TYPEBOX" "@sinclair/typebox"

VER="$(node -e 'console.log(require(process.argv[1]+"/package.json").version)' "$PI_PKG")"
echo "link-pi-types: linked pi $VER types into node_modules (from $PI_PKG)"
