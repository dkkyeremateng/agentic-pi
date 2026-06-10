#!/usr/bin/env bash
# Thin wrapper for the agent observability analyzer. Self-locates the config
# repo root (two levels up from this skill dir) and runs the CLI with tsx, so it
# works from any project's cwd.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$REPO" tsx "$REPO/utils/obs-cli.ts" "$@"
