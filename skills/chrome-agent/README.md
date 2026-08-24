# chrome-agent Skill — Value Proposition

A token-efficient wrapper around the [`chrome-agent`](https://github.com/captivus/chrome-agent)
CLI, which drives a **real Chrome** over the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
There is no abstraction layer and no MCP tool schemas in context: you name a
browser instance, send it a `Domain.method` with a JSON blob, and Chrome answers.

## What the chrome-agent skill is

`chrome-agent` is a thin convention over the CLI of the same name (no custom
script). It standardizes the parts that decide whether a browser task succeeds or
silently does nothing — picking the right channel for the question, discovering
protocol names from the running browser instead of guessing them, and stopping
instances you launched.

The distinguishing property is that the browser is **shared and observable**.
Several agents, or an agent and a human, can work in one Chrome at the same time,
each with isolated event subscriptions — so one participant subscribing to network
traffic does not flood anyone else's stream.

## Core capabilities

- **Full protocol, tracked live** — commands are forwarded straight to Chrome and
  validated against nothing, so any domain your Chrome supports works, including
  surface newer than the installed `chrome-agent`.
- **Two channels, usable together** — one-shot commands (*what something is*) and
  a persistent `attach` session streaming events as JSON lines (*when something
  happens*). They use separate CDP sessions and do not interfere.
- **Live protocol discovery** — `help` reads the schema out of the running
  browser, so it always describes the Chrome you actually have.
- **Trusted input** — `Input.dispatchMouseEvent` and friends enter Chrome's native
  pipeline, reaching cross-origin iframes, overlays and UIs that gate on event
  trust, where a synthetic `element.click()` silently no-ops.
- **Multi-tab targeting** — `--url <substring>` or a target-id prefix; instances
  are tracked in a registry that reflects what is actually running.
- **Shared sessions** — a human browses while an agent watches, or several agents
  coordinate against one browser.
- **Ships its own manual** — `chrome-agent guide --path` prints the path to a
  22KB agent guide bundled with the installed version.

## When to use this instead of `playwright-cli`

The two browser skills are not interchangeable. Reach for **this** skill when any
one of these holds:

- **You did not start the browser** — a Chrome a human is driving, or one already
  running. [`playwright-cli`](../playwright-cli/) cannot see it.
- **The question is *when*, not *what*** — network requests, console errors or
  navigations as they happen, over a period, rather than a state read once.
- **The session belongs to someone else** — a login or authenticated app the user
  already has open.
- **You need raw CDP** — a protocol domain no wrapper exposes, or trusted input
  after a synthetic click did nothing.

Otherwise prefer `playwright-cli`: it is higher level and there is less to
hand-write for scripted, headless, throwaway automation.

## Installation

Installed by the repo's [`install.sh`](../../install.sh) (skip with
`--no-chrome-agent`), or by hand:

```bash
uv tool install chrome-agent
```

Requires **Python >= 3.11** and a **system-installed** Google Chrome or Chromium.
`uv` is preferred over pip/pipx because it fetches a matching interpreter itself,
so it works on hosts whose system `python3` is older. Single runtime dependency
(`websockets`); no Playwright, no browser download.

Note that the chromium `playwright-cli` downloads into `~/.cache/ms-playwright`
does **not** satisfy this — chrome-agent probes fixed system paths
(`/Applications/Google Chrome.app/...`, `/usr/bin/google-chrome`,
`/snap/bin/chromium`, ...) and never consults `PATH`. Verify with
`chrome-agent --version` and `chrome-agent status`.

## Reading the output

Result shapes differ per CDP method — check rather than assume. Three that bite:

- `Runtime.evaluate` with `returnByValue:true` puts the value at **`result.value`**.
- `Page.captureScreenshot` puts base64 PNG bytes at **`data`**, not `result.data`,
  and must be decoded before it proves anything.
- Errors go to **stderr** with a non-zero exit. This matters most under `attach`:
  a wrong instance name writes to stderr and exits with empty stdout, which looks
  exactly like a quiet page. Append `2>&1` when capturing a stream.

## Safety and compliance notes

- **Stop what you launch.** An instance is a full Chrome process that keeps
  running and accumulating memory until stopped. `chrome-agent stop <instance>`,
  then confirm with `chrome-agent status` — the stop's return is not the
  verification, the status read is. `chrome-agent cleanup` drops dead entries.
- **Never stop a browser you did not launch.** It may be a human's session.
- A browser driven this way is a real, logged-in browser: `Runtime.evaluate`
  running `fetch()` inherits the page's session. Treat anything it can reach as
  live, and avoid destructive actions on shared instances.
- Headed instances are marked with a coloured border and an instance-name title
  prefix so a human can tell an agent-driven window from their own.
- Respect site terms; the fingerprint option exists for legitimate access, and
  WebRTC can still leak the real IP regardless of profile.

## Quick-start usage snippet

```bash
chrome-agent launch --headless    # omit --headless to watch it
# {"name": "myproj-01", "port": 9222, "pid": 58012, "browser_version": "Chrome/152..."}

chrome-agent status               # instances and their tabs

chrome-agent myproj-01 Page.navigate '{"url":"https://example.com"}'

# Wait on an observable condition, never a fixed sleep
chrome-agent myproj-01 Runtime.evaluate '{"expression":"document.readyState","returnByValue":true}'
# -> {"result": {"type": "string", "value": "complete"}}

# Observe: background the stream, then act; events land in the file
chrome-agent attach myproj-01 +Page.loadEventFired +Runtime.exceptionThrown \
  +Network.loadingFailed > /tmp/events.jsonl 2>&1 &

# Screenshot bytes are at `data` and need decoding
chrome-agent myproj-01 Page.captureScreenshot '{"format":"png"}' \
  | python3 -c "import sys,json,base64; open('/tmp/shot.png','wb').write(base64.b64decode(json.load(sys.stdin)['data']))"

# Don't guess protocol names -- ask the running browser
chrome-agent help myproj-01 Network

chrome-agent stop myproj-01 && chrome-agent status   # stop, then verify
```

See [SKILL.md](SKILL.md) for the command reference, and `chrome-agent guide --path`
for the full bundled manual.
