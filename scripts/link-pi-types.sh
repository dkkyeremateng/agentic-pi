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

# What to do when `pi` is not on PATH.
#
# Order matters, and it was wrong: this checked `types/stubs` FIRST and exited,
# so the real-types branch below was dead whenever the stubs directory existed. A
# transient PATH miss would then REPLACE working type links with stubs, silently
# downgrading a machine that had the real thing.
#
# The stubs are also not a substitute for types. They are `any`-shaped, with
# `[key: string]: any` index signatures, so `tsc --noEmit` against them accepts
# almost anything — a CI typecheck built on them is vacuously green, which is
# worse than no typecheck because it reads as coverage. So stubs are opt-in
# (PI_TYPES_ALLOW_STUBS=1) and say plainly what they are worth.
fallback_stubs() {
    if [[ -d "$ROOT/node_modules/@earendil-works/pi-coding-agent" ]]; then
        echo "link-pi-types: 'pi' not on PATH, but real types are already linked in node_modules — keeping them."
        exit 0
    fi
    if [[ "${PI_TYPES_ALLOW_STUBS:-}" == "1" && -d "$ROOT/types/stubs" ]]; then
        link "$ROOT/types/stubs/pi-coding-agent" "@earendil-works/pi-coding-agent"
        link "$ROOT/types/stubs/pi-coding-agent" "@mariozechner/pi-coding-agent"
        link "$ROOT/types/stubs/pi-tui" "@earendil-works/pi-tui"
        link "$ROOT/types/stubs/pi-tui" "@mariozechner/pi-tui"
        link "$ROOT/types/stubs/typebox" "@sinclair/typebox"
        echo "link-pi-types: WARNING — linked ANY-shaped fallback stubs, not real pi types." >&2
        echo "link-pi-types:   A typecheck against these proves almost nothing. Use it to run" >&2
        echo "link-pi-types:   the suite without pi installed; do NOT treat it as type coverage." >&2
        exit 0
    fi
    echo "link-pi-types: 'pi' not found on PATH and no real types in node_modules." >&2
    echo "link-pi-types:   Install pi, or set PI_TYPES_ALLOW_STUBS=1 to link any-shaped" >&2
    echo "link-pi-types:   stubs (which makes a typecheck vacuous — see this function)." >&2
    exit 1
}

# shellcheck source=lib/pi-package.sh
. "$ROOT/scripts/lib/pi-package.sh"
command -v pi >/dev/null 2>&1 || fallback_stubs

# Resolve the pi package root from the entry `pi` really runs — through the
# managed launcher when that is what `pi` is (lib/pi-package.sh). Walking up
# rather than assuming a depth matters too: 0.84.3 moved the entry to
# dist/bundle/cli.js, and a fixed `../..` silently resolved to <pkg>/dist —
# breaking `npm test` and `npm run typecheck` with an error that blamed missing
# types rather than the path.
PI_PKG="$(pi_package_dir || true)"

if [[ -z "$PI_PKG" || ! -f "$PI_PKG/dist/index.d.ts" ]]; then
    fallback_stubs
fi

# Nested under pi (npm global) or beside it (managed install).
PI_TUI="$(pi_dependency_dir "$PI_PKG" "@earendil-works/pi-tui" || true)"
TYPEBOX="$(pi_dependency_dir "$PI_PKG" "typebox" || true)"

# Repo imports both scopes for the coding-agent API and pi-tui; typebox is `Type`.
link "$PI_PKG" "@earendil-works/pi-coding-agent"
link "$PI_PKG" "@mariozechner/pi-coding-agent"
link "$PI_TUI" "@earendil-works/pi-tui"
link "$PI_TUI" "@mariozechner/pi-tui"
link "$TYPEBOX" "@sinclair/typebox"

VER="$(node -e 'console.log(require(process.argv[1]+"/package.json").version)' "$PI_PKG")"
echo "link-pi-types: linked pi $VER types into node_modules (from $PI_PKG)"
