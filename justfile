# Common commands for the pi agent-workflow repo.
#
# These are thin wrappers — install.sh, run.sh and the npm scripts stay the
# source of truth, so a recipe never drifts from what it documents. Anything
# taking *args passes them straight through:
#   just pi -- -n mysession
#   just server -- --port 8000
#   just metrics --all --json
#
# Run `just` (or `just --list`) to see everything.

set shell := ["bash", "-euo", "pipefail", "-c"]

ui := "obs/ui"

# List the available recipes.
default:
    @just --list --unsorted

# ── setup ────────────────────────────────────────────────────────────────────

# Full setup: pi CLI, deps, types, context pruner, skills, dashboard build.
[group('setup')]
install *args:
    ./install.sh {{ args }}

# Create .env from example.env. Never overwrites an existing one.
[group('setup')]
env:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then
        echo ".env already exists — left untouched (see example.env for new keys)."
    else
        cp example.env .env
        echo "created .env from example.env — edit it before running."
    fi

# Link pi's types into node_modules (the tests and typecheck resolve them).
[group('setup')]
types:
    npm run -s setup:types

# ── run ──────────────────────────────────────────────────────────────────────

# Launch pi with this repo's workflow extensions.
[group('run')]
pi *args:
    ./run.sh {{ args }}

# pi + the observability dashboard server.
[group('run')]
obs *args:
    ./run.sh --obs {{ args }}

# The dashboard server only, in the background. Prints a pid to stop.
[group('run')]
server *args:
    ./run.sh --server {{ args }}

# Restart the dashboard server (tsx has no hot-reload — use after editing obs/).
[group('run')]
restart:
    ./run.sh --restart

# Stop the dashboard server.
[group('run')]
stop:
    ./run.sh --stop

# Scope obs to THIS project instead of the shared global sink.
[group('run')]
obs-project:
    ./run.sh --obs --project

# Start a persistent background pi session (hosted in tmux).
[group('run')]
bg name="":
    ./run.sh --bg {{ name }}

# Attach to a background session (Ctrl-b d detaches; it keeps running).
[group('run')]
attach name="":
    ./run.sh --attach {{ name }}

# List background pi sessions.
[group('run')]
bg-list:
    ./run.sh --bg-list

# Kill a background session.
[group('run')]
bg-stop name="":
    ./run.sh --bg-stop {{ name }}

# The Telegram bridge (foreground).
[group('run')]
bridge:
    ./run.sh --bridge

# Stop the Telegram bridge (clears its lock).
[group('run')]
bridge-stop:
    ./run.sh --bridge-stop

# ── dashboard (obs/ui) ───────────────────────────────────────────────────────

# Install the dashboard's dependencies.
[group('ui')]
ui-install:
    cd {{ ui }} && npm install

# obs/ui/dist is not tracked, so a fresh clone has no dashboard until this runs,
# and the server keeps serving the previous bundle until it runs again.

# Build the dashboard — obs-server serves this output (untracked; rebuild after edits).
[group('ui')]
ui-build:
    cd {{ ui }} && npm run build

# Dashboard dev server on :5174, proxying /api to the obs-server.
[group('ui')]
ui-dev:
    cd {{ ui }} && npm run dev

# Serve the built dashboard on :5175 (same /api proxy).
[group('ui')]
ui-preview:
    cd {{ ui }} && npm run preview

# ── test ─────────────────────────────────────────────────────────────────────

# Root unit suite (utils + obs).
[group('test')]
test *args:
    npm test {{ args }}

# Dashboard unit suite.
[group('test')]
test-ui:
    cd {{ ui }} && npm test

# Typecheck the Node side (obs/ui is excluded — it has its own).
[group('test')]
typecheck:
    npm run typecheck

# Typecheck the dashboard.
[group('test')]
typecheck-ui:
    cd {{ ui }} && npx tsc -b --noEmit

# Parse-check the obs server without a full tsc pass.
[group('test')]
check:
    node --experimental-strip-types --check obs/obs-server.ts

# Everything: both suites, both typechecks, and a dashboard build.
[group('test')]
verify: test test-ui typecheck typecheck-ui ui-build
    @echo "all checks passed"

# Python skill tests.
[group('test')]
test-skills:
    npm run test:linear
    npm run test:atlassian

# ── metrics ──────────────────────────────────────────────────────────────────

# Offline run analyzer. `just metrics --all --json`, `just metrics explain --last`.
[group('metrics')]
metrics *args:
    npm run -s metrics -- {{ args }}

# Export the event sink (see obs/obs-export.ts).
[group('metrics')]
export *args:
    npm run -s obs:export -- {{ args }}

# ── docker ───────────────────────────────────────────────────────────────────
# The image is the obs server + dashboard only; it does not run agents. It tails
# the sink your host-side pi runs write. See DOCKER.md.

# Build the image (stage 1 builds the dashboard).
[group('docker')]
docker-build:
    docker build -t pi-obs-server .

# Start the server in Docker (requires PI_OBS_TOKEN).
[group('docker')]
docker-up:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${PI_OBS_TOKEN:-}" ]; then
        echo "PI_OBS_TOKEN is not set — the container would refuse to start." >&2
        echo "Generate one and re-run, e.g.:" >&2
        echo "  export PI_OBS_TOKEN=\$(openssl rand -hex 32) && just docker-up" >&2
        exit 1
    fi
    docker compose up --build

# Stop the Docker server.
[group('docker')]
docker-down:
    docker compose down
