#!/usr/bin/env bash
#
# install.sh — set up the pi agent-workflow on macOS / Linux.
#
# Installs everything needed to RUN and DEVELOP the workflow + observability
# server, including building its dashboard (obs/ui) — that build is a derived
# artifact, not in the repo, so the server has no UI to serve until it is made.
#
# What it does:
#   1. checks Node.js + npm (required) and python3 (for skills; warn-only)
#   2. installs tmux (for './run.sh --bg' background sessions; best-effort)
#   3. installs the global `pi` CLI (@earendil-works/pi-coding-agent)
#   4. `npm install` — the repo's dev deps (tsx/tsc) for the obs server + tests
#   5. links pi's types into node_modules (npm run setup:types)
#   6. installs pi-context-prune (recommended context manager) and patches
#      pi-tui's renderer (stale-row fix; skip with --no-tui-patch)
#   7. installs the skill dependencies (all best-effort, never fatal):
#        - links the atlassian / linear / lsp CLIs onto PATH (~/.local/bin)
#        - jq (JSON piping) and the gh CLI (github skill)
#        - LSP servers: pyright, typescript-language-server, typescript,
#          intelephense (npm), gopls (if Go is present)  [skip: --no-lsp-servers]
#        - playwright-cli (@playwright/cli) + a chromium browser (playwright-cli
#          skill)
#          [skip: --no-playwright]
#        - chrome-agent (PyPI, via uv/pipx/pip) — drives a SYSTEM Chrome over
#          CDP (chrome-agent skill)  [skip: --no-chrome-agent]
#   8. creates .env from example.env (if missing)
#   9. a light smoke check
#
# Usage:
#   ./install.sh                  # full setup, then print next steps
#   ./install.sh --run            # setup, then launch pi + the observability API server (run.sh --obs)
#   ./install.sh --no-pi          # don't (re)install the global pi CLI
#   ./install.sh --no-tmux        # don't install tmux (background sessions need it)
#   ./install.sh --no-context-prune
#   ./install.sh --no-tui-patch     # don't patch pi-tui (dashboard stale-row fix)
#   ./install.sh --no-skills      # skip ALL skill dependencies (section 7)
#   ./install.sh --no-lsp-servers # skip the language servers (lsp skill)
#   ./install.sh --no-playwright  # skip playwright-cli + browser (playwright-cli skill)
#   ./install.sh --no-chrome-agent # skip chrome-agent (chrome-agent skill)
#   PI_PKG=@earendil-works/pi-coding-agent ./install.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PI_PKG="${PI_PKG:-@earendil-works/pi-coding-agent}"
INSTALL_PI=1
WITH_PRUNE=1
WITH_TUI_PATCH=1
WITH_TMUX=1
WITH_SKILLS=1
WITH_LSP_SERVERS=1
WITH_PLAYWRIGHT=1
WITH_CHROME_AGENT=1
RUN=0

for arg in "$@"; do
    case "$arg" in
        --run | --obs) RUN=1 ;;
        --no-pi) INSTALL_PI=0 ;;
        --no-tmux) WITH_TMUX=0 ;;
        --no-context-prune) WITH_PRUNE=0 ;;
        --no-tui-patch) WITH_TUI_PATCH=0 ;;
        --no-skills) WITH_SKILLS=0 ;;
        --no-lsp-servers) WITH_LSP_SERVERS=0 ;;
        --no-playwright) WITH_PLAYWRIGHT=0 ;;
        --no-chrome-agent) WITH_CHROME_AGENT=0 ;;
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

# `apt-get update` at most once per run (fresh containers need it before install).
APT_UPDATED=0
apt_update_once() {
    [ "$APT_UPDATED" -eq 1 ] && return 0
    sudo apt-get update -y && APT_UPDATED=1
}

# Best-effort install of a system package whose name is the SAME across managers
# (tmux, jq). Returns non-zero (so the caller warns) when no known manager is
# available or the install fails. For names that differ per manager, write a
# dedicated helper (see install_gh).
sys_install() {
    local pkg="$1"
    case "$OS" in
        Darwin)
            have brew || return 1
            brew install "$pkg"
            ;;
        Linux)
            if have apt-get; then apt_update_once && sudo apt-get install -y "$pkg"
            elif have dnf; then sudo dnf install -y "$pkg"
            elif have yum; then sudo yum install -y "$pkg"
            elif have pacman; then sudo pacman -Sy --noconfirm "$pkg"
            elif have zypper; then sudo zypper install -y "$pkg"
            elif have apk; then sudo apk add "$pkg"
            else return 1
            fi
            ;;
        *) return 1 ;;
    esac
}

# The GitHub CLI (github skill). Package name is `gh` on most managers but
# `github-cli` on Arch/Alpine, so it needs its own mapping.
install_gh() {
    case "$OS" in
        Darwin)
            have brew || return 1
            brew install gh
            ;;
        Linux)
            if have apt-get; then apt_update_once && sudo apt-get install -y gh
            elif have dnf; then sudo dnf install -y gh
            elif have yum; then sudo yum install -y gh
            elif have pacman; then sudo pacman -Sy --noconfirm github-cli
            elif have zypper; then sudo zypper install -y gh
            elif have apk; then sudo apk add github-cli
            else return 1
            fi
            ;;
        *) return 1 ;;
    esac
}

# A SYSTEM Chrome/Chromium, which is what the chrome-agent skill drives. These
# are the exact paths chrome-agent's launcher probes (chrome_agent/launcher.py
# _platform_candidates) — it does not consult $PATH, and it cannot see the
# chromium playwright downloads into ~/.cache/ms-playwright for the
# playwright-cli skill. So the two browser skills have genuinely separate browser needs.
find_system_chrome() {
    local p
    for p in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium" \
        /usr/bin/google-chrome /usr/bin/google-chrome-stable \
        /usr/bin/chromium-browser /usr/bin/chromium /snap/bin/chromium; do
        [ -x "$p" ] && printf '%s\n' "$p" && return 0
    done
    return 1
}

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

# 2b. tmux — hosts persistent background pi sessions (`./run.sh --bg`). Optional;
#     installed best-effort and never fatal (skip with --no-tmux).
if [ "$WITH_TMUX" -eq 0 ]; then
    say "skipping tmux (--no-tmux) — './run.sh --bg' background sessions won't be available"
elif have tmux; then
    say "tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
else
    say "installing tmux (for './run.sh --bg' background sessions)"
    if sys_install tmux && have tmux; then
        say "tmux → $(command -v tmux)"
    else
        warn "couldn't auto-install tmux — './run.sh --bg' background sessions need it. Install manually:
    macOS:  brew install tmux
    Linux:  sudo apt install tmux   (or dnf/yum/pacman/zypper/apk)"
    fi
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

# 4. repo dev dependencies (tsx, typescript, @types/node) AND the obs/ui
#    workspace's, which this one install covers — obs/ui is an npm workspace, so
#    it has no separate install step.
say "installing repo dev dependencies (npm install)"
npm install --no-audit --no-fund

# 4b. the obs dashboard build. Its output is a derived artifact and is not in the
#     repo, so it must be produced here or the dashboard route serves a 503
#     telling you to run exactly this. Warn-only: the obs server and its /api are
#     fully usable without a UI, so a failed UI build must not abort the install.
say "building the obs dashboard (obs/ui)"
if npm run build --workspace obs/ui; then
    say "dashboard built → obs/ui/dist"
else
    warn "obs dashboard build failed — the server and /api still work, but the
    dashboard will 503 until you run: npm run build --workspace obs/ui"
fi

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

# 6b. pi-tui renderer patch. Upstream positions the cursor with RELATIVE moves,
#     which terminals clamp at the screen edges; once pi's idea of the cursor
#     drifts off screen the error is inherited by every later frame, so rows stop
#     being overwritten and pile up (duplicated dashboard rows). The patch falls
#     back to an absolute repaint whenever a move would start or land off screen.
#     Only reachable when content is taller than the terminal. `pi update` wipes
#     it -- re-run `npm run patch:tui` after upgrading.
if [ "$WITH_TUI_PATCH" -eq 1 ]; then
    say "patching pi-tui (off-screen cursor-move guard)"
    npm run -s patch:tui ||
        warn "could not patch pi-tui — the dashboard may accumulate stale rows on a scrolled terminal."
else
    say "skipping the pi-tui patch (--no-tui-patch)"
fi

# 7. skill dependencies — everything the bundled skills/ need to run. All
#    best-effort and NEVER fatal: a skill degrades gracefully (or is simply
#    unused) when its dependency is missing. Skip the whole section with
#    --no-skills; skip the heavy pieces with --no-lsp-servers / --no-playwright.
if [ "$WITH_SKILLS" -eq 0 ]; then
    say "skipping skill dependencies (--no-skills)"
else
    say "installing skill dependencies"

    # 7a. atlassian / linear / lsp — Python (stdlib-only) CLIs, put on PATH by
    #     each skill's own installer (symlinks the .py into ~/.local/bin).
    if have python3; then
        for s in atlassian linear lsp; do
            if [ -f "skills/$s/install.sh" ] && bash "skills/$s/install.sh" >/dev/null 2>&1; then
                say "  $s CLI → ~/.local/bin/$s"
            else
                warn "  couldn't link the $s CLI (skills/$s/install.sh)"
            fi
        done
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) warn "  ~/.local/bin is not on your PATH — add it so the atlassian/linear/lsp CLIs resolve" ;;
        esac
    else
        warn "  python3 missing — skipping the atlassian/linear/lsp skill CLIs"
    fi

    # 7b. jq — atlassian/linear/github/lsp pipe their JSON output to it.
    if have jq; then say "  jq present"
    elif sys_install jq && have jq; then say "  jq → $(command -v jq)"
    else warn "  jq not installed — atlassian/linear/github/lsp pipe JSON to jq"
    fi

    # 7c. gh — the github skill's entire surface.
    if have gh; then say "  gh present ($(gh --version 2>/dev/null | head -1))"
    elif install_gh && have gh; then say "  gh → $(command -v gh)"
    else warn "  gh CLI not installed (github skill) — see https://github.com/cli/cli#installation"
    fi

    # 7d. LSP servers — the lsp skill auto-detects by extension and degrades
    #     gracefully when one is missing, so install the common set best-effort.
    if [ "$WITH_LSP_SERVERS" -eq 0 ]; then
        say "  skipping LSP servers (--no-lsp-servers)"
    else
        say "  installing LSP servers (pyright, typescript-language-server, typescript, intelephense)"
        # One at a time so a single unresolved package doesn't block the rest
        # (npm installs a multi-package -g atomically); the lsp skill uses whichever
        # servers are present and degrades gracefully on the ones that aren't.
        for pkg in pyright typescript-language-server typescript intelephense; do
            npm install -g "$pkg" >/dev/null 2>&1 || warn "  'npm i -g $pkg' failed (lsp skill)"
        done
        if have go; then
            say "  installing gopls (Go LSP)"
            go install golang.org/x/tools/gopls@latest ||
                warn "  gopls install failed — the lsp skill's Go support needs it (go install golang.org/x/tools/gopls@latest)"
        else
            warn "  go not found — skipping gopls (the lsp skill's Go support). Install Go, then: go install golang.org/x/tools/gopls@latest"
        fi
    fi

    # 7e. playwright-cli (@playwright/cli) + a browser — the playwright-cli skill. The
    #     package bundles its own version-matched playwright, so install the
    #     chromium build through it (lands in the shared ~/.cache/ms-playwright).
    if [ "$WITH_PLAYWRIGHT" -eq 0 ]; then
        say "  skipping playwright-cli (--no-playwright)"
    else
        if have playwright-cli; then
            say "  playwright-cli present"
        else
            say "  installing playwright-cli (@playwright/cli)"
            npm install -g @playwright/cli || warn "  @playwright/cli install failed — the playwright-cli skill needs it"
        fi
        if have playwright-cli; then
            # Install the browser through the package's OWN bundled (version-matched)
            # playwright, else playwright-cli won't find it. Resolve it from the real
            # binary via node realpath (portable; macOS lacks `readlink -f`), and fall
            # back to the global node_modules root.
            PW_REAL="$(node -e 'try{console.log(require("fs").realpathSync(process.argv[1]))}catch(e){process.exit(1)}' "$(command -v playwright-cli)" 2>/dev/null || true)"
            PW_CLI=""
            if [ -n "$PW_REAL" ] && [ -f "$(dirname "$PW_REAL")/node_modules/playwright/cli.js" ]; then
                PW_CLI="$(dirname "$PW_REAL")/node_modules/playwright/cli.js"
            elif [ -f "$(npm root -g 2>/dev/null)/@playwright/cli/node_modules/playwright/cli.js" ]; then
                PW_CLI="$(npm root -g)/@playwright/cli/node_modules/playwright/cli.js"
            fi
            if [ -n "$PW_CLI" ]; then
                say "  downloading the chromium browser for playwright"
                node "$PW_CLI" install chromium ||
                    warn "  chromium download failed — run: node '$PW_CLI' install chromium"
                if [ "$OS" = Linux ]; then
                    node "$PW_CLI" install-deps chromium >/dev/null 2>&1 ||
                        warn "  playwright system libraries not installed (Linux) — if the browser fails to launch, run: sudo node '$PW_CLI' install-deps chromium"
                fi
            else
                warn "  couldn't locate playwright's browser installer — run: npx --yes playwright install chromium"
            fi
        fi
    fi

    # 7f. chrome-agent (PyPI) — the chrome-agent skill. Drives a system Chrome
    #     over CDP. Needs Python >= 3.11; `uv tool install` is preferred because
    #     it fetches a matching interpreter itself, so it works on hosts whose
    #     system python3 is older (pip/pipx there would just fail the marker).
    if [ "$WITH_CHROME_AGENT" -eq 0 ]; then
        say "  skipping chrome-agent (--no-chrome-agent)"
    elif have chrome-agent; then
        say "  chrome-agent present ($(chrome-agent --version 2>/dev/null | head -1))"
    else
        say "  installing chrome-agent (PyPI)"
        if have uv; then
            uv tool install chrome-agent >/dev/null 2>&1 ||
                warn "  'uv tool install chrome-agent' failed (chrome-agent skill)"
        elif have pipx; then
            pipx install chrome-agent >/dev/null 2>&1 ||
                warn "  'pipx install chrome-agent' failed (chrome-agent skill)"
        elif have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
            python3 -m pip install --user chrome-agent >/dev/null 2>&1 ||
                warn "  'pip install --user chrome-agent' failed (chrome-agent skill)"
        else
            warn "  no installer for chrome-agent — it needs Python >= 3.11. Install uv (https://docs.astral.sh/uv/) then: uv tool install chrome-agent"
        fi
        # uv/pipx both land it in ~/.local/bin. 7a only warns about that
        # directory being off PATH when python3 is present, and uv needs no
        # system python — so re-check here or a uv-only host installs it
        # successfully and never finds it.
        if have chrome-agent; then
            say "  chrome-agent → $(command -v chrome-agent)"
        else
            warn "  chrome-agent still not on PATH — it installs to ~/.local/bin; add that to your PATH"
        fi
    fi

    # The browser it drives is a separate concern from playwright's chromium
    # above: chrome-agent probes fixed system paths and never sees that download.
    if [ "$WITH_CHROME_AGENT" -eq 1 ] && have chrome-agent; then
        if CHROME_BIN="$(find_system_chrome)"; then
            say "  chrome-agent will drive: $CHROME_BIN"
        elif [ "$OS" = Darwin ]; then
            warn "  no system Chrome/Chromium — the chrome-agent skill can't launch. Install one: brew install --cask google-chrome"
        else
            warn "  no system Chrome/Chromium — the chrome-agent skill can't launch. Install google-chrome or chromium with your package manager"
        fi
    fi
fi

# 8. .env
if [ -f .env ]; then
    say ".env already present — leaving it untouched"
elif [ -f example.env ]; then
    cp example.env .env
    say "created .env from example.env — fill in your models / API keys"
else
    warn "no example.env to copy — create a .env with your model/API settings."
fi

# 9. light smoke check (don't fail the install on these)
say "smoke check"
[ -x node_modules/.bin/tsx ] && say "  tsx ready" || warn "  tsx missing from node_modules/.bin"
pi --version >/dev/null 2>&1 && say "  pi runs ($(pi --version 2>/dev/null | head -1))" || warn "  'pi --version' failed"
have tmux && say "  tmux ready (background sessions: ./run.sh --bg)" || warn "  tmux missing — ./run.sh --bg unavailable"
if [ "$WITH_SKILLS" -eq 1 ]; then
    # one compact line: which skill tools resolved on PATH
    present=""; missing=""
    for t in atlassian linear lsp jq gh playwright-cli chrome-agent pyright typescript-language-server intelephense gopls; do
        if have "$t"; then present="$present $t"; else missing="$missing $t"; fi
    done
    [ -n "$present" ] && say "  skills ready:$present"
    [ -n "$missing" ] && warn "  skills missing:$missing (best-effort; skills degrade gracefully)"
fi

printf '\n\033[1;32m✓ install complete\033[0m\n'

# --run: hand off to run.sh --obs (pi + the observability API server). exec so
# pi takes over this process (Ctrl-C goes to pi; run.sh stops the server on exit).
if [ "$RUN" -eq 1 ]; then
    if [ ! -s .env ] || ! grep -vqE '^\s*(#|$)' .env 2>/dev/null; then
        warn ".env looks empty — set a model / API key in it or pi won't have a model to use."
    fi
    say "launching pi with the observability API server (./run.sh --obs) …"
    exec "$DIR/run.sh" --obs
fi

cat <<EOF

Next steps:
  1. edit .env        — set your model(s) and API keys
  2. ./run.sh         — launch pi with the workflow  (add --obs for the dashboard)
     or re-run:  ./install.sh --run   (setup is idempotent; then starts pi + the API server)
     inside pi:  /agent-workflow <your request>
     background: ./run.sh --bg        — persistent session in tmux (attach/steer later)

Skill deps installed above (best-effort): atlassian/linear/lsp CLIs, jq, gh,
LSP servers (pyright/typescript-language-server/typescript/intelephense, +gopls
if Go is present), playwright-cli + chromium, and chrome-agent. Anything that
failed is warned about above and can be re-run — the section is idempotent. Skip
with --no-skills / --no-lsp-servers / --no-playwright / --no-chrome-agent.
  • the atlassian/linear/lsp CLIs live in ~/.local/bin — put it on your PATH
  • gopls needs a Go toolchain; install Go then: go install golang.org/x/tools/gopls@latest
  • chrome-agent drives a SYSTEM Chrome (not playwright's chromium) — install
    Google Chrome or Chromium if the check above warned, then: chrome-agent status

The obs dashboard (obs/ui) was built above into obs/ui/dist (untracked), and the
obs server serves it at http://127.0.0.1:7616/. Rebuild it after changing its
sources — the server reads the build, not the sources:
  cd obs/ui && npm run build                 # or `npm run dev` to work on it
EOF
