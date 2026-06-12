# Agent Observability — HTTP API

The obs-server (`utils/obs/obs-server.ts`, default `http://127.0.0.1:7616`)
exposes a JSON API under **`/api`** for external UIs and integrations. The
bundled vanilla dashboard uses equivalent unprefixed legacy routes; treat
`/api/*` as the stable surface for anything new.

- **CORS**: `/api/*` responds with `Access-Control-Allow-Origin: *` (plus
  `OPTIONS` preflight). The server binds to `127.0.0.1`, so this only exposes
  it to pages and apps on the same machine.
- **Auth**: none (localhost-only by design).
- **Content type**: `application/json` unless noted.
- **Run ids**: every `:id` accepts the full runId or any **unique prefix**
  (`404` with an explanatory error when missing or ambiguous).
- **Errors**: non-2xx responses are `{ "error": "<message>" }`.

Start the server: `npm run obs:server` (or `run.sh --server`). Data appears
when workflows run with `PI_OBS=1`.

A machine-readable **OpenAPI 3.0 spec** lives at `utils/obs/openapi.yaml` and
is served live at `GET /api/openapi.yaml` — point Swagger UI, Postman, or a
client generator at it.

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

### `GET /api/runs?project=&since=&limit=`
Every run ever recorded in the sink (byte-range indexed, latest-first).
Filters: `project` (basename of the run's cwd, e.g. `proj-alpha`), `since`
(epoch ms or ISO date — runs that *started* at/after it), `limit` (newest N).

Each run summary:

```json
{
  "runId": "run-mqa9m2kb-z027y",
  "firstTs": 1781233558000, "lastTs": 1781233775000,
  "events": 412,
  "agents": ["orchestrator", "scout", "implementer"],
  "cwd": "/Users/you/projects/plp",
  "name": "fix flaky validator",
  "costUsd": 1.85, "errors": 0,
  "verdict": { "status": "pass", "source": "workflow", "ts": 1781233775100 },
  "startOffset": 91234, "endOffset": 287654
}
```

(`startOffset`/`endOffset` are internal sink byte ranges — ignore them.)

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

### `GET /api/runs/:id/otel`
The run as an OTLP/JSON trace (OpenTelemetry GenAI semantic conventions) —
POST it to any OTel backend. (Live forwarding also exists server-side via
`PI_OBS_OTLP_ENDPOINT`.)

### `POST /api/runs/:id/verdict`
Score a run. Body: `{ "status": "pass" | "fail" | "open", "note"?: string }`.
Appends a verdict event to the sink (source `"api"`); the tailer broadcasts it,
so open dashboards update live. **The last verdict for a run wins** — this
overrides the workflow's auto-verdict or an earlier score. Response:
`{ ok, runId, verdict, previous }`.

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

Defined in `utils/obs/obs-events.ts` (the source of truth):

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
| `compaction` | — (context pressure marker) |
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

## Legacy routes (used by the bundled dashboard)

`/stream`, `/summary`, `/events[?run=]`, `/runs`, `/search?q=`,
`/otel[?run=][&download=1]` — same data, no CORS headers, no stability
promise. Prefer `/api/*`.
