#!/usr/bin/env bash
#
# run.sh — launch pi with this folder's workflow extensions, resolved relative to
# the script. Copy the folder anywhere / to any machine and run it with no per-machine
# config: `./run.sh`. All settings live in `.env` next to this script (loaded
# automatically by the extensions, wherever the folder lives).
#
#   ./run.sh                 # load dispatch + the agent-workflow extension
#   ./run.sh -- <pi args>    # pass extra args straight to pi
#
# Requires: `pi` on PATH. Nothing else — node_modules is only for typecheck/tests.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v pi >/dev/null 2>&1 || {
    echo "run.sh: 'pi' not found on PATH — install pi first." >&2
    exit 1
}

[[ "${1:-}" == "--" ]] && shift

# dispatch.ts first (the workflow depends on it for dispatch_agent/select_agents).
# interactive.ts adds the ask_user tool for the primary session.
EXT=(
    -e "$DIR/extensions/dispatch.ts"
    -e "$DIR/extensions/interactive.ts"
    -e "$DIR/extensions/agent-workflow.ts"
)

# Live observability (Phase 2): with PI_OBS=1 the orchestrator and every
# sub-agent emit ObsEvents to <cwd>/.agent/obs/events.jsonl. Watch them with
# `npm run obs:server -- <project>`. Inert unless PI_OBS=1.
if [[ "${PI_OBS:-}" == "1" || "${PI_OBS:-}" == "true" ]]; then
    EXT+=(-e "$DIR/extensions/obs-live.ts")
fi

exec pi "${EXT[@]}" "$@"
