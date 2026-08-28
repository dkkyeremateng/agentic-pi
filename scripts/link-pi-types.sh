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

# Resolve the pi package root by walking UP from the bin until a package.json
# with pi's own name appears. Do not assume how deep the entry point sits: pi
# 0.84.3 moved it from <pkg>/dist/cli.js to <pkg>/dist/bundle/cli.js, and the
# old fixed `../..` silently resolved to <pkg>/dist — breaking `npm test` and
# `npm run typecheck` on upgrade, with an error that pointed at the types being
# missing rather than at the path being wrong.
PI_PKG="$(node -e '
const fs = require("fs"), p = require("path");
let dir = p.dirname(fs.realpathSync(process.argv[1]));
for (let i = 0; i < 10; i++) {
    const pkg = p.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
        try {
            if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === "@earendil-works/pi-coding-agent") {
                console.log(dir);
                process.exit(0);
            }
        } catch {}
    }
    const up = p.dirname(dir);
    if (up === dir) break;
    dir = up;
}
process.exit(1);
' "$PI_BIN")"
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
