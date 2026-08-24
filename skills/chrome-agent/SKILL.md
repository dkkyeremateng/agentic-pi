---
name: chrome-agent
description: Observe and interact with a real Chrome browser over the Chrome DevTools Protocol (CDP) from the shell, via the `chrome-agent` CLI. Send any CDP command one-shot, or stream any CDP event from a persistent attach session. Use for driving a live browser, watching network traffic and console errors as they happen, reading page/DOM state, screenshots, trusted input, and sharing one browser between a human and one or more agents. Keywords - chrome, cdp, chrome devtools protocol, browser, devtools, network, console, screenshot, navigate, click, observe, attach, events, live browser, tab, headless.
allowed-tools: Bash, Read, Monitor
---

# chrome-agent — drive Chrome over CDP

## Purpose

`chrome-agent` gives you direct Chrome DevTools Protocol access to a real Chrome
from the shell. There is no abstraction layer: you name an instance and send it
a `Domain.method` with a JSON params blob, and Chrome answers. Anything your
installed Chrome's protocol supports works, including surface newer than the
installed `chrome-agent`.

Multiple participants — agents, humans, or both — can share one browser, each
with isolated event subscriptions.

## Which browser tool to reach for

This repo has three browser paths. They are not interchangeable:

| Use | When |
|-----|------|
| **`chrome-agent`** (this skill) | You need a **real, observable Chrome**: watching a live page, streaming network/console events, sharing a browser with a human, or reaching protocol surface a wrapper doesn't expose. |
| **`playwright-cli`** | Scripted, headless-first automation: scraping, UI test flows, ref-based `snapshot`/`click`/`fill`, throwaway parallel sessions. Higher level, less to hand-write. |
| **chrome-devtools MCP skills** | You specifically want the MCP tool surface loaded into context. Costs schema tokens; `chrome-agent` does not. |

## Prerequisite

```bash
chrome-agent --version    # confirm it's installed
```

If missing: `uv tool install chrome-agent` (needs Python >= 3.11 and a
system-installed Chrome or Chromium). Single runtime dependency; no browser
download.

## Mental model

Address an **instance by name**, then use one of two channels:

- **One-shot — act / pull.** `chrome-agent <inst> Domain.method '{json}'`
  connects, sends, prints the raw CDP result as JSON, disconnects (~70ms).
  Answers *what something is*.
- **Attach — observe / push.** `chrome-agent attach <inst> +Event ...` holds a
  connection and streams subscribed events as JSON lines. Answers *when
  something happens*.

Run both at once — they use separate CDP sessions and don't interfere.

## The loop: sense, act, sense

Sensing is the continuous mode; acting is the intervention. **Never trust an
act's return value — trust the next sense.** A command that returned without
error can still have done nothing.

```bash
chrome-agent launch --headless          # omit --headless to watch it
# {"name": "myproj-01", "port": 9222, "pid": 58012, "browser_version": "Chrome/152..."}

chrome-agent myproj-01 Page.navigate '{"url":"https://example.com"}'

# Wait on an observable condition, never a fixed sleep
chrome-agent myproj-01 Runtime.evaluate '{"expression":"document.readyState","returnByValue":true}'
# -> {"result": {"type": "string", "value": "complete"}}   read result.value

chrome-agent myproj-01 Runtime.evaluate '{"expression":"document.title","returnByValue":true}'

chrome-agent stop myproj-01
```

Prefer structured reads (`DOM`, `Accessibility`, `Runtime.evaluate`) for what a
page *says*. A screenshot is for what it *looks like* — layout, an image, a
CAPTCHA — and is the last resort for reading content.

### Screenshots

Bytes are at `data`, **not** `result.data`, and must be decoded before you can
look at them:

```bash
chrome-agent myproj-01 Page.captureScreenshot '{"format":"png"}' \
  | python3 -c "import sys,json,base64; open('/tmp/shot.png','wb').write(base64.b64decode(json.load(sys.stdin)['data']))"
```

Then read `/tmp/shot.png` with the Read tool to actually see it.

### Clicking

A synthetic `element.click()` via `Runtime.evaluate` is fine on ordinary UIs.
When it **silently no-ops**, escalate to trusted `Input` events rather than
debugging selectors — they enter Chrome's native pipeline and reach cross-origin
iframes, overlays, and UIs that gate on event trust.

```bash
# Locate (use the OUTER element; inner nodes can return a zero rect)
chrome-agent myproj-01 Runtime.evaluate '{"expression":"(()=>{const r=document.querySelector(\"#submit\").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()","returnByValue":true}'
# Act -- a real click is press + release
chrome-agent myproj-01 Input.dispatchMouseEvent '{"type":"mousePressed","x":400,"y":300,"button":"left","clickCount":1}'
chrome-agent myproj-01 Input.dispatchMouseEvent '{"type":"mouseReleased","x":400,"y":300,"button":"left","clickCount":1}'
# Sense again on an independent channel
```

React-controlled inputs need the native setter so React sees the change:

```bash
chrome-agent myproj-01 Runtime.evaluate '{"expression":"(()=>{const el=document.querySelector(\"#email\");const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,\"value\").set;set.call(el,\"a@b.com\");el.dispatchEvent(new Event(\"input\",{bubbles:true}));})()"}'
```

## Observing events

Backgrounded to a file:

```bash
chrome-agent attach myproj-01 +Page.loadEventFired +Runtime.exceptionThrown > /tmp/events.jsonl 2>&1 &
chrome-agent myproj-01 Page.navigate '{"url":"https://example.com"}'
cat /tmp/events.jsonl
# {"status": "ready", "sessionId": "...", "target": "..."}
# {"method": "Page.loadEventFired", "params": {"timestamp": 611754.64}}
```

**Better in this harness: hand `attach` to the Monitor tool** so events interject
into the session as they occur, instead of a log you have to remember to read.

```
Monitor:
  command:     "chrome-agent attach myproj-01 +Page.frameNavigated +Page.loadEventFired
                +Runtime.exceptionThrown +Network.loadingFailed 2>&1"
  description: "myproj-01 -- navigation + errors"
  persistent:  true
```

`TaskStop` on the returned id ends it.

**Always include the failure events.** A happy-path-only subscription stays
silent through an exception or a failed request, and silence is
indistinguishable from "nothing has happened yet." Good default:
`+Page.frameNavigated +Page.loadEventFired +Runtime.exceptionThrown +Network.loadingFailed`.

## Don't guess event or method names

`help` reads the schema out of the **running browser**, so it is always correct
for that Chrome. Three levels:

```bash
chrome-agent help myproj-01                          # every domain
chrome-agent help myproj-01 Network                  # Methods / Events / Types for one domain
chrome-agent help myproj-01 Network.responseReceived # full parameter signature
```

The domain level prints an explicit `Events:` block — that is the menu of
`+Event` subscriptions. Reaching only for `Page`, `Network`, and `Runtime` uses a
fraction of the ~57 domains available; enumerate before assuming CDP can't see
something. `experimental` is not a reason to avoid a capability.

## Beyond driving the UI

Often you shouldn't click through the UI at all:

- **Authenticated HTTP client.** `Runtime.evaluate` running `fetch()` inside the
  logged-in page inherits its session. Pass **both** `awaitPromise:true` and
  `returnByValue:true`, or you get a handle back before the data resolves.
- **API discovery.** `performance.getEntriesByType("resource")` recovers the
  endpoints the page already called, with no live subscription.
- **File upload with no dialog.** `DOM.setFileInputFiles`, identifying the input
  by `backendNodeId` (`nodeId`/`objectId` go stale between one-shots).
- **Shadow DOM / cross-origin iframes.** `DOM.getDocument '{"depth":-1,"pierce":true}'`.

## Managing instances

```bash
chrome-agent status                       # instances + their tabs; real-time truth
chrome-agent myproj-01 --url example.com Runtime.evaluate '{...}'   # target one tab
chrome-agent stop myproj-01 [--url foo]   # whole browser, or one tab
chrome-agent cleanup                      # drop dead instances + stale session dirs
```

**Stopping is part of the task, not optional cleanup.** A launched instance is a
full Chrome process that keeps running and accumulating memory until stopped.
When done: `chrome-agent stop <instance>`, then **verify with
`chrome-agent status`** — the stop's return is not the verification, the status
read is. Keep an instance alive only deliberately (e.g. you want its login
session later), never by omission.

Headed windows are marked with a colored border and an instance-name title
prefix so a human can tell an agent-driven window from their own
(`--no-window-border` disables it).

## Gotchas

- **`attach` under Monitor needs `2>&1`.** Only stdout becomes notifications. A
  wrong instance name writes to stderr and exits with empty stdout — the monitor
  dies instantly and looks exactly like a quiet page.
- **Don't over-subscribe.** `Network.requestWillBeSent` fires hundreds of times
  per load and gets the monitor stopped automatically. Drop it first.
- **Filtering needs unbuffered tools.** `jq --unbuffered`, `grep
  --line-buffered`, `awk` with `fflush()`. Never put `head` in a monitored
  pipeline — it cannot flush.
- **Navigation kills context.** A pending `Runtime.evaluate` errors with
  "context destroyed" when the page navigates. Retry on the new page.
- **One-shots can't intercept `Network`** — they detach immediately. Use
  `attach` for anything needing a persistent session.
- **`--target N` indices are sorted by target id**, not tab order, so opening a
  tab renumbers the others. Prefer `--url` or an id prefix.
- **Multiple live instances** disable name auto-selection for bare one-shots.
  `help` is the exception and always auto-picks.
- **Result shapes differ by method** — check, don't assume. Errors go to stderr
  with a non-zero exit and are self-describing.

## Full manual

The package ships a 22KB agent guide that goes deeper on all of the above. Read
the file rather than paging it through stdout:

```bash
chrome-agent guide --path    # print its path, then Read it
chrome-agent guide           # or print it
```

Source: https://github.com/captivus/chrome-agent
