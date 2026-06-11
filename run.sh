#!/usr/bin/env bash
#
# run.sh — launch pi with this folder's workflow extensions, resolved relative to
# the script. Copy the folder anywhere / to any machine and run it with no per-machine
# config: `./run.sh`. All settings live in `.env` next to this script (loaded
# automatically by the extensions, wherever the folder lives).
#
#   ./run.sh                       # pi only
#   ./run.sh --obs                 # pi + the observability dashboard server
#   ./run.sh --emit                # pi with emission on, but DON'T start a server
#                                  #   (use when a `--server` is already running)
#   ./run.sh --server              # the dashboard server only (background; no pi)
#   ./run.sh -- <pi args>          # pass extra args straight to pi
#   ./run.sh --obs -- <pi args>
#   ./run.sh --server -- <obs-server args>   # e.g. --port 8000, or a project path
#
# Requires: `pi` on PATH (for pi/--obs). `--obs`/`--server` also need the dev deps
# (`npm install`) and node for the dashboard server (PI_OBS_PORT, default 7616).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PI_OBS_PORT:-7616}"
TSX="$DIR/node_modules/.bin/tsx"

# Mode: pi (default) | both (pi + server) | emit (pi + emission, no server) |
# server (server only). PI_OBS=1 in the environment is equivalent to --obs.
MODE="pi"
[[ "${PI_OBS:-}" == "1" || "${PI_OBS:-}" == "true" ]] && MODE="both"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --obs) MODE="both"; shift ;;
        --emit) MODE="emit"; shift ;;
        --server | --obs-only) MODE="server"; shift ;;
        --) shift; break ;;
        *) break ;;
    esac
done

# ── server only ──────────────────────────────────────────────────────────────
if [[ "$MODE" == "server" ]]; then
    [[ -x "$TSX" ]] || {
        echo "run.sh: the dashboard server needs dev deps — run 'npm install' in $DIR." >&2
        exit 1
    }
    # Background + detached so it keeps running and frees the terminal. Remaining
    # args (e.g. --port 8000, or a project path) pass through.
    nohup "$TSX" "$DIR/utils/obs/obs-server.ts" --port "$PORT" "$@" \
        >"$DIR/.obs-server.log" 2>&1 &
    SP=$!
    disown 2>/dev/null || true
    echo "run.sh: observability dashboard → http://127.0.0.1:$PORT" \
        "(pid $SP, log: $DIR/.obs-server.log)"
    echo "run.sh: stop it with  kill $SP"
    exit 0
fi

# ── pi (and optionally the server) ───────────────────────────────────────────
command -v pi >/dev/null 2>&1 || {
    echo "run.sh: 'pi' not found on PATH — install pi first." >&2
    exit 1
}

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
# Both and emit turn on emission; only "both" also starts a dashboard server.
SERVER_PID=""
if [[ "$MODE" == "both" || "$MODE" == "emit" ]]; then
    export PI_OBS=1
    EXT+=(-e "$DIR/extensions/obs-live.ts")
fi
if [[ "$MODE" == "both" ]]; then
    # Start the dashboard server in the background, tailing the shared sink.
    if [[ -x "$TSX" ]]; then
        "$TSX" "$DIR/utils/obs/obs-server.ts" --port "$PORT" \
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
