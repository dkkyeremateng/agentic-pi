#!/usr/bin/env bash
#
# run.sh — launch pi with this folder's workflow extensions, resolved relative to
# the script. Copy the folder anywhere / to any machine and run it with no per-machine
# config: `./run.sh`. All settings live in `.env` next to this script (loaded
# automatically by the extensions, wherever the folder lives).
#
#   ./run.sh                 # load dispatch + both workflows (agent-pipeline owns the UI)
#   ./run.sh team            # make agent-team own the UI instead
#   ./run.sh -- <pi args>    # pass extra args straight to pi
#
# Requires: `pi` on PATH. Nothing else — node_modules is only for typecheck/tests.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v pi >/dev/null 2>&1 || {
    echo "run.sh: 'pi' not found on PATH — install pi first." >&2
    exit 1
}

# Pick which workflow owns the dashboard chrome (both are loaded either way, so
# /agent-pipeline and /agent-team commands both work). agent-pipeline is the default.
PRIMARY="agent-pipeline"
if [[ "${1:-}" == "team" ]]; then
    PRIMARY="agent-team"
    shift
elif [[ "${1:-}" == "pipeline" ]]; then
    shift
fi
[[ "${1:-}" == "--" ]] && shift

OTHER="agent-team"
[[ "$PRIMARY" == "agent-team" ]] && OTHER="agent-pipeline"

# dispatch.ts first (workflows depend on it); PRIMARY before OTHER so it owns the UI.
exec pi \
    -e "$DIR/extensions/dispatch.ts" \
    -e "$DIR/extensions/$PRIMARY.ts" \
    -e "$DIR/extensions/$OTHER.ts" \
    "$@"
