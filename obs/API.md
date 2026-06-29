# Agent Observability — HTTP API

The obs-server (`obs/obs-server.ts`, default `http://127.0.0.1:7616`)
exposes a JSON API under **`/api`** for external UIs and integrations. The
bundled vanilla dashboard uses equivalent unprefixed legacy routes; treat
`/api/*` as the stable surface for anything new.

- **CORS**: `/api/*` responds with `Access-Control-Allow-Origin: *` (plus
  `OPTIONS` preflight). The server binds to `127.0.0.1`, so this only exposes
  it to pages and apps on the same machine.
- **Auth**: none by default (localhost-only by design). Set `PI_OBS_TOKEN` to
  require a shared secret on every route — see [Authentication](#authentication).
- **Content type**: `application/json` unless noted.
- **Sink aggregation**: when tailing the shared global sink
  (`~/.pi/agent/obs/events.jsonl`, the no-arg default), the server also reads
  every per-project sink beside it (`<dir>/*/events.jsonl`), so `/runs`,
  `/summary`, `/search`, digests, etc. span all projects. Auto-on for the global
  sink; force with `PI_OBS_AGGREGATE=1`, disable with `PI_OBS_AGGREGATE=0`. Each
  run's events are read from the file that holds them. `GET /api` reports
  `aggregate` + the `sinks` list when active.
- **Run ids**: every `:id` accepts the full runId or any **unique prefix**
  (`404` with an explanatory error when missing or ambiguous).
- **Errors**: non-2xx responses are `{ "error": "<message>" }`.

Start the server: `npm run obs:server` (or `run.sh --server`). Data appears
when workflows run with `PI_OBS=1`.

A machine-readable **OpenAPI 3.0 spec** lives at `obs/openapi.yaml` and
is served live at `GET /api/openapi.yaml` — point Swagger UI, Postman, or a
client generator at it.

## Authentication

Auth is **opt-in**. With no `PI_OBS_TOKEN` set the server is open (the loopback
default). Start it with a token to require a shared secret on every route:

```bash
PI_OBS_TOKEN=$(openssl rand -hex 32) npm run obs:server
# or put PI_OBS_TOKEN=… in .env (the server loads it like every other setting)
```

When set, send the token one of two ways:

- **`Authorization: Bearer <token>`** — for `fetch`, `curl`, and external clients.
- **`?token=<token>`** query parameter — for the SSE endpoints (`/api/stream`,
  `/api/chat`, `/api/chat-live`), which use `EventSource` and cannot set headers.

The static dashboard shell (`/`, `/scripts/*`, `/styles/*`) stays unauthenticated
so the page can load; it then prompts for the token and stores it in
`localStorage` (`pi_obs_token`), attaching it to every data request and stream.
Missing/invalid tokens get `401` with a `WWW-Authenticate: Bearer` header. The
comparison is constant-time. `OPTIONS` preflights are never gated.

```bash
curl -H "Authorization: Bearer $PI_OBS_TOKEN" http://127.0.0.1:7616/api/runs
```

This is defense-in-depth, not a replacement for network controls: keep the server
on loopback and front it with Tailscale/a reverse proxy for TLS and identity.

## Endpoints

### `GET /api`
Discovery + server meta:

```json
{
  "name": "pi-agent-obs",
  "schema": 2,
  "sink": "/Users/you/.pi/agent/obs/events.jsonl",
  "bufferedEvents": 4213,
  "uptimeMs": 123456,
  "endpoints": ["GET  /api", "…"]
}
```

### `GET /api/summary`
Live rollup of the in-memory buffer (recent activity, not full history):
`{ sessions, totalEvents, totalTokens, totalCostUsd, totalErrors, agents: [{ agent, events, turns, toolCalls, toolErrors, errors, tokens, costUsd, lastType, lastTs, active }], firstTs, lastTs }`.

### `GET /api/events?limit=`
The recent live buffer (ring of the last ~5000 events), oldest-first.
`limit` returns only the newest N.

### `GET /api/runs?project=&since=&limit=&includeEmpty=`
Every run recorded in the sink (byte-range indexed, latest-first), **except
finished no-op runs** — those with `costUsd`, `tokens`, and `toolCalls` all `0`
that have been quiet for >90s are omitted (a still-live all-zero run is kept).
Pass `includeEmpty=1` to get them too. Filters: `project` (basename of the run's
cwd, e.g. `proj-alpha`), `since` (epoch ms or ISO date — runs that *started*
at/after it), `limit` (newest N).

Each run summary:

```json
{
  "runId": "run-mqa9m2kb-z027y",
  "firstTs": 1781233558000, "lastTs": 1781233775000,
  "events": 412,
  "agents": ["orchestrator", "scout", "implementer"],
  "cwd": "/Users/you/projects/plp",
  "name": "fix flaky validator",
  "costUsd": 1.85, "tokens": 41280, "toolCalls": 36, "errors": 0,
  "models": ["anthropic/claude-fable-5", "gateframe/gpt-5-nano"],
  "modelCost": { "anthropic/claude-fable-5": 1.6, "gateframe/gpt-5-nano": 0.25 },
  "verdict": { "status": "pass", "source": "workflow", "ts": 1781233775100 },
  "startOffset": 91234, "endOffset": 287654
}
```

`modelCost` attributes each turn's cost to its session's model (from
`session_start`), so spend is correct even when sub-agents run on different
models from the orchestrator.

(`startOffset`/`endOffset` are internal sink byte ranges — ignore them.)
`tokens`/`toolCalls` let a UI spot a do-nothing run: the bundled dashboard hides
runs with `costUsd`, `tokens`, and `toolCalls` all `0` once they've gone quiet
(a live run that hasn't taken its first turn is kept).

### `GET /api/runs/:id`
One run's summary (shape above).

### `GET /api/runs/:id/events`
The run's complete event history, read from the sink (works long after the
live buffer dropped it). Array of `ObsEvent` (schema below), file order.

### `GET /api/runs/:id/digest?format=json|text`
The anomaly digest behind `obs-cli explain` — the highest-leverage endpoint
for integrations ("what happened in that run?"). JSON by default:
`{ runId, name?, cwd?, startTs, endTs, wallMs, verdict?, totals: { costUsd,
tokens, turns, toolCalls, toolErrors, providerErrors, retries, compactions },
models, agents: [AgentDigest], tools: [ToolDigest], anomalies: [{ kind, agent?,
detail }] }`. Anomaly kinds: `retry · dispatch-error · truncated · tool-error ·
provider-error · slow-tool · slow-turn · cost-outlier · compaction · context`.
`format=text` returns the human/LLM-ready markdown rendering instead.

### `GET /api/runs/:id/explain`
An **optional** LLM narrative of the run — a 2-4 sentence plain-language summary
plus up to 3 recommendations, built on top of the deterministic `/digest`.
**Off by default.** When disabled it returns `{ "enabled": false, "hint": … }`
(a 200, not an error, so a UI can show a "configure me" state). When enabled it
returns `{ "enabled": true, "narrative", "recommendations": [string], "model",
"ts", "cached"? }`. Results are cached by `runId + endTs`.

It runs the **`pi` CLI** one-shot (`pi --mode text -p --no-tools --no-session
--no-skills --no-extensions --model <model> …`), so it reuses pi's own provider
auth and the same model strings the workflow uses — no separate API key, no SDK
dependency. Server-side config (env, all opt-in):

| Env var | Default | Notes |
|---|---|---|
| `PI_OBS_LLM` | _(off)_ | `1`/`true` to enable |
| `PI_OBS_LLM_MODEL` | `PI_WORKFLOW_MODEL`, else the primary session's model | any pi model id; unset → the spawn omits `--model` so it inherits the running agent's own model (no forced third-party default) |
| `PI_OBS_LLM_TIMEOUT_MS` | `60000` | kill the pi spawn after this |

Requires `pi` on the server's PATH.

### `POST /api/summarize`
A one-sentence LLM summary of an arbitrary trace chunk — the Trace view uses it
to summarize a single I/O block (tool args or a tool result) on demand. Body:
`{ "text": string, "kind"?: string }` (`kind` is a label like `"input"` /
`"output"`, ≤40 chars, used only to shape the prompt). Same opt-in and config as
`/explain` (`PI_OBS_LLM*`, the `pi` CLI, the configured model). **Off by
default** → `{ "enabled": false, "hint": … }` (a 200). When enabled →
`{ "enabled": true, "summary": string, "cached"? }`; a provider/spawn failure
returns `{ "enabled": true, "error": string }` (still a 200, so the UI can show
it). Results are cached by `kind + sha256(text)`. Body is capped at 256 KB and
the text is truncated to 6000 chars before the model sees it.

### `GET /api/runs/:id/otel`
The run as an OTLP/JSON trace (OpenTelemetry GenAI semantic conventions) —
POST it to any OTel backend. (Live forwarding also exists server-side via
`PI_OBS_OTLP_ENDPOINT`.)

### `POST /api/runs/:id/verdict`
Score a run. Body: `{ "status": "pass" | "fail" | "open", "note"?: string,
"agent"?: string }`. Appends a verdict event to the sink (source `"api"`); the
tailer broadcasts it, so open dashboards update live. **The last verdict wins** —
this overrides the workflow's auto-verdict or an earlier score. Response:
`{ ok, runId, verdict, previous }`.

Pass **`agent`** to scope the verdict to a single agent's run *within* this run
(e.g. score the `implementer` independently of the orchestrator). Agent-scoped
verdicts are surfaced separately in the digest as `agentVerdicts[agent]` and do
**not** set the run-level `verdict` (so run cards/inbox stay driven by the
whole-run score). Last verdict per agent wins.

The workflow auto-scores each agent as it finishes (`source: "auto"`): scout /
planner / refiner pass on completion, implementer / validator / reviewer / shipper
from their resolved outcome, and the failing agent on a hard error. The Trace
view shows these with an "auto" tag; a manual score (`source: "api"`) overrides
them — last verdict wins.

### `POST /api/verdicts/backfill`
Auto-score every run that has **ended** (quiet > 90s) but never got a verdict,
from its digest (`source: "auto"`). A run **fails** on a hard/infra failure
(provider or dispatch error, a truncated turn) and **passes** if it ended cleanly
(routine tool errors don't fail it on their own); an empty no-op session is left
unscored. Skips runs already scored and runs a workflow deliberately left `open`
(needs-review). Manual scores still override. Response: `{ enabled, scored }`.

The server also runs this **automatically** ~3s after startup and every 60s
(idempotent — a scored run is no longer a candidate). Disable with
`PI_OBS_AUTO_VERDICT=0`.

### `GET /api/search?q=&limit=`
Case-insensitive substring search over the **entire sink** (every run ever
recorded; raw-line match, so it covers payloads and envelopes). Returns the
newest `limit` (default 200, max 500) matching events.

### `GET /api/stream` (SSE)
`text/event-stream` of live events: replays the current buffer, then streams.
Frames are `event: obs` with an `ObsEvent` JSON `data:` payload; comment
heartbeats every 15s. **`?run=<id>`** scopes replay + live to one run (exact
runId — useful while a run is in flight).

```js
const es = new EventSource("http://127.0.0.1:7616/api/stream");
es.addEventListener("obs", (e) => console.log(JSON.parse(e.data)));
```

## The event model (`ObsEvent`, schema 2)

Defined in `obs/obs-events.ts` (the source of truth):

```ts
{
  v: 2,                  // schema version
  seq: number,           // per-session monotonic sequence
  ts: number,            // epoch ms
  sessionId: string,     // unique per agent process
  agent: string,         // "orchestrator", "scout", …
  cwd?: string,          // project directory
  runId?: string,        // groups all agents of one workflow invocation
  parent?: string,       // dispatching agent's name (unset on the root)
  name?: string,         // run display name (root session, when named)
  type: ObsEventType,
  payload: object        // type-specific
}
```

Event types and notable payload fields:

| type | payload highlights |
|---|---|
| `session_start` | `model`, `pid`, `dispatchId` |
| `boot` | `tools[]`, `skills[]`, `contextFiles[{path,bytes,hash}]`, `promptChars`, `promptHash` |
| `turn_start` / `turn_end` | end: `turnIndex`, `tokens{input,output,cacheRead,cacheWrite,total}`, `costUsd`, `durationMs`, `tps`, `prefillMs`, `context{tokens,window,percent}`, `model`, `stopReason` |
| `tool_start` / `tool_end` | `toolCallId`, `toolName`, `arg`/`argsText`, end: `durationMs`, `isError`, `result`/`resultText` |
| `message` | `role`, `kind` (`user`/`assistant`/`thinking`), `text` (opt-in via `PI_OBS_CONTENT=1`) |
| `model_change` | `model`, `previous`, `source` |
| `compaction` | `reason` (`manual`/`threshold`/`overflow`), `willRetry` (turn retried after an overflow compaction), `fromExtension`, `tokensBefore` (context size just before compacting) |
| `error` | `source`, `status` (provider HTTP status), `message` |
| `dispatch_start/retry/end` | `agent` (the child), `dispatchId`, retry: `reason`, end: `status`, `attempts` |
| `verdict` | `status` (`pass`/`fail`/`open`), `outcome?`, `note?`, `source` (`workflow`/`cli`/`api`), `prUrl?` |

Notes for consumers:

- **Verdicts are run-level annotations**: exclude them from per-agent
  aggregation and time bounds (a score can arrive days after the run; its
  synthetic session has agent `"user"`).
- A root event without `parent` is the orchestrator; older sinks may carry the
  session *name* in `agent` for the root — normalize root agents to
  `"orchestrator"` if you build lanes.
- Events of one run interleave with other runs in the global sink; always
  group by `runId`.

## Quick examples

```bash
curl -s localhost:7616/api/runs?limit=5 | jq '.[].runId'
curl -s localhost:7616/api/runs/run-mqa9/digest?format=text
curl -s localhost:7616/api/search?q=obs-server.ts | jq length
curl -s -X POST localhost:7616/api/runs/run-mqa9/verdict \
     -H 'content-type: application/json' \
     -d '{"status":"pass","note":"verified manually"}'
```

## Agent dispatch (opt-in `PI_OBS_DISPATCH=1`)

Run a single named workflow agent **standalone** — no orchestrator or active run
needed — reusing the workflow's own spawn recipe (the agent's prompt, tools, and
model). The dispatched agent runs as its own root run, so it appears on the
dashboard. **Off by default**; set `PI_OBS_DISPATCH=1` on the server to enable.

### `GET /api/agents?cwd=`
Lists the known agents (project `.pi/agents/` then bundled), `cwd`-scoped:
`{ dispatchEnabled, agents: [{ name, description, model, readOnly }] }`. `readOnly`
(no `write`/`edit` tool) is informational — **all** agents are dispatchable.

### `POST /api/dispatch` (SSE) — `{ agent, text, cwd, model?, sessionId? }`
Spawns `agent` for one `text` task in `cwd` and streams `ChatEvent` frames (same
shape as `/api/chat`: `token`/`thinking`/`tool`/`done`/`error`). `sessionId` (must
match `^[\w.-]{1,64}$`) continues a prior dispatch for follow-ups; `model`
overrides the agent's configured model. Disabled returns one `error` frame.

**Confinement.** The agent's **file tools** (read/write/edit/grep/find/ls) are
confined to `cwd` (cwd-guard is forced on). **`bash` is not confined in-process** —
a shell command can still reach outside `cwd`; for hard isolation run the server in
a container / OS sandbox. The route is gated on `PI_OBS_DISPATCH=1`, and (via the
bridge) behind the chat-id allowlist.

## Telegram bridge

`obs/obs-bridge.ts` is a small client that lets you talk to this API from
Telegram — chat with the assistant and inspect/score runs from your phone. Run
it with **`./run.sh --bridge`**, which cold-starts the obs-server on `$PORT` if
none is running (use `npm run obs:bridge` when a server is already up, or point
the bridge at one with `PI_OBS_BRIDGE_API`).

It **long-polls** the Telegram Bot API (`getUpdates`), so there is **no inbound
webhook** — the obs-server keeps binding loopback exactly as before, and the
bridge reaches out. It maps each message onto the API above:

- **free text** -> `GET /api/chat` (SSE), keyed to a stable per-chat `sessionId`
  (`tg-<chatId>`) for conversational continuity. Replies **edit-stream**: one
  Telegram message is edited as tokens arrive (throttled by `PI_OBS_TG_EDIT_MS`).
  Needs `PI_OBS_LLM=1` on the server. Tools are **off** by default.
- `/runs [n]` -> `/api/runs`; `/last` and `/digest <id>` -> `/api/runs/:id/digest?format=text`
- `/search <text>` -> `/api/search`; `/live` -> `/api/live-sessions`
- `/pass|/fail|/open <id> [note]` -> `POST /api/runs/:id/verdict`
- `/attach <run-id>` binds the chat to a **live run** (resolved from
  `/api/live-sessions` — the run's root `orchestrator`); subsequent plain messages
  route to `GET /api/chat-live` (injected as a follow-up user message) and stream
  the orchestrator's reply. `/detach` unbinds; the bridge also auto-detaches if the
  run ends. Slash commands still work while attached.
- `/agents` -> `GET /api/agents`; `/dispatch <agent>, <prompt>` -> `POST /api/dispatch`
  runs a single named agent standalone (no run needed) and streams its reply. The
  bare `<agent>, <prompt>` form is opt-in (`PI_OBS_TG_BARE_DISPATCH=1`). Per-
  (chat, agent) sessions give follow-up continuity.
- `/reset` starts a fresh conversation (rotates the `sessionId`, detaches if
  attached, and resets dispatch sessions); `/help` lists all.

**Auth & access.** The bridge holds `PI_OBS_TOKEN` and calls the server locally,
so the token never leaves the machine (it's sent as the bearer header, and as
`?token=` for the SSE streams). Access is **fail-closed**: only chat ids in
`PI_OBS_TG_ALLOW` are served; an unknown sender gets a one-line reply with *their
own* chat id so you can add it.

While `/attach`ed the bridge **drives a live agent** (`/api/chat-live`), so treat
the allowlist as a privilege boundary. It delivers as a follow-up with `approve`
off (the run keeps its own tool policy) and does not expose the tool approve/deny
route (`/api/chat-approve`).

Config (see `example.env`): `PI_OBS_TG_TOKEN` (required, from @BotFather),
`PI_OBS_TG_ALLOW` (required for any access), `PI_OBS_TG_TOOLS`, `PI_OBS_TG_MODEL`,
`PI_OBS_TG_CWD`, `PI_OBS_TG_POLL_S`, `PI_OBS_TG_EDIT_MS`, and `PI_OBS_BRIDGE_API`
(defaults to `PI_OBS_HOST:PI_OBS_PORT`).

## Legacy routes (used by the bundled dashboard)

`/stream`, `/summary`, `/events[?run=]`, `/runs`, `/search?q=`,
`/otel[?run=][&download=1]` — same data, no CORS headers, no stability
promise. Prefer `/api/*`.
