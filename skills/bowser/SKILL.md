---
name: bowser
description: Headless browser automation using Playwright CLI. Use when you need headless browsing, parallel browser sessions, UI testing, screenshots, web scraping, or browser automation that can run in the background. Keywords - playwright, headless, browser, test, screenshot, scrape, parallel.
allowed-tools: Bash
---

# Playwright Bowser

## Purpose

Automate browsers using `playwright-cli` — a token-efficient CLI for Playwright. Runs headless by default, supports parallel sessions via named sessions (`-s=`), and doesn't load tool schemas into context.

## Key Details

- **Headless by default** — pass `--headed` to `open` to see the browser
- **Parallel sessions** — use `-s=<name>` to run multiple independent browser instances
- **Persistent profiles** — cookies and storage state preserved between calls
- **Token-efficient** — CLI-based, no accessibility trees or tool schemas in context
- **Vision mode** (opt-in) — set `PLAYWRIGHT_MCP_CAPS=vision` to receive screenshots as image responses in context instead of just saving to disk

## Sessions

**Always use a named session.** Derive a short, descriptive kebab-case name from the user's prompt. This gives each task a persistent browser profile (cookies, localStorage, history) that accumulates across calls.

```bash
# Derive session name from prompt context:
# "test the checkout flow on mystore.com" → -s=mystore-checkout
# "scrape pricing from competitor.com"    → -s=competitor-pricing
# "UI test the login page"               → -s=login-ui-test

playwright-cli -s=mystore-checkout open https://mystore.com --persistent
playwright-cli -s=mystore-checkout snapshot
playwright-cli -s=mystore-checkout click e12
```

Managing sessions:
```bash
playwright-cli list                                     # list all sessions
playwright-cli close-all                                # close all sessions
playwright-cli -s=<name> close                          # close specific session
playwright-cli -s=<name> delete-data                    # wipe session profile
```

## Quick Reference

```
Core:       open [url], goto <url>, click <ref>, fill <ref> <text>, type <text>, snapshot, screenshot [ref], close
Navigate:   go-back, go-forward, reload
Keyboard:   press <key>, keydown <key>, keyup <key>
Mouse:      mousemove <x> <y>, mousedown, mouseup, mousewheel <dx> <dy>
Tabs:       tab-list, tab-new [url], tab-close [index], tab-select <index>
Save:       screenshot [ref], pdf, screenshot --filename=.playwright-cli/f  (prefix .playwright-cli/)
Storage:    state-save, state-load, cookie-*, localstorage-*, sessionstorage-*
Network:    route <pattern>, route-list, unroute, network
DevTools:   console, run-code <code>, tracing-start/stop, video-start/stop
Sessions:   -s=<name> <cmd>, list, close-all, kill-all
Config:     open --headed, open --browser=chrome, resize <w> <h>
```

## Workflow

1. Derive a session name from the user's prompt and open with `--persistent` to preserve cookies/state. First ensure `.playwright/cli.config.json` exists (see [Configuration](#configuration--output-location)) so generated files land in `.playwright-cli/`, not the project root. Always set the viewport via env var at launch:
```bash
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 playwright-cli -s=<session-name> open <url> --persistent
# or headed:
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 playwright-cli -s=<session-name> open <url> --persistent --headed
# or with vision (screenshots returned as image responses in context):
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 PLAYWRIGHT_MCP_CAPS=vision playwright-cli -s=<session-name> open <url> --persistent
```

3. Get element references via snapshot:
```bash
playwright-cli snapshot
```

4. Interact using refs from snapshot:
```bash
playwright-cli click <ref>
playwright-cli fill <ref> "text"
playwright-cli type "text"
playwright-cli press Enter
```

5. Capture results — **always write under `.playwright-cli/`** (see Configuration):
```bash
playwright-cli screenshot                                # auto-named -> .playwright-cli/<name>.png (via outputDir)
playwright-cli screenshot --filename=.playwright-cli/output.png   # -> .playwright-cli/output.png
```
**Important:** an explicit `--filename` is resolved relative to the **cwd**, NOT
`outputDir` — so `--filename=output.png` lands in the project root. When you name
an output file (screenshot, `pdf`, `state-save`, etc.), prefix it with
`.playwright-cli/`, or omit `--filename` to let it auto-name into `.playwright-cli/`.

6. **Always close the session when done.** This is not optional — close the named session after finishing your task:
```bash
playwright-cli -s=<session-name> close
```

## Configuration & output location

Keep all bowser output under `.playwright-cli/` in the working directory, never the
project root. Two parts to this:

1. **`outputDir`** governs **auto-named** outputs (a `screenshot` with no
   `--filename`, traces, default artifacts). The CLI auto-loads its config from
   `.playwright/cli.config.json` (this config-file path is fixed by the CLI); create
   it once per project (idempotent) so `outputDir` points at `.playwright-cli/`
   before opening a session:
2. **Explicit filenames** (`--filename=…`, `state-save <file>`, etc.) are relative
   to the **cwd**, not `outputDir` — so always prefix them with `.playwright-cli/`.

```bash
mkdir -p .playwright
cat > .playwright/cli.config.json <<'JSON'
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": { "headless": true },
    "contextOptions": { "viewport": { "width": 1440, "height": 900 } }
  },
  "outputDir": ".playwright-cli"
}
JSON
```

Without this, the CLI falls back to a `.playwright-cli/` (or `.playwright-mcp/`)
directory it creates in the cwd. Point at a different config with
`--config path/to/config.json`. Add `.playwright-cli/` (outputs) and `.playwright/`
(config) to `.gitignore`.

## Full Help

Run `playwright-cli --help` or `playwright-cli --help <command>` for detailed command usage.

See [docs/playwright-cli.md](docs/playwright-cli.md) for full documentation.
