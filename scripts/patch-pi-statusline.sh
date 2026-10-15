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

# Find the files by CONTENT, not by path, so the next reorganisation is survivable.
#
# EVERY match, not the first. 0.84.4 shipped the call twice — once in
# dist/modes/interactive/interactive-mode.js and once in the esbuild bundle at
# dist/bundle/chunks/chunk-*.js — and package.json points `bin.pi` at
# dist/bundle/cli.js, so the BUNDLE is what actually runs. `head -1` picked the
# modes/ copy, patched dead code, and reported success. Patching every copy is
# also correct if a future layout collapses them back into one.
# Read into an array WITHOUT `mapfile`: this runs under /usr/bin/env bash, and
# macOS still ships bash 3.2, where mapfile does not exist.
FILES=()
while IFS= read -r f; do
    [[ -n "$f" ]] && grep -qF 'showStatus(' "$f" && FILES+=("$f")
done < <(grep -rl '`Model: ' "$PI_PKG/dist" --include='*.js' 2>/dev/null || true)
[[ ${#FILES[@]} -gt 0 ]] || {
    echo "patch-pi-statusline: no file in $PI_PKG/dist contains a \`Model: \` showStatus call." >&2
    echo "  Either pi already removed the line, or it was rewritten — inspect before forcing this." >&2
    exit 1
}

MODE=patch
[[ "${1:-}" == "--revert" || "${1:-}" == "--unpatch" ]] && MODE=revert

# The rewrite. Exit 0 = changed (new text on stdout's last line is the summary),
# 3 = nothing to do in this file, anything else = refuse.
#
# THE CALL GOES INSIDE THE COMMENT. Until pi 1.2 this script wrote
# `/* PATCH … */ this.showStatus(…)` — a closed comment IN FRONT of the call,
# which therefore still ran: from the day the script replaced the hand-edit it
# suppressed nothing, while printing "commented out" and "syntax OK". Now the
# call is the comment's body and `void 0` takes its place, which is valid both
# as a statement (`void 0;`) and inside the bundle's comma expressions
# (`…,void 0,…`). Old-style markers are stripped on the way.
#
# pi 1.2 also added a second shape, the model picker's
#   this.showStatus(persist ? `Default model: …` : `Model: ${model.id}`)
# so the match is "a showStatus( call whose argument holds a `Model: ` template".
# The argument may contain only template literals and paren-free tokens, so it
# cannot run on across the rest of a minified line the way `[^\n]*?\);` did.
REWRITE='
import re, sys
mode, path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path, encoding="utf-8").read()
TAG = "PATCH (agentic-pi): status line suppressed"
ARG = r"(?:[^()`\n]|`[^`\n]*`)*?"
CALL = r"this\.showStatus\(" + ARG + r"`Model: [^`\n]*`" + ARG + r"\)"
OLD = re.compile(r"/\* " + re.escape(TAG) + r" \*/ ?")
PATCHED = re.compile(r"/\* " + re.escape(TAG) + r": (" + CALL + r") \*/ void 0")
out, stale = OLD.subn("", src)
if mode == "revert":
    out, n = PATCHED.subn(lambda m: m.group(1), out)
    verb = "restored"
else:
    def wrap(m):
        if "*/" in m.group(0):
            sys.exit("patch-pi-statusline: a matched call contains */ — refusing to wrap it in a comment.")
        return "/* " + TAG + ": " + m.group(0) + " */ void 0"
    out, n = re.subn(r"(?<!suppressed: )" + CALL, wrap, out)
    verb = "suppressed"
if not n and not stale:
    sys.exit(3)
open(out_path, "w", encoding="utf-8").write(out)
note = f" (removed {stale} inert pre-1.2 marker(s))" if stale else ""
print(f"patch-pi-statusline: {verb} {n} call(s) in {path}{note}")
'

changed=0
for FILE in "${FILES[@]}"; do
    # Write next to the original (same package.json, so `node --check` parses it
    # as the same module type) and only move it into place once it parses: a
    # failed rewrite leaves pi untouched instead of broken.
    TMP="$FILE.agentic-pi-tmp.js"
    set +e
    python3 -c "$REWRITE" "$MODE" "$FILE" "$TMP"
    rc=$?
    set -e
    [[ $rc == 3 ]] && continue
    [[ $rc == 0 ]] || { rm -f "$TMP"; exit 1; }
    if node --check "$TMP" >/dev/null 2>&1; then
        mv "$TMP" "$FILE"
        changed=1
        echo "patch-pi-statusline: syntax OK ($FILE)"
    else
        rm -f "$TMP"
        echo "patch-pi-statusline: the rewrite of $FILE does not parse — left it untouched." >&2
        exit 1
    fi
done
if [[ $changed == 0 ]]; then
    [[ $MODE == revert ]] &&
        echo "patch-pi-statusline: not applied — nothing to revert." ||
        echo "patch-pi-statusline: nothing to do — all ${#FILES[@]} file(s) already patched."
fi
