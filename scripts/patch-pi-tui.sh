#!/usr/bin/env bash
#
# patch-pi-tui.sh — stop the workflow dashboard accumulating stale rows.
#
# ── The symptom ─────────────────────────────────────────────────────────────────
# An agent card grows a new "running Ns" row every second instead of overwriting
# the old one, and the Todos header appears twice with DIFFERENT frame numbers
# ("# Todos [frame 26]" above "# Todos [frame 29]"). Two frames on screen at once.
#
# ── What it is NOT ──────────────────────────────────────────────────────────────
# Ruled out with instrumentation, not inference:
#
#   * Not the widget. PI_WORKFLOW_DEBUG_WIDGET=1 dumps the array we hand pi: ONE
#     "# Todos" per frame, constant height.
#   * Not pi's composition. PI_DEBUG_RENDER_LINES=1 dumps pi's fully composed
#     frame: ONE "# Todos" per frame, at a stable index, frames 22..31.
#   * Not off-screen cursor clamping. That is real (see the guard below) but needs
#     content taller than the terminal; a normal session composes ~30 rows on a
#     78-row screen, so prevViewportTop is 0 and nothing can go off screen.
#   * Not ambiguous glyph width. iTerm2 here has `Ambiguous Double Width: false`,
#     so the box-drawing rules are one column and do not wrap.
#   * Not widget height churn. Pinning the widget to a constant height changed
#     nothing (and cost a block of reserved blank rows), so it was reverted.
#
# ── What it is ──────────────────────────────────────────────────────────────────
# pi renders only a LIVE REGION (widget + editor + footer, ~30 rows). Everything
# above is terminal scrollback it does not re-render. When a previously drawn live
# region is pushed up instead of overwritten in place, its rows stay on screen --
# an old frame's header sits above the current one.
#
# `fullRender(true)` clears exactly this (`\e[2J\e[H\e[3J` wipes screen AND
# scrollback), and it is reached via clearOnShrink -- but ONLY when the frame gets
# shorter. A dashboard whose composed height is stable never shrinks, so the
# absolute repaint never happens and the stale copies persist indefinitely.
#
# ── What this patch does ────────────────────────────────────────────────────────
# 1. PERIODIC ABSOLUTE REPAINT (the fix). Force `fullRender(true)` every
#    PI_TUI_REPAINT_EVERY frames (default 40). Whatever leaves rows behind -- a
#    stray write from a subprocess, a scrolled live region, a cursor drift -- is
#    wiped within a bounded number of frames instead of persisting for the whole
#    run. Self-healing rather than a claim to have found every cause.
#
# 2. OFF-SCREEN CURSOR-MOVE GUARD (a separate, latent bug). pi positions the
#    cursor with RELATIVE moves (CUU/CUD), which terminals CLAMP at the screen
#    edges; pi records the move as successful, so the error is inherited forever.
#    The existing guard validates `firstChanged`, but the move targets
#    `moveTargetRow`, and the scroll branch between them shifts both viewport
#    origins after the check. Re-validating both endpoints costs nothing and
#    matters whenever content DOES overflow the window. Demonstrated by
#    scripts/verify-pi-tui-patch.mjs.
#
# 3. COMPOSED-FRAME DUMP (diagnostic, inert unless PI_DEBUG_RENDER_LINES=1) --
#    writes pi's composed frame to ~/.pi/agent/pi-render.log. Pairs with
#    PI_WORKFLOW_DEBUG_WIDGET=1 to separate "what we sent" from "what pi rendered".
#
# All three are conservative: they add absolute repaints and diagnostics, and never
# change what a correct incremental frame draws.
#
# This is a WORKAROUND. The durable upstream fix is for pi-tui to own its live
# region absolutely (CUP positioning, or tracking the hardware cursor against the
# physical screen) rather than inferring it from relative moves.
#
# Idempotent: safe to re-run. `pi update` replaces the package and wipes this, so
# re-run after upgrading. `--revert` restores the pristine file from the backup
# taken at first apply.
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
BACKUP="$FILE.agentic-pi.orig"
MARKER="PATCH (agentic-pi)"

[[ -f "$FILE" ]] || {
    echo "patch-pi-tui: $FILE not found — is pi installed?" >&2
    echo "  override the location with PI_PKG_DIR=/path/to/pi-coding-agent" >&2
    exit 1
}

if [[ "${1:-}" == "--revert" || "${1:-}" == "--unpatch" ]]; then
    if ! grep -qF "$MARKER" "$FILE"; then
        echo "patch-pi-tui: not applied — nothing to revert."
        exit 0
    fi
    [[ -f "$BACKUP" ]] || {
        echo "patch-pi-tui: backup $BACKUP is missing — cannot revert safely." >&2
        echo "  reinstall instead: npm i -g @earendil-works/pi-coding-agent" >&2
        exit 1
    }
    cp "$BACKUP" "$FILE"
    rm -f "$BACKUP"
    node --check "$FILE" >/dev/null 2>&1 &&
        echo "patch-pi-tui: reverted $FILE (restored from backup)" ||
        { echo "patch-pi-tui: SYNTAX CHECK FAILED after revert — reinstall pi" >&2; exit 1; }
    exit 0
fi

if grep -qF "$MARKER" "$FILE"; then
    echo "patch-pi-tui: already applied — nothing to do."
    exit 0
fi

# Keep a pristine copy so --revert is exact rather than a regex guess.
cp "$FILE" "$BACKUP"

python3 - "$FILE" <<'PY'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
src = path.read_text(encoding="utf-8")


def splice(src, anchor, addition, where="after", label=""):
    if anchor not in src:
        sys.exit(f"patch-pi-tui: anchor not found ({label}) — pi-tui's render path has changed.")
    return src.replace(
        anchor, (anchor + addition) if where == "after" else (addition + anchor), 1
    )


# ── 1. periodic absolute repaint ────────────────────────────────────────────────
# Placed immediately before the incremental path's first early return, so it wins
# over every incremental branch below it.
src = splice(
    src,
    """        // Differential rendering can only touch what was actually visible.""",
    "",
    "after",
    "repaint anchor",
)
src = src.replace(
    """        // Differential rendering can only touch what was actually visible.""",
    """        // PATCH (agentic-pi): periodic absolute repaint.
        //
        // pi only re-renders a LIVE REGION; everything above it is terminal
        // scrollback it does not own. When a previously drawn live region ends up
        // pushed up rather than overwritten in place, its rows stay on screen --
        // that is the duplicated dashboard header, with an OLDER frame number
        // above the current one.
        //
        // fullRender(true) clears exactly that (screen + scrollback), but it is
        // only reached via clearOnShrink, i.e. when a frame gets SHORTER. A
        // dashboard whose composed height is stable never shrinks, so the absolute
        // repaint never runs and the stale copies persist for the whole session.
        //
        // Forcing one every N frames bounds how long ANY corruption can survive,
        // whatever produced it, instead of requiring us to have found every cause.
        // 0 disables.
        this.__piFramesSinceFull = (this.__piFramesSinceFull || 0) + 1;
        const __piEvery = process.env.PI_TUI_REPAINT_EVERY === undefined
            ? 40
            : Number(process.env.PI_TUI_REPAINT_EVERY);
        if (__piEvery > 0 && this.__piFramesSinceFull >= __piEvery) {
            this.__piFramesSinceFull = 0;
            logRedraw(`periodic repaint (every ${__piEvery} frames)`);
            fullRender(true);
            return;
        }
        // Differential rendering can only touch what was actually visible.""",
    1,
)

# ── 2. off-screen cursor-move guard ─────────────────────────────────────────────
src = splice(
    src,
    """        // Move cursor to first changed line (use hardwareCursorRow for actual position)
        const lineDiff = computeLineDiff(moveTargetRow);""",
    "",
    "after",
    "cursor-guard anchor",
)
src = src.replace(
    """        // Move cursor to first changed line (use hardwareCursorRow for actual position)
        const lineDiff = computeLineDiff(moveTargetRow);""",
    """        // PATCH (agentic-pi): off-screen cursor-move guard.
        //
        // The moves below are RELATIVE (CUU/CUD) and terminals CLAMP them at the
        // screen edges: move up 70 from screen row 8 and you land on 0, not -62.
        // pi records the move as successful, so the error is inherited by every
        // later frame and never self-heals. The guard above validates
        // `firstChanged`, but the move targets `moveTargetRow`, and the scroll
        // branch in between may have advanced both viewport origins since. So
        // re-validate BOTH endpoints against the real screen here.
        const __piCur = hardwareCursorRow - prevViewportTop;
        const __piTarget = moveTargetRow - viewportTop;
        if (__piCur < 0 || __piCur >= height || __piTarget < 0 || __piTarget >= height) {
            logRedraw(`off-screen cursor move (cur=${__piCur}, target=${__piTarget}, height=${height})`);
            fullRender(true);
            return;
        }
        // Move cursor to first changed line (use hardwareCursorRow for actual position)
        const lineDiff = computeLineDiff(moveTargetRow);""",
    1,
)

# ── 3. composed-frame dump (diagnostic) ─────────────────────────────────────────
src = splice(
    src,
    "        newLines = this.applyLineResets(newLines);",
    """
        // PATCH (agentic-pi): composed-frame dump (PI_DEBUG_RENDER_LINES=1).
        // What pi actually renders, to compare against PI_WORKFLOW_DEBUG_WIDGET=1
        // (what the extension hands pi). Inert unless the env var is set.
        if (process.env.PI_DEBUG_RENDER_LINES === "1") {
            try {
                const __d = newLines.map((l, i) =>
                    String(i).padStart(3) + "| " +
                    String(l).replace(/\\x1b\\[[0-9;]*m/g, "").replace(/\\u200b/g, "<ZWSP>")
                ).join("\\n");
                fs.appendFileSync(path.join(this.logDirectory, "pi-render.log"),
                    "\\n=== rows=" + newLines.length + " height=" + height + " width=" + width + " ===\\n" + __d + "\\n");
            } catch (e) { }
        }""",
    "after",
    "render-dump anchor",
)

# Reset the frame counter whenever a full render happens for any other reason, so
# the periodic repaint measures time since the LAST absolute repaint.
src = splice(
    src,
    "            this.previousHeight = height;\n        };",
    "",
    "after",
    "fullRender tail anchor",
)
src = src.replace(
    "            this.previousHeight = height;\n        };",
    "            this.previousHeight = height;\n            this.__piFramesSinceFull = 0; // PATCH (agentic-pi)\n        };",
    1,
)

path.write_text(src, encoding="utf-8")
print("patch-pi-tui: applied 3 insertions")
PY

node --check "$FILE" >/dev/null 2>&1 &&
    echo "patch-pi-tui: syntax OK" ||
    { echo "patch-pi-tui: SYNTAX CHECK FAILED — restoring backup" >&2; cp "$BACKUP" "$FILE"; exit 1; }

echo "patch-pi-tui: done (backup: $BACKUP). Restart pi for it to take effect."
