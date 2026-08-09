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
# Idempotent: safe to re-run. `pi update` replaces the package and wipes this, so
# re-run it after upgrading (npm run patch:prune).
set -euo pipefail

PKG="${PI_CONTEXT_PRUNE_DIR:-$HOME/.pi/agent/npm/node_modules/pi-context-prune}"
FILE="$PKG/index.ts"
MARKER="PATCH (agentic-pi): headless sessions must flush per turn"

[[ -f "$FILE" ]] || {
    echo "patch-context-prune: $FILE not found — is pi-context-prune installed?" >&2
    echo "  install with: pi install npm:pi-context-prune" >&2
    exit 1
}

if grep -qF "$MARKER" "$FILE"; then
    echo "patch-context-prune: already applied — nothing to do."
    exit 0
fi

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
