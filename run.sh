#!/usr/bin/env bash
#
# run.sh — launch pi with this folder's workflow extensions, resolved relative to
# the script. Copy the folder anywhere / to any machine and run it with no per-machine
# config: `./run.sh`. All settings live in `.env` next to this script (loaded
# automatically by the extensions, wherever the folder lives).
#
#   ./run.sh                 # load dispatch + interactive + agent-workflow
#   ./run.sh --obs           # …also turn on observability + start the dashboard
#   ./run.sh -- <pi args>    # pass extra args straight to pi
#   ./run.sh --obs -- <pi args>
#
# Requires: `pi` on PATH. `--obs` also needs the dev deps (`npm install`) and node
# for the dashboard server (PI_OBS_PORT, default 7616).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v pi >/dev/null 2>&1 || {
    echo "run.sh: 'pi' not found on PATH — install pi first." >&2
    exit 1
}

# Observability is on when PI_OBS=1 (env) or `--obs` is passed.
WANT_OBS=0
[[ "${PI_OBS:-}" == "1" || "${PI_OBS:-}" == "true" ]] && WANT_OBS=1
PORT="${PI_OBS_PORT:-7616}"

# Parse leading run.sh flags; everything after `--` (or the first non-flag) goes
# straight to pi.
while [[ $# -gt 0 ]]; do
    case "$1" in
        --obs) WANT_OBS=1; shift ;;
        --) shift; break ;;
        *) break ;;
    esac
done

# dispatch.ts first (the workflow depends on it for dispatch_agent/select_agents).
# interactive.ts adds the ask_user tool for the primary session.
EXT=(
    -e "$DIR/extensions/dispatch.ts"
    -e "$DIR/extensions/interactive.ts"
    -e "$DIR/extensions/agent-workflow.ts"
)

# Live observability (Phase 2): the orchestrator and every sub-agent emit
# ObsEvents to the shared sink (~/.pi/agent/obs/events.jsonl). The obs-live
# collector is gated on PI_OBS=1; subagentExtArgs injects it into sub-agents too.
SERVER_PID=""
if [[ "$WANT_OBS" == "1" ]]; then
    export PI_OBS=1
    EXT+=(-e "$DIR/extensions/obs-live.ts")

    # Start the dashboard server in the background, tailing the shared sink.
    TSX="$DIR/node_modules/.bin/tsx"
    if [[ -x "$TSX" ]]; then
        "$TSX" "$DIR/utils/obs-server.ts" --port "$PORT" \
            >"$DIR/.obs-server.log" 2>&1 &
        SERVER_PID=$!
        # Stop the server when pi exits (normal quit, error, or Ctrl-C).
        trap '[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true' \
            EXIT INT TERM
        echo "run.sh: observability dashboard → http://127.0.0.1:$PORT" \
            "(log: $DIR/.obs-server.log)"
    else
        echo "run.sh: --obs wants the dashboard server but tsx isn't installed;" \
            "run 'npm install' in $DIR. Continuing with emission only (PI_OBS=1)." >&2
    fi
fi

# When we started a background server, run pi in the foreground so the EXIT trap
# can clean it up; otherwise hand the process off with exec.
if [[ -n "$SERVER_PID" ]]; then
    pi "${EXT[@]}" "$@"
else
    exec pi "${EXT[@]}" "$@"
fi
