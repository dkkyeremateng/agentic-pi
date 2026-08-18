# pi-obs — React power UI for agent observability

> Live run streaming, span traces, timeline replay, per-agent cost/token
> analytics, evaluators and alerts for multi-agent AI runs — pointed at any pi
> obs-server by configuration.

A **standalone** Vite + React + TypeScript dashboard for the pi obs-server `/api`
surface. It's decoupled from any single agent: one build can point at any pi
agent's obs-server via configuration (see [Configuration](#configuration)), so
you can run it as a shared service alongside multiple agents.

Implements the **v2 Observe** direction from the obs UI spec.

## Run

```bash
npm install
npm run dev        # http://localhost:5174/app/   (proxies /api → 127.0.0.1:7616)
npm test           # unit tests (node --test via tsx)
npm run typecheck  # tsc -b --noEmit
npm run build      # tsc + vite build → dist/  (≈125 kB gzip JS + ≈17 kB gzip CSS)
npm run preview    # serve dist/ at :5175 (same /api proxy)
```

The obs-server must be running (`PI_OBS_PORT` default 7616). Point the dev proxy
at it with `PI_OBS_URL` — set in the **repo-root `.env`**, or inline:
`PI_OBS_URL=host:port npm run dev`.

Four runtime dependencies — React, React DOM, Zustand, TanStack Query. Styling is
hand-written CSS over a token file; there's no UI framework and no chart library.

## Configuration

This package has **no `.env` of its own**. All of it is read from the
**repo-root `.env`** (`vite.config.ts` sets Vite's `envDir` there), so the
dashboard's settings sit beside the obs-server settings they pair with —
`PI_OBS_URL` next to `PI_OBS_TOKEN` and `PI_OBS_PORT` — instead of in a second
file that has to be kept in sync. Copy the repo-root `example.env` → `.env` and
see its "Observability — dashboard UI" section for the full, commented reference.
Everything deployment-specific is env-driven, so one codebase serves many setups.
The essentials:

| Var | What | Default |
|-----|------|---------|
| `PI_OBS_URL` | Dev/preview **proxy target** (the obs-server). Full URL or bare host (scheme → `http://`, port → `7616`; use explicit `https://…` for a `tailscale serve` front). | `http://127.0.0.1:7616` |
| `VITE_API_BASE` | **Runtime** API base the browser calls. Set an absolute URL to point a build straight at a remote agent (no proxy; that server needs CORS + token). | `/api` (same-origin) |
| `VITE_PI_OBS_TOKEN` | obs API token exposed to the client so it auto-authenticates (else the TokenGate prompts). Keep the `VITE_` prefix. ⚠ **Public** — inlined into the JS bundle in plain text; the build warns if set. | — |
| `VITE_BASE` | Public base path. `/` to host at an origin root. | `/app/` |
| `VITE_HOST` | Dev/preview bind. `true`/`0.0.0.0` for LAN/Tailscale. | localhost |
| `VITE_PORT` / `VITE_PREVIEW_PORT` | Dev / preview ports. | 5174 / 5175 |

**Two ways to choose "which server":** the dev **proxy** (`PI_OBS_URL`, used only
for the relative `/api` default) vs. the **runtime base** (`VITE_API_BASE`, the
built app calls it directly). For the common same-origin setup you only need
`PI_OBS_URL`.

**On sharing the repo-root `.env`:** that file also holds unrelated agent secrets.
Vite only exposes `VITE_`-prefixed vars to browser code, so those never reach the
bundle — but the same rule means anything you *do* prefix with `VITE_` is public.

**Point at an agent live, without a rebuild** — the API base resolves at runtime,
highest precedence first:

1. `?api=<url>` in the page URL — persisted to localStorage, then stripped from
   the address bar. A shareable "open the dashboard against agent X" link;
   `?api=` (empty) resets to the default.
2. `localStorage["pi_obs_api_base"]` (set by the above, or `setApiBase()`).
3. build-time `VITE_API_BASE`.
4. `/api` (same-origin).

So a single deployed dashboard can front several agents:
`https://dash.example/app/?api=https://agent-a.ts.net/api`.

### Auth

When the obs-server is started with `PI_OBS_TOKEN`, it gates every `/api` route.
The dashboard sends the token as an `Authorization: Bearer` header on fetches and
as `?token=` on SSE URLs (EventSource can't set headers). The token comes from
`localStorage["pi_obs_token"]` first, then build-time `VITE_PI_OBS_TOKEN`. On the
first 401 the in-app **TokenGate** modal prompts for it, stores it, and reloads —
so no rebuild is needed to authenticate against a gated server.

## Features

Eight top-level segments, all linkable via the hash router
(`#/<segment>[/<runId>/<tab>]`) and reachable from the ⌘K command palette.

- **Runs** — the inbox: filter by status, date window, project, and free text,
  with low-signal no-op runs folded away by default. Selecting a run opens the
  hero (cost/tokens/duration/verdict), the digest pane (narrative, anomaly cards,
  pass/fail scoring → `POST /verdict`), and six detail tabs: **Trace** (span tree
  with per-span I/O), **Timeline** (zoomable gantt + scrubbable replay),
  **Events** (turn-banded feed with filters), **Stats**, **Evals**, and **Raw**
  (JSONL). Open runs stream live into these tabs over SSE.
- **Live** — an agent wall fed straight off the event stream: one card per
  session with rollups, a live tail, throughput, stall badges, and which
  sub-agents the orchestrator is currently blocked on. Pausable (buffers rather
  than drops), filterable to one run, and defaults to still-open sessions.
- **Analytics** — KPI strip, throughput chart, Compare A/B, and run history.
- **Datasets** — curated run sets (a regression suite, a golden set, a
  known-failures bucket) tracked by their aggregate evaluator scores.
- **Monitors** — user-defined thresholds on cost, latency, eval score, or error
  rate. Breaches raise alerts in the header badge and can be relayed to a webhook
  (via the server, to avoid browser CORS).
- **Prompts** — per-agent boot snapshots (prompt hash, model, tools, skills,
  context files) versioned across runs, plus a one-shot prompt playground.
- **Chat** — talk to an agent, with streaming replies, markdown rendering, and
  image/file attachments. Chats can **attach to a live run** and steer the
  running agent through its control channel (as a steer or a follow-up), with an
  optional human-in-the-loop approval gate on its tools. Conversations persist to
  the server as well as localStorage, so they survive a cache clear and follow
  you across browsers.
- **Search** — free text plus a `tool:` / `status:` / `agent:` / `model:` /
  `run:` prefix grammar over `/api/search`, with a facet rail and highlighted
  matches.

### Features that need an LLM-enabled server

Run explanations, the LLM-as-judge scoring on the Evals tab, I/O block
summaries, the prompt playground, and Chat all call LLM-backed endpoints. These
are opt-in server-side via `PI_OBS_LLM=1`; when it's off the server answers with
`enabled: false` and the UI shows a hint in place of the feature rather than
erroring.

## Architecture

The organizing rule is a **pure/impure split**: everything that computes lives in
`src/data/derive/` as pure, unit-tested functions, and components are thin
renderers over them. The store holds UI state and raw events — nothing derived.

```
src/
  data/          server + state layer
    config.ts      resolves the API base (?api= → localStorage → env → /api)
    auth.ts        token storage, Bearer header / ?token=, TokenGate trigger
    client.ts      typed fetchers over /api; 401 opens the TokenGate
    stream.ts      hardened EventSource (see below)
    live.ts        merges streamed events into one run's query cache
    store.ts       Zustand: UI state, live lanes, localStorage persistence
    queries.ts     TanStack Query hooks; polling backs off on finished runs
    url.ts         two-way sync between the store and location.hash
    types.ts       hand-written mirror of the server's shapes
    derive/        pure logic: lanes, laneRollup, trace, timeline, replay,
                   cycles, dispatchState, analytics, search, evals, monitors
  shell/         AppShell, GlobalStats, CommandPalette, TokenGate
  runs/ live/ analytics/ datasets/ monitors/ prompts/ chat/ search/   views
  lib/           shared widgets (Combo, Chip, Spark, Icon, Stepper) + formatters
  styles/        tokens.css (v2 Observe palette), base, responsive
```

A few behaviours worth knowing before you change them:

- **Streaming (`stream.ts`)** carries three contracts a bare EventSource gets
  wrong: it reconnects even after the browser permanently CLOSEs the source (a
  server restart otherwise kills the stream for good), it backs off 2s→30s with
  jitter so a fleet of tabs doesn't reconnect in lockstep, and it drops replayed
  events using a per-session monotonic `seq` high-water mark — a reconnect
  re-sends the server's ring buffer.
- **Ingest is batched.** `App.tsx` queues stream events and flushes every ~100ms;
  pausing the Live wall buffers instead of dropping, so unpausing replays the
  backlog. Lanes are capped (80 lanes / 30-min TTL) so a long-lived tab can't
  grow unboundedly.
- **Polling is adaptive.** Active runs refetch every 3s; a run silent for 90s is
  treated as finished and stops being polled. SSE is the fast path and the poll
  is the self-healing fallback — refetching full run history is idempotent, so a
  dropped frame reconciles within seconds.
- **Chat sync merges, it doesn't replace.** On load, server-stored chats are
  unioned with local ones and collisions resolve to whichever copy has the newer
  message, so a stale server copy can't wipe messages written moments ago. Writes
  are debounced 800ms and flushed on `pagehide`/`visibilitychange`.
- **Chat streams over GET**, not POST, because the Vite dev proxy buffers POST
  bodies. That puts the message in the query string, so requests are rejected
  client-side past 12k chars rather than failing opaquely at a proxy.
- **`types.ts` is hand-written** to mirror the server. It's the main drift risk in
  the codebase; the intent is to regenerate it from `/api/openapi.yaml` via
  `openapi-typescript` once that's available.

### Server endpoints used

`/summary` · `/runs` · `/runs/:id` · `/runs/:id/events` · `/runs/:id/digest` ·
`/runs/:id/explain` · `/runs/:id/judge` · `/runs/:id/verdict` ·
`/search` · `/prompts` · `/stream` · `/live-sessions` · `/chats` (GET/PUT) ·
`/chat` · `/chat-live` · `/chat-approve` · `/chat-upload` · `/uploads/:id` ·
`/summarize` · `/playground` · `/notify`

### Client-side persistence

All localStorage, all optional — every read is wrapped so a storage-less or
quota-full browser degrades to defaults rather than breaking.

| Key | Holds |
|-----|-------|
| `pi_obs_api_base` | which obs-server to talk to |
| `pi_obs_token` | obs API token (from the TokenGate) |
| `obs.chats` | chat conversations (also mirrored server-side) |
| `obs.datasets` | curated run sets |
| `obs.monitors` | alert thresholds |
| `obs.webhook` | alert delivery target |
| `obs.evalConfig` | evaluator budgets |
| `obs.liveRunFilter`, `obs.liveActiveOnly` | Live wall filters |

## Tests

`npm test` runs the unit suite through `node --test` via `tsx`. Coverage tracks
the pure/impure split — the logic modules are tested, the components are not:

`derive/` (`lanes`, `laneRollup`, `trace`, `timeline`, `replay`, `cycles`,
`dispatchState`, `analytics`, `search`, `evals`, `monitors`), plus `store` (chat
merge + ingest), `config` (API-base resolution), `chat/markdown`,
`runs/runUtils`, `runs/eventMeta`, `tabs/spanDetail`, `tabs/rawHighlight`, and
`lib/toolArgs`.

## Deploy modes

**Same-origin (simplest).** Have obs-server serve `dist/` under its own origin
(no CORS, no token round-trip). `base` defaults to `/app/`; the app calls the
relative `/api`. One static route (stdlib only, with a flat-name traversal
guard):

```ts
// GET /app[/...] → pi-obs/dist (SPA: fall back to index.html for unknown paths)
if (path === "/app" || path.startsWith("/app/")) {
  const rel = path.slice("/app/".length) || "index.html";
  const safe = rel.replace(/\.\.+/g, "").replace(/^\/+/, "");
  const file = join(APP_DIST, safe);
  // serve `file` if it exists, else APP_DIST/index.html (client router)
}
```

Serving at a different mount? Build with `VITE_BASE=/whatever/` so asset URLs
resolve there (`/` for an origin root).

**Standalone service (front many agents).** Host the built `dist/` anywhere
(static host, or `npm run preview` behind Tailscale with `VITE_HOST=true`). Point
it at agents with `VITE_API_BASE` at build time, or live via `?api=<obs-url>` —
see [Configuration](#configuration).

For a **cross-origin** target (the dashboard's origin ≠ the obs-server's), the
server must accept the dashboard's origin. Two supported setups:

- **Token-gated (recommended).** The obs-server runs with `PI_OBS_TOKEN`; supply
  it via the TokenGate / `VITE_PI_OBS_TOKEN`. A configured token satisfies the
  server's cross-origin guard, and its CORS response now allows the
  `Authorization` header, so the `Bearer` preflight passes. This is the normal
  path — any obs-server reachable off-loopback is required to have a token anyway.
- **Open (no token).** An open server rejects cross-origin browser requests with
  **403** unless the dashboard's origin is listed in `PI_OBS_ALLOWED_ORIGINS` on
  that server (its CORS `*` alone is not enough — the server blocks the request,
  not just the read, to stop drive-by pages hitting a loopback server). Add your
  origin there, e.g. `PI_OBS_ALLOWED_ORIGINS=https://dash.example`. The dashboard
  surfaces a 403 with this hint.

Same-origin deploys (the server serving `dist/`, or the dev/preview proxy) are
unaffected — no `Origin` guard applies.

## License

MIT — see [LICENSE](LICENSE).
