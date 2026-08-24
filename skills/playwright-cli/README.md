# Playwright CLI Skill — Value Proposition

A token-efficient wrapper around [`playwright-cli`](https://www.npmjs.com/package/@playwright/cli)
(`@playwright/cli`) for driving a browser from the shell — navigating, reading
rendered content, filling forms, asserting UI behaviour, scraping, and
screenshots. It keeps no MCP tool schemas in context: you run one command and get
back plain text or JSON.

## What the playwright-cli skill is

`playwright-cli` is a thin convention over the CLI of the same name (no custom
script). It standardizes the parts that are easy to get wrong — always using a
**named session** so cookies and storage persist across calls, driving elements by
the `ref` a `snapshot` hands you rather than by guessed selectors, keeping every
artifact under `.playwright-cli/`, and closing sessions when the task ends.

Sessions are the core idea. Each `-s=<name>` is an independent browser with its
own persistent profile, so several can run at once without sharing cookies or
element refs.

## Core capabilities

- **Token-efficient CLI** — no tool schemas in context; text or JSON out, `--json`
  and `--raw` for machine-readable output.
- **Headless by default** — pass `--headed` to `open` when you need to watch.
- **Named parallel sessions** — `-s=<name>` gives each task its own browser and
  profile; `list`, `close-all` and `kill-all` manage them.
- **Snapshot-driven interaction** — `snapshot` returns element refs; `click`,
  `fill`, `hover`, `select`, `check`, `upload` and `drag` act on those refs
  instead of hand-written selectors.
- **Network inspection** — `requests` numbers everything the page fetched, then
  `request <n>`, `request-body <n>` and `response-body <n>` open one up. `route`
  and `unroute` mock traffic.
- **Storage and auth** — `state-save` / `state-load` persist a logged-in session;
  `cookie-*`, `localstorage-*` and `sessionstorage-*` read and write directly.
- **Evidence capture** — `screenshot`, `pdf`, `console`, `tracing-start/stop` and
  `video-start/stop`.
- **Vision mode (opt-in)** — `PLAYWRIGHT_MCP_CAPS=vision` returns screenshots as
  images in context rather than only writing them to disk. Costs tokens; use it
  when visual judgement is actually needed.

## When to use this instead of `chrome-agent`

The two browser skills are not interchangeable.

- **This skill** owns a browser start-to-finish: you open it, drive it, throw it
  away. That fits research, scraping, UI test flows and user-story QA — most
  browser work.
- **[`chrome-agent`](../chrome-agent/)** drives a *live* Chrome over the DevTools
  Protocol. Reach for it when you did not start the browser (a human is driving
  it, or it is already running), when you need events **as they happen** rather
  than a state you can read once, or when you need raw CDP surface this
  abstraction does not expose.

## Installation

Installed by the repo's [`install.sh`](../../install.sh) (skip with
`--no-playwright`), or by hand:

```bash
npm install -g @playwright/cli
playwright-cli install-browser chromium
```

Verify with `playwright-cli --version`.

## Output location

Two separate mechanisms, and the difference is the usual source of stray files in
the project root:

- **`outputDir`** governs **auto-named** output (a bare `screenshot`, traces).
  The CLI reads `.playwright/cli.config.json`; point `outputDir` at
  `.playwright-cli/`.
- **Explicit filenames** (`--filename=…`, `state-save <file>`) resolve against the
  **cwd**, *not* `outputDir` — so always prefix them with `.playwright-cli/`.

Add both `.playwright-cli/` (output) and `.playwright/` (config) to `.gitignore`.

## Safety and compliance notes

- Respect site terms and `robots.txt`; do not scrape where it is prohibited, and
  do not hammer a host — reuse one session per site.
- Keep credentials out of prompts and logs. A `state-save` file contains live
  session cookies; treat it as a secret and keep it out of git.
- Close every session when done (`close`, or `close-all`). Sessions are real
  browser processes that persist until closed.

## Quick-start usage snippet

```bash
# One-time per project, so auto-named output lands in .playwright-cli/
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

# Open a named, persistent session
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 \
  playwright-cli -s=demo open https://example.com --persistent

# Read the page, then act on the refs the snapshot returns
playwright-cli -s=demo snapshot
playwright-cli -s=demo click e12
playwright-cli -s=demo fill e7 "demo-user"
playwright-cli -s=demo press Enter

# Evidence, and what the page actually fetched
playwright-cli -s=demo screenshot --filename=.playwright-cli/after-login.png
playwright-cli -s=demo console
playwright-cli -s=demo requests

# Always close
playwright-cli -s=demo close
```

See [SKILL.md](SKILL.md) for the command reference, and
`playwright-cli --help [command]` for per-command flags.
