# Agent Observability — UI Spec & React Implementation Plan

> **Status (2026-06-12):** the vanilla redesign described here is **fully
> implemented and shipped** (commits `f75e548` → `5be0600`: P1 foundation,
> P2 shell, P3 Trace/Single, P4 analytics, P5 polish, plus the context ring
> gauge, turn-cycle banding, orchestrator-group visibility, and SSE
> resilience fixes). Sections 1–4 are now the **living design spec** — the
> source of truth the React app implements. Section 5 maps every view's
> shipped behavior. Section 6 lists known gaps (= React requirements).
> Section 7 is the React implementation plan.
>
> The vanilla app stays the bundled zero-dependency default served by
> obs-server; the React app is the power UI consuming `/api` (see
> `utils/obs/API.md` + `openapi.yaml`).

---

## 1. Design direction

**North star: "a local-first Langfuse".** Calm, data-dense, OLED-dark
developer tool. Information density of Datadog, navigation clarity of
Langfuse, trace ergonomics of LangSmith — local-first, zero cloud.

1. **Chrome in sans, data in mono.** UI text (nav, labels, headings) in the
   system sans stack; ids, numbers, tokens, JSON in mono with
   `font-variant-numeric: tabular-nums`.
2. **One detail surface.** Everything inspectable (event, span, run, search
   hit) opens the same right-side drawer.
3. **Master–detail everywhere.** List on the left, detail on the right.
4. **Status = icon + text + color**, never color alone.
5. **Local-first soul.** Tokyo Night hues, the Race view's playfulness, no
   accounts, no cloud.

## 2. Design system (implemented in `styles/base.css` + `primitives.css`)

### 2.1 Color tokens

```css
/* surfaces — 5-step elevation ramp (no pure black: OLED smear) */
--surface-0: #0e0e14;  --surface-1: #14141b;  --surface-2: #1b1b26;
--surface-3: #22222f;  --surface-4: #2a2a3a;
--border: #2c2c3a;  --border-strong: #3b3b4f;

/* text — contrast tiers (verified on surface-1/2) */
--text-hi: #e2e2ec;    /* ≥9:1   primary */
--text-md: #b6b6c6;    /* ≥6:1   body */
--text-lo: #8b8b9e;    /* ≥4.5:1 secondary */
--text-faint: #6a6a7e; /* ≥3:1   decorative only */

/* brand + status */
--accent: #7aa2f7;  --accent-hover: #93b4f9;  --on-accent: #0d0d14;
--ok: #9ece6a;  --warn: #e0af68;  --err: #f7768e;
--info: #7dcfff;  --special: #bb9af7;

/* viz categorical ramp */
--viz-1..8: #7aa2f7 #9ece6a #e0af68 #bb9af7 #7dcfff #f7768e #73daca #ff9e64;
```

### 2.2 Typography / spacing / motion

- `--font-ui`: system sans stack · `--font-mono`: ui-monospace stack.
- Scale: 10/11 micro · 12 table · 13 body · 14 section · 20 KPI. Weights:
  600 headings/KPI, 500 labels, 400 body.
- 4px grid (`--space-1..6`), radius 4/8/12, one pop shadow.
- Motion: `--t-fast: 150ms`, `--t-med: 240ms`; ease-out enter / ease-in
  exit; **everything frozen under `prefers-reduced-motion`**.

### 2.3 Iconography

Inline SVG sprite (~30 Lucide-style symbols, 1.5px stroke, `currentColor`).
Event types map to icons + status color classes (`iconFor()` in `feed.js`):
power/cpu/flag/play/square/wrench/check/xcircle/refresh/send/recv/shrink/
chat/user/dotc + chrome icons. **No emoji anywhere.**

### 2.4 Primitives

`btn`/`btn-primary`/`btn-icon`, `s-chip` (status chip with tint), `card`,
`kpi`, `skeleton` (shimmer), `meter`, `[data-tip]` tooltip, `combo`
(filterable dropdown), sortable `table.lead`, dark thin scrollbars,
`:focus-visible` accent ring.

## 3. Information architecture (implemented)

```
┌──────────────────────────────────────────────────────────────┐
│ Header: ⌘K trigger · project switcher · run filter · live ●  │
├────────┬────────────────────────────────────┬────────────────┤
│ Rail   │  #content (THE scroll container)   │ Detail drawer  │
│ 196/52 │                                    │ 320–min(760,   │
│ px     │                                    │ 50vw), resize  │
├────────┴────────────────────────────────────┴────────────────┤
│ Status bar: agents events tokens cost tok/s errors · health  │
└──────────────────────────────────────────────────────────────┘
```

- Rail groups: **LIVE** (Swimlane/Single/Race) · **ANALYZE**
  (Trace/Stats/Compare) · **FIND** (Search) · **AGENTS** (per-lane toggles,
  live dots, orchestrator-group semantics). Collapses to 52px (manual,
  persisted; auto under 1100px).
- **⌘K palette**: views, projects, newest 40 runs (verdict-marked).
- **Drawer** (same `insp-*` surface for all detail): resizable, Esc closes,
  optional action button ("open in Single", "compare with previous").
- **URL hash state**: `view, project, run (trace pin), stats, a, b`.

### Layout invariants (hard-won — preserve in React)

- The app grid needs `grid-template-rows: minmax(0, 1fr)` and the main
  column `min-height: 0`, or long content grows the row and pushes the
  status bar off-screen.
- `#content` is the one scroll container; autoscroll/near-bottom logic and
  the virtualizer measure against it (not `window`).

## 4. Data & behavioral contracts (the rules React must keep)

These encode every correctness lesson from the vanilla implementation:

1. **SSE resilience**: EventSource dies PERMANENTLY in Chrome when a retry
   hits connection-refused (server restart) — recreate it on
   `readyState === CLOSED` with a retry loop. After reconnect the server
   replays its buffer: **dedupe by per-session monotonic `seq`**
   (high-water mark per lane).
2. **Verdicts are run-level annotations**: never create lanes/spans from
   them, never let them extend time bounds or agent lists (a CLI/API score
   can arrive days later on a synthetic `user` session). Last verdict by
   `ts` wins.
3. **Normalize root agents**: a parentless event's agent is the
   orchestrator (older sinks put the session NAME in `agent`); the name
   surfaces as the run name instead.
4. **Lanes key by `cwd + agent + sessionId`** (parallel same-name instances
   stay separate); **runs group by `runId`**; events of many runs
   interleave in the shared sink.
5. **Orchestrator groups**: a root lane (no parent) is a group; child lanes
   attribute to the latest same-cwd root that started before them. A pi
   `/reload` = same runId, new root session, new group. Default-visible
   group per cwd = the running root, else the latest; explicit show/hide
   overrides persist in-session.
6. **Archive vs live**: the in-memory buffer is a ring; the sink file is
   the archive. A non-live run renders from `/api/runs/:id/events` when the
   archive holds more than the lanes (`archiveHasMore`). Archived runs are
   never "running" — except during replay scrubbing, where as-of-T running
   state is the point.
7. **Replay vs zoom (Trace)**: replay filters events to `ts ≤ T`; zoom only
   re-domains the x-axis. They compose independently. Replay/zoom reset on
   run switch; reaching the end of playback snaps to live.
8. **Turn cycles (Single)**: a cycle = `turn_start(turnIndex 0)` through
   the turn before the next turn-0; alternating cycles band the background;
   separators always render regardless of filters.
9. **Context gauge**: `payload.context.percent` is % USED; the ring drains
   to % remaining; colors ok ≥40% left / warn ≥15% / err below.
10. **Stall heuristic**: an active lane quiet for `max(60s, 3× its avg
    turn)` is stalled (amber); provider errors are red. Evaluated on a
    ~500ms tick, not on events.
11. **Search**: server scans raw sink lines (case-insensitive substring);
    `run:/agent:/type:/project:` prefixes filter client-side; with only
    prefixes, the first filter value doubles as the server query.

## 5. Views — shipped behavior (parity checklist for React)

| View | Shipped behavior |
|---|---|
| **Swimlane** | Live lane cards (header: dot, label, project, rollup meta; 14-row mini feed); orchestrator cards carry the group-hide ×; hidden-group chip bar; stalled = amber border + tooltip |
| **Single** | Virtualized fixed-height rows (26px, ±30 buffer); defaults to the orchestrator lane; sticky stat header; turn separators + cycle banding; errors-only chip + regex search + category chips; row click → drawer (full args/result text); autoscroll with resume pill; context ring gauge |
| **Race** | Turn-normalized tracks grouped by project→agent-group; collapsed turns expand on click; event cards (icon, type, tool pill, summary, time·seq) → drawer; setup column; click-outside zooms out |
| **Trace** | Run combobox (sentinel "live (latest)" unless single run); ticks header + per-track gridlines; hover crosshair; drag-brush zoom (dblclick/button reset); span bars with tool ticks (err highlighted) + ↻ retry markers at their ts; playable replay (space, ←/→, ×1/4/16, slider); row → span drawer with rollup + "open in Single"; OTLP/JSONL export; skeleton while archive loads; hidden groups drop out |
| **Stats** | Scope picker (all runs / one run); KPI tiles with vs-previous-run deltas (cost/wall/errors); latency percentiles; per-agent cost bars; sortable tool table; canvas cost-over-time (crosshair+tooltip); Run history: pass-rate strip, cost sparkline, sortable, row → run drawer with "compare with previous" |
| **Compare** | A/B comboboxes (defaults: A=previous, B=latest); swap; headline A\|B\|Δ table; setup (boot) diff chips; shared-scale mini-waterfalls; per-agent and per-tool Δ tables ("only in A/B" tags) |
| **Search** | Whole-sink substring + prefix filters; recent queries datalist; skeleton while scanning; sortable results; row → drawer, run link → Trace pinned |

## 6. Known gaps (= React requirements beyond parity)

Found in the 2026-06-12 end-to-end review (vanilla keeps them as-is):

1. **Partial URL state** — hash misses: search query, header run filter,
   selected lane (Single), replay position, open drawer item. React should
   make routes/query the single source of truth (`q`, `t`, `ev`, `agents`).
2. **Header run filter shows on Compare/Search** where it's irrelevant
   (condition only excludes trace/stats). Scope it to the lane views.
3. **Picker inconsistencies** — header run filter lacks verdict marks and
   date-aware labels; Stats still uses a native `<select>`. React: one Run
   Combobox component everywhere.
4. **Single is capped by the lane ring** (4000 events/lane) with no
   indicator; older history silently missing. React: page older events in
   from `/api/runs/:id/events` (the archive) when scrolling up.
5. **ARIA depth** — the custom combobox/palette lack combobox/listbox
   roles and active-descendant wiring; the drawer doesn't move focus.
   React: use accessible primitives (Radix/cmdk or equivalent).
6. **O(lanes×events) visibility recompute** — `applyVisibility` (group
   assignment + run collection) runs per new lane and per session
   start/end; fine at current scale, structural fix = memoized selectors.
7. **No UI tests** — only the TS core is tested. React: component tests on
   the derived stores + the contracts in §4.

## 7. React implementation plan

> **Visual direction**: three static concept mockups live in
> [`mockups/`](mockups/README.md) — v1 Evolution (vanilla matured),
> v2 Observe (run-centric, glass + AI-digest pane), v3 Mission Control
> (full-bleed ops console). Pick or blend one before R1, then update this
> section.

### 7.1 Architecture

- **Location**: `utils/obs/obs-app/` (Vite root) in this repo — so the app
  can import the repo's **pure TS modules directly** instead of
  reimplementing them: `obs-events.ts` (types/parsers), `obs-explain.ts`
  (digest), plus ports of `rollup.js`/lane-derivation logic as shared TS.
- **Stack**: Vite + React + TypeScript. TanStack Query (REST), TanStack
  Virtual (feeds), Zustand (event store + UI state), Radix primitives or
  cmdk (combobox/palette/drawer a11y), our tiny canvas chart helpers
  (ported) or uPlot. Tailwind optional — if used, map its theme to the §2
  tokens; otherwise ship `tokens.css` straight from §2.
- **API**: types generated from the served spec
  (`npx openapi-typescript http://127.0.0.1:7616/api/openapi.yaml`).
  Endpoints: `/api/stream` (SSE), `/api/runs[…]`, `/api/search`,
  `/api/summary`, `/api/runs/:id/digest|otel`, `POST /:id/verdict` (the
  React app can score runs — the vanilla UI can't).
- **Dev**: Vite proxy → `127.0.0.1:7616`. **Prod**: `vite build` →
  `obs-app/dist`, served by obs-server at `/app` (one new static route,
  same flat-name guard) — same single-binary feel, no CORS in prod.

### 7.2 Data layer (build first, UI-free)

```
src/data/
  client.ts        // typed fetchers from openapi types
  stream.ts        // EventSource wrapper: reconnect-on-CLOSED loop,
                   // seq high-water dedupe, normalizeEvent (§4.1–3)
  store.ts         // Zustand: lanes/runs/verdicts/groups, derived via
                   // selectors (ports of rollup.js, assignGroups, stall calc)
  derive/          // pure, unit-tested: rollup, traceNodes, runFacts,
                   // analytics, cycles — ported from the vanilla modules
```

The vanilla view modules contain the reference implementations:
`buildTraceNodes` (trace.js), `collectRunFacts` (compare.js),
`collectAnalytics` (stats.js), `assignGroups`/`laneStalled`
(lanes.js/header.js), cycle banding (single.js). Port them as pure
functions with tests — they encode every §4 contract.

### 7.3 Component map

| Vanilla | React |
|---|---|
| shell.js + chrome.css | `<AppShell>` (Rail, Header, StatusBar, Drawer) |
| palette.js | cmdk `<CommandPalette>` |
| combobox.js | `<RunCombobox>` (one component, used by Trace/Stats/Compare/header) |
| vlist.js | TanStack Virtual in `<EventFeed>` |
| feed.js describe/iconFor | `<EventRow>` + `eventMeta.ts` |
| trace.js render | `<TraceView>` (`<SpanTree>`, `<TimeAxis>`, `<ReplayControls>`) |
| chart.js | `<LineChart>`/`<Sparkline>` (canvas, ported) |
| stats/compare/find | `<StatsView>`/`<CompareView>`/`<SearchView>` |
| hash sync (views.js) | router (TanStack Router or wouter) — full state incl. §6.1 params |

### 7.4 Phases (each shippable)

| Phase | Scope |
|---|---|
| **R0** | Scaffold, tokens.css, openapi types, data layer + derive/ ports **with tests for every §4 contract** |
| **R1** | Shell: rail/header/statusbar/drawer/palette + router (full URL state) |
| **R2** | Live views: Swimlane, Single (virtual + archive paging — closes §6.4), Race |
| **R3** | Analyze views: Trace (parity incl. replay+zoom), Stats, Compare |
| **R4** | Search, verdict scoring UI (POST /verdict), a11y pass (§6.5), perf pass |
| **R5** | Serve from obs-server `/app`, side-by-side period, then decide the default |

### 7.5 Non-goals

- No cloud/auth/multi-user. No light mode (revisit on demand). No phone
  layout (1024px floor, 768px read-only). The **server stays stdlib-only**;
  the build step is confined to `obs-app/`.

## 8. Inspiration map

| Pattern | Source |
|---|---|
| Span tree + detail drawer | LangSmith / Langfuse |
| Nav rail with grouped sections | Langfuse, Datadog, Grafana |
| Command palette | Linear, Vercel |
| Bottom status bar | IDEs, Datadog |
| Brush-zoom timelines | Honeycomb, Grafana |
| KPI deltas vs previous run | Braintrust |
| Side-by-side run diff | Braintrust / W&B |
| Pass-rate run history | Braintrust experiments |
