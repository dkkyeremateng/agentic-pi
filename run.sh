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
#   ./run.sh --restart             # stop the server on $PORT, then start it fresh
#                                  #   (reloads edited utils/obs/*.ts — tsx has no
#                                  #    hot-reload)
#   ./run.sh --stop                # stop the dashboard server on $PORT
#   ./run.sh --obs --project       # scope obs to THIS project: emit to and tail a
#                                  #   per-project sink under ~/.pi/agent/obs/<slug>/
#                                  #   instead of the shared global sink
#   ./run.sh -- <pi args>          # pass extra args straight to pi
#   ./run.sh --obs -- <pi args>
#   ./run.sh --server -- <obs-server args>   # e.g. --port 8000, or a project path
#
# By default obs uses one shared global sink (~/.pi/agent/obs/events.jsonl) so
# every pi instance (any project) streams into a single dashboard; the UI
# separates them by cwd. --project (alias --cwd) instead scopes everything to a
# per-project sink under ~/.pi/agent/obs/<cwd-slug>-<hash>/events.jsonl, named
# like pi's session folder. Setting PI_OBS_SINK in the environment overrides both
# and is respected as-is.
#
# Requires: `pi` on PATH (for pi/--obs). `--obs`/`--server` also need the dev deps
# (`npm install`) and node for the dashboard server (PI_OBS_PORT, default 7616).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PI_OBS_PORT:-7616}"
TSX="$DIR/node_modules/.bin/tsx"

# The dashboard server spawns `pi` for LLM features (judge/explain/summarize).
# When it runs detached (nohup --server), its PATH may not include the version-
# manager bin dir that holds `pi`. Resolve the absolute path here — we're in the
# user's interactive shell — and pass it through so the spawn never ENOENTs.
if [[ -z "${PI_OBS_PI_BIN:-}" ]] && command -v pi >/dev/null 2>&1; then
    export PI_OBS_PI_BIN="$(command -v pi)"
fi

# Mode: pi (default) | both (pi + server) | emit (pi + emission, no server) |
# server (server only). PI_OBS=1 in the environment is equivalent to --obs.
MODE="pi"
[[ "${PI_OBS:-}" == "1" || "${PI_OBS:-}" == "true" ]] && MODE="both"

# Sink scope: global (shared ~/.pi sink) | project (this cwd's sink). --project.
SINK_SCOPE="global"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --obs) MODE="both"; shift ;;
        --emit) MODE="emit"; shift ;;
        --server | --obs-only) MODE="server"; shift ;;
        --restart) MODE="restart"; shift ;;
        --stop) MODE="stop"; shift ;;
        --project | --cwd) SINK_SCOPE="project"; shift ;;
        --) shift; break ;;
        *) break ;;
    esac
done

# --project/--cwd scopes obs to the current directory: give it a dedicated sink
# under ~/.pi/agent/obs/, named like pi's per-project session folder — a slug of
# the absolute cwd (/ → -) plus a short hash of the path for uniqueness, e.g.
#   ~/.pi/agent/obs/-Users-me-Documents-Dev-slf-ai-p-0d3c1ef2/events.jsonl
# Both the collector and the server honor PI_OBS_SINK, so exporting it here covers
# every mode (and sub-agents inherit it). An explicit PI_OBS_SINK always wins.
if [[ "$SINK_SCOPE" == "project" && -z "${PI_OBS_SINK:-}" ]]; then
    obs_slug="$(printf '%s' "$PWD" | tr '/' '-')"
    if command -v shasum >/dev/null 2>&1; then
        obs_hash="$(printf '%s' "$PWD" | shasum | cut -c1-8)"
    else
        obs_hash="$(printf '%s' "$PWD" | sha1sum | cut -c1-8)"
    fi
    export PI_OBS_SINK="$HOME/.pi/agent/obs/${obs_slug}-${obs_hash}/events.jsonl"
    echo "run.sh: obs sink → $PI_OBS_SINK"
fi

# ── stop / restart the background server ─────────────────────────────────────
# Stop whatever is serving obs on $PORT (the listener) plus its tsx runner.
# Sets STOPPED=1 if anything was actually running.
STOPPED=0
stop_server() {
    local pids
    pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
        kill $pids 2>/dev/null || true
        STOPPED=1
    fi
    if pkill -f "obs-server.ts --port $PORT" 2>/dev/null; then
        STOPPED=1
    fi
}
if [[ "$MODE" == "stop" ]]; then
    stop_server
    echo "run.sh: $([[ "$STOPPED" == 1 ]] && echo "stopped the obs-server on port $PORT." || echo "no obs-server was running on port $PORT.")"
    exit 0
fi
# --restart restarts a running server, or cold-starts one if none is running.
if [[ "$MODE" == "restart" ]]; then
    stop_server
    if [[ "$STOPPED" == 1 ]]; then
        echo "run.sh: stopped the running server on port $PORT — restarting…"
        sleep 1 # let the port free before rebinding
    else
        echo "run.sh: no server on port $PORT — starting it…"
    fi
    MODE="server" # fall through to a fresh start
fi

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
# footer.ts renders the status bar from the state agent-workflow.ts publishes, so
# it loads after it (order isn't critical — the state is read per render frame).
EXT=(
    -e "$DIR/extensions/dispatch.ts"
    -e "$DIR/extensions/interactive.ts"
    -e "$DIR/extensions/agent-workflow.ts"
    -e "$DIR/extensions/footer.ts"
    -e "$DIR/extensions/revert.ts"
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
