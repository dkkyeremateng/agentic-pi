#!/usr/bin/env bash
#
# patch-pi-statusline.sh — suppress pi's `Model: <id>` status line.
#
# Every model switch pushes a `Model: <id>` line into the transcript, where it
# stacks up in scrollback for the rest of the session. The footer already shows
# the active model, so the line is duplicate state that only accumulates.
#
# WHY THIS IS A SCRIPT. It was a hand-edit for months, which meant it vanished on
# every `pi update` with nothing to restore it and no record of where it went.
# pi 0.84.3 then MOVED the file — `dist/core/interactive-mode.js` became
# `dist/modes/interactive/interactive-mode.js` — so the note in someone's head was
# not just missing, it was wrong. This finds the file rather than assuming a path,
# and refuses to guess when it cannot.
#
# This edits pi's own package. It is therefore NOT run by install.sh and NOT run
# by run.sh — it is opt-in, idempotent, and fully revertable:
#   npm run patch:statusline
#   npm run patch:statusline -- --revert
#
# `pi update` wipes it; re-run afterwards.
set -euo pipefail

MARKER="PATCH (agentic-pi): status line suppressed"

PI_BIN="$(command -v pi || true)"
[[ -n "$PI_BIN" ]] || { echo "patch-pi-statusline: 'pi' not found on PATH." >&2; exit 1; }

# Walk up from the bin to pi's package root. Do not assume how deep the entry
# point sits: 0.84.3 moved it to dist/bundle/cli.js, and the fixed `../..` that
# link-pi-types.sh used silently resolved to the wrong directory.
PI_PKG="$(node -e '
const fs = require("fs"), p = require("path");
let dir = p.dirname(fs.realpathSync(process.argv[1]));
for (let i = 0; i < 10; i++) {
    const pkg = p.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
        try {
            if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === "@earendil-works/pi-coding-agent") {
                console.log(dir); process.exit(0);
            }
        } catch {}
    }
    const up = p.dirname(dir);
    if (up === dir) break;
    dir = up;
}
process.exit(1);
' "$PI_BIN")" || { echo "patch-pi-statusline: could not locate pi's package root." >&2; exit 1; }

# Find the file by CONTENT, not by path, so the next reorganisation is survivable.
#
# EVERY match, not the first. 0.84.4 ships the same call twice — once in
# dist/modes/interactive/interactive-mode.js and once in the esbuild bundle at
# dist/bundle/chunks/chunk-*.js — and package.json points `bin.pi` at
# dist/bundle/cli.js, so the BUNDLE is what actually runs. `head -1` picked the
# modes/ copy, patched dead code, and reported success: the status line kept
# appearing with nothing to show for the patch. Patching both is also correct if
# a future layout collapses them back into one.
# Read into an array WITHOUT `mapfile`: this runs under /usr/bin/env bash, and
# macOS still ships bash 3.2, where mapfile does not exist.
FILES=()
while IFS= read -r f; do
    [[ -n "$f" ]] && FILES+=("$f")
done < <(grep -rl 'showStatus(`Model: ' "$PI_PKG/dist" --include='*.js' 2>/dev/null || true)
[[ ${#FILES[@]} -gt 0 ]] || {
    echo "patch-pi-statusline: no file in $PI_PKG/dist contains a \`Model: \` showStatus call." >&2
    echo "  Either pi already removed the line, or it was rewritten — inspect before forcing this." >&2
    exit 1
}

if [[ "${1:-}" == "--revert" || "${1:-}" == "--unpatch" ]]; then
    reverted=0
    for FILE in "${FILES[@]}"; do
    if ! grep -qF "$MARKER" "$FILE"; then
        continue
    fi
    reverted=1
    python3 - "$FILE" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
# Restore every commented-out call we made.
out, n = re.subn(
    r"/\* PATCH \(agentic-pi\): status line suppressed \*/ ?(this\.showStatus\(`Model: [^\n]*?\);)",
    r"\1",
    src,
)
if not n:
    sys.exit("patch-pi-statusline: marker present but no patched call matched — reinstall pi.")
open(path, "w", encoding="utf-8").write(out)
print(f"patch-pi-statusline: reverted {n} call(s) in {path}")
PY
    node --check "$FILE" >/dev/null 2>&1 &&
        echo "patch-pi-statusline: syntax OK ($FILE)" ||
        { echo "patch-pi-statusline: SYNTAX CHECK FAILED — reinstall pi." >&2; exit 1; }
    done
    [[ $reverted == 1 ]] || echo "patch-pi-statusline: not applied — nothing to revert."
    exit 0
fi

patched=0
for FILE in "${FILES[@]}"; do
if grep -qF "$MARKER" "$FILE"; then
    echo "patch-pi-statusline: already applied — $FILE"
    continue
fi
patched=1

python3 - "$FILE" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
# Comment out rather than delete: the original stays readable in place, and the
# revert is a pure textual inverse.
out, n = re.subn(
    r"(?<!\*/ )(this\.showStatus\(`Model: [^\n]*?\);)",
    r"/* PATCH (agentic-pi): status line suppressed */ \1",
    src,
)
if not n:
    sys.exit("patch-pi-statusline: found the file but no `Model: ` showStatus call to patch.")
open(path, "w", encoding="utf-8").write(out)
print(f"patch-pi-statusline: commented out {n} call(s) in {path}")
PY

node --check "$FILE" >/dev/null 2>&1 &&
    echo "patch-pi-statusline: syntax OK ($FILE)" ||
    { echo "patch-pi-statusline: SYNTAX CHECK FAILED — reinstall pi." >&2; exit 1; }
done
[[ $patched == 1 ]] || echo "patch-pi-statusline: nothing to do — all ${#FILES[@]} file(s) already patched."
