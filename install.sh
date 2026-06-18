#!/usr/bin/env bash
#
# install.sh — set up the pi agent-workflow on macOS / Linux.
#
# Installs everything needed to RUN and DEVELOP the workflow + observability
# server, EXCLUDING the React dashboard app (pi-obs/), which has its own setup.
#
# What it does:
#   1. checks Node.js + npm (required) and python3 (for skills; warn-only)
#   2. installs the global `pi` CLI (@earendil-works/pi-coding-agent)
#   3. `npm install` — the repo's dev deps (tsx/tsc) for the obs server + tests
#   4. links pi's types into node_modules (npm run setup:types)
#   5. installs pi-context-prune (recommended context manager)
#   6. creates .env from example.env (if missing)
#   7. a light smoke check
#
# Usage:
#   ./install.sh                  # full setup
#   ./install.sh --no-pi          # don't (re)install the global pi CLI
#   ./install.sh --no-context-prune
#   PI_PKG=@earendil-works/pi-coding-agent ./install.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PI_PKG="${PI_PKG:-@earendil-works/pi-coding-agent}"
INSTALL_PI=1
WITH_PRUNE=1

for arg in "$@"; do
    case "$arg" in
        --no-pi) INSTALL_PI=0 ;;
        --no-context-prune) WITH_PRUNE=0 ;;
        -h | --help)
            # print the leading comment header (skip the shebang; stop at code)
            awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"
            exit 0
            ;;
        *)
            echo "install.sh: unknown option '$arg' (try --help)" >&2
            exit 2
            ;;
    esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() {
    printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
    exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
case "$OS" in
    Linux | Darwin) ;;
    *) die "unsupported OS '$OS' — this installer is for Linux and macOS only." ;;
esac
say "Setting up the pi agent-workflow on $OS"

# 1. Node.js + npm (hard requirement — pi is a Node CLI; the obs server + tests
#    run on node/tsx). Installing Node itself is out of scope (too many managers);
#    we check and point you at the usual options.
have node || die "Node.js not found. Install it, then re-run:
    macOS:  brew install node
    Linux:  use nvm (https://github.com/nvm-sh/nvm) or your distro's package manager"
have npm || die "npm not found (it ships with Node.js). Install Node.js and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || warn "Node $(node -v) detected — Node 20+ is recommended."
say "Node $(node -v) · npm $(npm -v)"

# 2. python3 — skills (lsp/linear/atlassian) + Playwright QA. Warn only.
if have python3; then
    say "python3 $(python3 -V 2>&1 | awk '{print $2}')"
else
    warn "python3 not found — the lsp/linear/atlassian skills and browser QA need it."
fi

# 3. global pi CLI
if [ "$INSTALL_PI" -eq 0 ]; then
    have pi || die "--no-pi given but 'pi' isn't on PATH. Install it or drop --no-pi."
    say "pi present (--no-pi) → $(command -v pi)"
else
    if have pi; then say "updating pi ($PI_PKG)"; else say "installing pi ($PI_PKG) globally"; fi
    npm install -g "$PI_PKG" || die "global install of '$PI_PKG' failed.
    Fix npm's global prefix permissions, or run: sudo npm install -g $PI_PKG"
fi
have pi || die "'pi' is still not on PATH — ensure npm's global bin dir is on your PATH."
say "pi → $(command -v pi)"

# 4. repo dev dependencies (tsx, typescript, @types/node) — ROOT ONLY.
#    pi-obs/ is a separate package and is deliberately left out.
say "installing repo dev dependencies (npm install)"
npm install --no-audit --no-fund

# 5. link pi's types so tsc + the tsx tests resolve the pi API
say "linking pi types into node_modules"
npm run -s setup:types || warn "type linking failed — typecheck/tests may not resolve pi types."

# 6. context pruner (recommended; registers in pi's global config)
if [ "$WITH_PRUNE" -eq 1 ]; then
    say "installing pi-context-prune (recommended context manager)"
    pi install npm:pi-context-prune ||
        warn "could not install pi-context-prune — the workflow still runs on pi's built-in compaction."
else
    say "skipping pi-context-prune (--no-context-prune)"
fi

# 7. .env
if [ -f .env ]; then
    say ".env already present — leaving it untouched"
elif [ -f example.env ]; then
    cp example.env .env
    say "created .env from example.env — fill in your models / API keys"
else
    warn "no example.env to copy — create a .env with your model/API settings."
fi

# 8. light smoke check (don't fail the install on these)
say "smoke check"
[ -x node_modules/.bin/tsx ] && say "  tsx ready" || warn "  tsx missing from node_modules/.bin"
pi --version >/dev/null 2>&1 && say "  pi runs ($(pi --version 2>/dev/null | head -1))" || warn "  'pi --version' failed"

printf '\n\033[1;32m✓ install complete\033[0m\n'
cat <<EOF

Next steps:
  1. edit .env        — set your model(s) and API keys
  2. ./run.sh         — launch pi with the workflow  (add --obs for the dashboard)
     inside pi:  /agent-workflow <your request>

Optional (per-language, not installed here):
  • language servers for the 'lsp' skill (pyright, gopls, typescript-language-server, intelephense)
  • 'gh' CLI for the github skill;  Playwright browsers for the 'bowser' skill

Excluded by design — the React dashboard app:
  cd pi-obs && npm install     # set it up separately
EOF
