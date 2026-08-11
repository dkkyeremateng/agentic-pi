#!/usr/bin/env bash
#
# patch-context-prune.sh — make pi-context-prune actually prune SPAWNED SUB-AGENTS.
#
# The bug (pi-context-prune 1.2.0): in `agent-message` mode — the recommended and
# default trigger — pruning flushes only on the FINAL assistant message:
#
#     pi.on("message_end", …)  →  if (!isFinalAssistantMessage(event.message)) return;
#
# That is a sensible trigger for an interactive session, where the agent replies,
# stops, and waits for you. It is meaningless for a spawned sub-agent, which runs
# `pi -p`: ONE user turn, dozens of tool-calling assistant messages, and exactly one
# final assistant message — at the very end of the run. The flush therefore lands
# after all the work is done, and every turn's tool output stays in context for the
# whole phase.
#
# Measured on this repo's workflow before the patch: a phase-implementer reached
# 252,289 of a 256,000-token window (98.6%) and produced a turn with
# stopReason "length" (real truncation), while 40–105 captured batches waited to be
# summarized in a single end-of-run flush that reclaimed nothing useful.
#
# The patch: in the turn_end handler, also flush immediately when the session is
# headless (ctx.hasUI === false) and the mode is `agent-message`. That branch only
# runs when the turn HAD tool results — i.e. mid-run — so it does not touch the
# post-shutdown text-only turn the handler already guards against. Interactive
# sessions are unaffected and keep their prefix-cache-friendly batching.
#
# !! DO NOT APPLY — THIS PATCH IS REVERTED. It is kept only so the failure is
# reproducible and the revert path stays tested.
#
# Per-turn flushing is destructive for an agent that must ACT on what it just read.
# The pruner summarizes a turn's tool results away at turn_end, but in an agentic
# loop turn N+1 IS the model acting on turn N's output — so the content is gone
# exactly when it is needed. Interactively this is invisible (the model has already
# answered before the next user message); headless it is fatal.
#
# Observed live: a planner asked to read a 113KB spec looped ~30 times over the same
# file — `read`, `python3 read_text`, `dd | od`, `head -c | base64`, `node`, and
# finally ROT13 (`tr 'A-Za-z' 'N-ZA-Mn-za-m'`), an escalation that only makes sense
# if the model believes its output is being filtered. Context stayed pinned at
# 8-9k tokens across 27 turns (turn 2 spiked to 19,602 as the read landed, then fell
# back to 8,580) while the pruner logged 31 flushes and 21 summaries.
#
# The real fix is a keep-recent window — never prune the last N turns — so a tool
# result always survives long enough to be used. Until that exists, leave the
# pruner alone: the original bug only wastes context, this "fix" loses work.
#
# Idempotent: safe to re-run. `--revert` restores the upstream source.
#   npm run patch:prune -- --revert
set -euo pipefail

PKG="${PI_CONTEXT_PRUNE_DIR:-$HOME/.pi/agent/npm/node_modules/pi-context-prune}"
FILE="$PKG/index.ts"
MARKER="PATCH (agentic-pi): headless sessions must flush per turn"

[[ -f "$FILE" ]] || {
    echo "patch-context-prune: $FILE not found — is pi-context-prune installed?" >&2
    echo "  install with: pi install npm:pi-context-prune" >&2
    exit 1
}

# --revert restores the upstream single-flush behaviour. Needed because per-turn
# flushing is destructive for an agent that must ACT on what it just read: see the
# header note above and `npm run patch:prune -- --revert`.
if [[ "${1:-}" == "--revert" || "${1:-}" == "--unpatch" ]]; then
    if ! grep -qF "$MARKER" "$FILE"; then
        echo "patch-context-prune: not applied — nothing to revert."
        exit 0
    fi
    python3 - "$FILE" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# Match the patched block from our marker comment through the `} else {` that
# closes the widened condition, and restore the upstream two-line original.
PATCHED = re.compile(
    r"[ \t]*// PATCH \(agentic-pi\): headless sessions must flush per turn\.\n"
    r"(?:[ \t]*//.*\n)*"
    r"[ \t]*const headless = ctx\?\.hasUI === false;\n"
    r"[ \t]*if \(\n"
    r"[ \t]*currentConfig\.value\.pruneOn === \"every-turn\" \|\|\n"
    r"[ \t]*\(headless && currentConfig\.value\.pruneOn === \"agent-message\"\)\n"
    r"[ \t]*\) \{\n"
)
ORIGINAL = '    if (currentConfig.value.pruneOn === "every-turn") {\n'

if not PATCHED.search(src):
    sys.exit(
        "patch-context-prune: marker present but the patched block does not match.\n"
        "  Revert index.ts from your package manager instead (pi install npm:pi-context-prune)."
    )

open(path, "w", encoding="utf-8").write(PATCHED.sub(ORIGINAL, src, count=1))
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

echo "patch-context-prune: WARNING — this patch is known to break headless runs." >&2
echo "  Per-turn flushing removes a turn's tool output before the next turn can use" >&2
echo "  it; a planner reading a large file loops until it gives up. See the header." >&2
echo "  Revert with: npm run patch:prune -- --revert" >&2

python3 - "$FILE" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

OLD = '''    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {'''

NEW = '''    // PATCH (agentic-pi): headless sessions must flush per turn.
    // `agent-message` waits for isFinalAssistantMessage, but a spawned sub-agent
    // runs `pi -p`: ONE user turn, dozens of tool-calling assistant messages, and
    // exactly one final assistant message — at the very end of the run. So the
    // flush lands after all the work is done, and every turn's tool output sits in
    // context for the whole phase. Measured: a phase-implementer reached 252,289 of
    // a 256,000-token window (98.6%) and truncated a turn, while ~40-105 batches
    // waited to be summarized in one useless end-of-run flush.
    // Safe here: this branch only runs when the turn HAD tool results, i.e. mid-run,
    // not the post-shutdown text-only turn the guard above already returns on.
    const headless = ctx?.hasUI === false;
    if (
      currentConfig.value.pruneOn === "every-turn" ||
      (headless && currentConfig.value.pruneOn === "agent-message")
    ) {
      await flushPending(ctx, { delivery: "session" });
    } else {'''

if OLD not in src:
    sys.exit(
        "patch-context-prune: anchor not found — pi-context-prune has changed.\n"
        "  Re-check the turn_end handler in index.ts before forcing this patch."
    )

open(path, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
print(f"patch-context-prune: applied to {path}")
PY

node --experimental-strip-types --check "$FILE" >/dev/null 2>&1 &&
    echo "patch-context-prune: syntax OK" ||
    { echo "patch-context-prune: SYNTAX CHECK FAILED — restore from your package manager" >&2; exit 1; }
