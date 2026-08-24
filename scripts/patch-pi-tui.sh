#!/usr/bin/env bash
#
# patch-pi-tui.sh — stop pi-tui's differential renderer desyncing when content is
# taller than the terminal, which strands rows on screen permanently.
#
# ── The symptom ─────────────────────────────────────────────────────────────────
# The agent-workflow dashboard accumulates stale rows: an agent card grows a new
# "running Ns" line every second instead of overwriting the old one, and the Todos
# header appears twice. Two frames are visible at once.
#
# That is NOT the widget duplicating content. Proven with PI_WORKFLOW_DEBUG_WIDGET=1,
# which dumps the exact array handed to pi: it contains ONE "# Todos" per frame at a
# constant 40 rows, while the screen shows two. Stamping the header with a frame
# counter settled it — the screen showed `[frame 57]` and `[frame 59]` side by side,
# so two different frames were on screen simultaneously.
#
# ── Why it happens ──────────────────────────────────────────────────────────────
# `doRender()` positions the cursor with RELATIVE moves — CUU/CUD (`\e[NA`/`\e[NB`)
# — computed by `computeLineDiff()`:
#
#     currentScreenRow = hardwareCursorRow - prevViewportTop
#     targetScreenRow  = targetRow - viewportTop
#     lineDiff         = targetScreenRow - currentScreenRow
#
# Relative moves CLAMP at the screen edges. Ask to move up 5 rows from screen row 2
# and the cursor lands on row 0, not row -3. pi then records the move as if it had
# succeeded (`hardwareCursorRow = ...`), so every subsequent frame inherits the
# error. The desync is permanent and cumulative, which is why rows pile up instead
# of being overwritten, and why it never self-heals.
#
# There IS a guard for this, but it validates the wrong row:
#
#     if (firstChanged < prevViewportTop) { fullRender(true); return; }   // checks firstChanged
#     ...
#     const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged; // moves to THIS
#
# `moveTargetRow` can be one row above `firstChanged`, and after the scroll branch
# below it (`prevViewportTop += scroll; viewportTop += scroll`) the origins the
# guard checked are no longer the origins the move uses. Nothing re-validates that
# the final target — or the cursor's own current row — is actually on screen.
#
# Only reached when content EXCEEDS the terminal height, because `prevViewportTop`
# is 0 otherwise and every row is trivially on screen. A workflow dashboard on a
# 78-row terminal renders 131-143 lines, so it lives in that regime permanently.
#
# ── What this patch does ────────────────────────────────────────────────────────
# Re-validates both endpoints of the relative move immediately before it is
# emitted, after the scroll adjustment has had its chance. If either the current
# cursor row or the target row is outside 0..height-1, the relative move cannot be
# trusted, so fall back to `fullRender(true)` — an absolute repaint that cannot
# desync.
#
# Strictly conservative: it only ever converts an UNSAFE incremental render into a
# correct full one. It cannot introduce a wrong frame, and in the common case
# (content fits, or the target is on screen) it changes nothing at all. The cost is
# an occasional extra full repaint in the overflow regime.
#
# This is a WORKAROUND for an upstream defect, not a redesign. The real fix is for
# pi-tui to track the hardware cursor against the physical screen rather than an
# inferred viewport, or to use absolute positioning (CUP) instead of relative moves.
#
# Idempotent: safe to re-run. `pi update` replaces the package and wipes this, so
# re-run after upgrading. `--revert` restores the upstream source.
#   npm run patch:tui
#   npm run patch:tui -- --revert
set -euo pipefail

PI_PKG_DIR="${PI_PKG_DIR:-}"
if [[ -z "$PI_PKG_DIR" ]]; then
    PI_BIN="$(command -v pi || true)"
    [[ -n "$PI_BIN" ]] || {
        echo "patch-pi-tui: 'pi' not found on PATH." >&2
        exit 1
    }
    PI_REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$PI_BIN")"
    PI_PKG_DIR="$(cd "$(dirname "$PI_REAL")/.." && pwd)"
fi

FILE="$PI_PKG_DIR/node_modules/@earendil-works/pi-tui/dist/tui.js"
MARKER="PATCH (agentic-pi): off-screen cursor-move guard"

[[ -f "$FILE" ]] || {
    echo "patch-pi-tui: $FILE not found — is pi installed?" >&2
    echo "  override the location with PI_PKG_DIR=/path/to/pi-coding-agent" >&2
    exit 1
}

ORIGINAL='        // Move cursor to first changed line (use hardwareCursorRow for actual position)
        const lineDiff = computeLineDiff(moveTargetRow);'

if [[ "${1:-}" == "--revert" || "${1:-}" == "--unpatch" ]]; then
    if ! grep -qF "$MARKER" "$FILE"; then
        echo "patch-pi-tui: not applied — nothing to revert."
        exit 0
    fi
    ORIGINAL="$ORIGINAL" python3 - "$FILE" <<'PY'
import os, re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

PATCHED = re.compile(
    r"[ \t]*// PATCH \(agentic-pi\): off-screen cursor-move guard\.\n"
    r"(?:[ \t]*//.*\n|[ \t]*\n)*?"
    r"[ \t]*const __piGuardCur = hardwareCursorRow - prevViewportTop;\n"
    r"(?:.*\n)*?"
    r"[ \t]*\}\n"
    r"[ \t]*// Move cursor to first changed line \(use hardwareCursorRow for actual position\)\n"
    r"[ \t]*const lineDiff = computeLineDiff\(moveTargetRow\);\n"
)

if not PATCHED.search(src):
    sys.exit(
        "patch-pi-tui: marker present but the patched block does not match.\n"
        "  Reinstall instead: npm i -g @earendil-works/pi-coding-agent"
    )

open(path, "w", encoding="utf-8").write(
    PATCHED.sub(os.environ["ORIGINAL"] + "\n", src, count=1)
)
print(f"patch-pi-tui: reverted {path}")
PY
    node --check "$FILE" >/dev/null 2>&1 &&
        echo "patch-pi-tui: syntax OK" ||
        { echo "patch-pi-tui: SYNTAX CHECK FAILED — reinstall pi" >&2; exit 1; }
    exit 0
fi

if grep -qF "$MARKER" "$FILE"; then
    echo "patch-pi-tui: already applied — nothing to do."
    exit 0
fi

grep -qF "$ORIGINAL" "$FILE" || {
    echo "patch-pi-tui: anchor not found in $FILE — pi-tui's render path has changed." >&2
    echo "  Re-check doRender() before forcing this patch." >&2
    exit 1
}

ORIGINAL="$ORIGINAL" python3 - "$FILE" <<'PY'
import os, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
OLD = os.environ["ORIGINAL"]

NEW = '''        // PATCH (agentic-pi): off-screen cursor-move guard.
        //
        // Everything below positions the cursor with RELATIVE moves (CUU/CUD).
        // Terminals CLAMP those at the screen edges: asking to move up 5 from
        // screen row 2 lands on row 0, not -3. pi then records the move as if it
        // had succeeded, so the error is inherited by every later frame -- rows
        // stop being overwritten and pile up instead, and it never self-heals.
        //
        // The guard above validates `firstChanged`, but the move uses
        // `moveTargetRow` (which is `firstChanged - 1` when appendStart), and the
        // scroll branch just above may have advanced both viewport origins since.
        // So re-validate BOTH endpoints of the move against the real screen here.
        //
        // Only reachable when content exceeds the terminal height (otherwise
        // prevViewportTop is 0 and every row is on screen). Falling back to an
        // absolute repaint is always correct, just more expensive.
        const __piGuardCur = hardwareCursorRow - prevViewportTop;
        const __piGuardTarget = moveTargetRow - viewportTop;
        if (__piGuardCur < 0 || __piGuardCur >= height ||
            __piGuardTarget < 0 || __piGuardTarget >= height) {
            logRedraw(`off-screen cursor move (cur=${__piGuardCur}, target=${__piGuardTarget}, height=${height})`);
            fullRender(true);
            return;
        }
        // Move cursor to first changed line (use hardwareCursorRow for actual position)
        const lineDiff = computeLineDiff(moveTargetRow);'''

if OLD not in src:
    sys.exit("patch-pi-tui: anchor vanished between check and write — aborting.")

open(path, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
print(f"patch-pi-tui: patched {path}")
PY

node --check "$FILE" >/dev/null 2>&1 &&
    echo "patch-pi-tui: syntax OK" ||
    { echo "patch-pi-tui: SYNTAX CHECK FAILED — reinstall pi" >&2; exit 1; }

echo "patch-pi-tui: done. Restart pi for it to take effect."
