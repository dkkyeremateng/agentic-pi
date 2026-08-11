#!/usr/bin/env bash
#
# patch-context-prune.sh — give pi-context-prune a KEEP-RECENT window so it can
# actually prune spawned sub-agents without eating the work in progress.
#
# ── The upstream gap ────────────────────────────────────────────────────────────
# In `agent-message` mode (the recommended trigger) pruning flushes only on the
# FINAL assistant message:
#
#     pi.on("message_end", …)  →  if (!isFinalAssistantMessage(event.message)) return;
#
# Sensible interactively, where the agent replies and waits for you. Meaningless in
# a spawned sub-agent running `pi -p`: ONE user turn, dozens of tool-calling
# assistant messages, and exactly one final assistant message — at the very end.
# So a sub-agent carries every turn's tool output for its whole phase and flushes
# once, uselessly, after the work is done.
#
# Measured: a phase-implementer reached 252,289 of a 256,000-token window (98.6%)
# and produced a turn with stopReason "length" — real truncation. In a later run
# every one of 12 sessions logged exactly ONE flush, with up to 41 batches waiting
# in it, while context grew monotonically and never once dropped.
#
# ── Why the obvious fix was worse ───────────────────────────────────────────────
# Flushing on every turn (the first attempt, reverted) is destructive: the pruner
# summarizes a turn's tool results away at turn_end, but in an agentic loop turn N+1
# IS the model acting on turn N's output. The content vanishes exactly when it is
# needed.
#
# Observed: a planner asked to read a 113KB spec looped ~30 times over the same file
# — `read`, `python3`, `dd | od`, `base64`, `node`, and finally ROT13 — an escalation
# that only makes sense if the model believes its output is being filtered. Context
# stayed pinned at 8-9k tokens across 27 turns while the pruner logged 31 flushes.
#
# ── What this patch does ────────────────────────────────────────────────────────
# Prune the OLD turns, never the recent ones. On each turn_end in a HEADLESS session
# with `agent-message` mode, summarize every pending batch except the most recent
# `PI_PRUNE_KEEP_RECENT` (default 3), which stay raw in context. A tool result is
# therefore always readable for at least the next few turns — long enough to be
# acted on — while everything older is reclaimed mid-run instead of at the end.
#
# `capturePendingBatches` reads from the SESSION, so the held-back batches simply
# stay unindexed and are re-offered next turn; the queue array is kept in sync for
# the fallback path where the session read fails.
#
# INTERACTIVE SESSIONS ARE UNTOUCHED. `every-turn` keeps its exact upstream
# behaviour and `agent-message` still flushes on the final message when there is a
# UI — only the headless branch is new, so the prefix cache and the interactive
# batching story are unchanged.
#
# Tuning: PI_PRUNE_KEEP_RECENT=N (default 3, minimum 1). Raise it if agents in your
# workflow routinely reference tool output many turns later; lower it to reclaim
# more aggressively.
#
# Idempotent: safe to re-run. `pi update` replaces the package and wipes this, so
# re-run after upgrading. `--revert` restores the upstream source.
#   npm run patch:prune
#   npm run patch:prune -- --revert
set -euo pipefail

PKG="${PI_CONTEXT_PRUNE_DIR:-$HOME/.pi/agent/npm/node_modules/pi-context-prune}"
FILE="$PKG/index.ts"
MARKER="PATCH (agentic-pi): headless keep-recent pruning"

[[ -f "$FILE" ]] || {
    echo "patch-context-prune: $FILE not found — is pi-context-prune installed?" >&2
    echo "  install with: pi install npm:pi-context-prune" >&2
    exit 1
}

ORIGINAL='    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {'

if [[ "${1:-}" == "--revert" || "${1:-}" == "--unpatch" ]]; then
    if ! grep -qF "$MARKER" "$FILE"; then
        echo "patch-context-prune: not applied — nothing to revert."
        exit 0
    fi
    ORIGINAL="$ORIGINAL" python3 - "$FILE" <<'PY'
import os, re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# Match our whole inserted block: the marker comment through the `} else {` that
# closes it, and restore the two-line upstream original.
PATCHED = re.compile(
    r"[ \t]*// PATCH \(agentic-pi\): headless keep-recent pruning\.\n"
    r"(?:[ \t]*//.*\n)*"
    r"[ \t]*const headless = ctx\?\.hasUI === false;\n"
    r"[ \t]*if \(headless && currentConfig\.value\.pruneOn === \"agent-message\"\) \{\n"
    r"(?:.*\n)*?"
    r"[ \t]*\} else if \(currentConfig\.value\.pruneOn === \"every-turn\"\) \{\n"
    r"[ \t]*await flushPending\(ctx, \{ delivery: \"session\" \}\);\n"
    r"[ \t]*\} else \{\n"
)

if not PATCHED.search(src):
    sys.exit(
        "patch-context-prune: marker present but the patched block does not match.\n"
        "  Reinstall instead: pi install npm:pi-context-prune"
    )

open(path, "w", encoding="utf-8").write(
    PATCHED.sub(os.environ["ORIGINAL"] + "\n", src, count=1)
)
print(f"patch-context-prune: reverted {path}")
PY
    node --experimental-strip-types --check "$FILE" >/dev/null 2>&1 &&
        echo "patch-context-prune: syntax OK" ||
        { echo "patch-context-prune: SYNTAX CHECK FAILED — reinstall pi-context-prune" >&2; exit 1; }
    exit 0
fi

if grep -qF "$MARKER" "$FILE"; then
    echo "patch-context-prune: already applied — nothing to do."
    exit 0
fi

ORIGINAL="$ORIGINAL" python3 - "$FILE" <<'PY'
import os, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
OLD = os.environ["ORIGINAL"]

NEW = '''    // PATCH (agentic-pi): headless keep-recent pruning.
    // A spawned sub-agent (`pi -p`) has exactly ONE final assistant message, at the
    // very end, so `agent-message` never flushes mid-run and the agent carries every
    // turn's tool output for its whole phase (measured: 98.6% of a 256k window, then
    // a turn truncated with stopReason "length").
    // Flushing on EVERY turn is worse: turn N+1 is the model acting on turn N's
    // output, so summarizing it at turn_end removes it exactly when it is needed —
    // an agent reading a large file looped ~30 times trying to get its own read back.
    // So: prune the OLD batches and keep the most recent PI_PRUNE_KEEP_RECENT
    // (default 3) raw. capturePendingBatches reads from the SESSION, so held-back
    // batches stay unindexed and are simply re-offered next turn; we also put them
    // back on the queue array to keep the session-read-failed fallback correct.
    // Interactive sessions are untouched — `every-turn` keeps its upstream behaviour
    // below, and `agent-message` with a UI still flushes on the final message.
    const headless = ctx?.hasUI === false;
    if (headless && currentConfig.value.pruneOn === "agent-message") {
      const keepRaw = parseInt(process.env.PI_PRUNE_KEEP_RECENT || "3", 10);
      const keep = Number.isNaN(keepRaw) || keepRaw < 1 ? 3 : keepRaw;
      const all = capturePendingBatches(ctx);
      if (all.length > keep) {
        const older = all.slice(0, all.length - keep);
        const held = all.slice(all.length - keep);
        await flushPending(ctx, { delivery: "session", previewedBatches: older });
        // flushPending drains the queue; restore the recent tail at the FRONT so a
        // batch captured during the await cannot be reordered ahead of it.
        pendingBatches.unshift(...held);
      }
    } else if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {'''

if OLD not in src:
    sys.exit(
        "patch-context-prune: anchor not found — pi-context-prune has changed.\\n"
        "  Re-check the turn_end handler in index.ts before forcing this patch."
    )

open(path, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
print(f"patch-context-prune: applied to {path}")
PY

node --experimental-strip-types --check "$FILE" >/dev/null 2>&1 &&
    echo "patch-context-prune: syntax OK" ||
    { echo "patch-context-prune: SYNTAX CHECK FAILED — reinstall pi-context-prune" >&2; exit 1; }
