# Agent Observability — UI Redesign Plan

A comprehensive redesign of the dashboard (`utils/obs/obs-ui/`), grounded in the
current feature set and modeled on the interaction patterns of LangSmith,
Langfuse, Braintrust, Datadog, and Grafana. The constraint that made this tool
good stays non-negotiable: **vanilla HTML/CSS/JS, no build step, no runtime
dependencies, served by the stdlib obs-server.**

---

## 1. Current-state audit

What exists (7 views + chrome, ~1,900-line `index.html` with ~1,300 lines of
embedded CSS, 14 vanilla JS modules):

| Area | Works well | Weak |
|---|---|---|
| Theme | Consistent Tokyo-Night-ish dark palette | Flat 3-step surface ramp; `--dim` (#7a7a8c on #14141b ≈ 3.4:1) used for body-level text; no semantic token layer |
| Type | Mono suits ids/numbers | **Everything** is 13px mono — headings, nav, prose. Fatiguing, weak hierarchy |
| Nav | 7 views cover the feature set | Top tab strip + project filter + run filter + 8 stat numbers + health + conn all crammed into a wrapping header; no grouping of related views |
| Trace | Waterfall + scrubber + dispatch tags + exports | Click targets are whole rows but only lane-jump; no span detail panel; no zoom/pan |
| Single | Rich filter chips, search, context widget | Feed is an unvirtualized DOM list (caps at 4k events/lane); chips overflow |
| Race | Distinctive turn-normalized comparison | Emoji as icons (against every modern design system); dense cards with no breathing rhythm |
| Stats / Compare / Run history | Real analytics, A/B diff, regression strip | Hand-rolled tables with `innerHTML` strings; no sorting; one bespoke SVG chart |
| Inspector | Full-event JSON + copy | Bottom dock (42vh) covers content; not resizable; replaced by industry-standard right drawer years ago |
| Feedback | Live dot, stalled amber, verdict marks | Several color-only signals; pulsing dots ignore `prefers-reduced-motion` |
| A11y | — | No focus styles audit, no keyboard navigation (besides Esc), emoji icons unreadable to screen readers, contrast misses on dim text |
| Loading | "Waiting for events…" text | No skeletons; archived-run fetches show a bare string |
| Responsive | — | Desktop-only; header wraps badly under ~1100px |

## 2. Design direction

**North star: "a local-first Langfuse".** Calm, data-dense, OLED-dark developer
tool. Information density of Datadog, navigation clarity of Langfuse, trace
ergonomics of LangSmith — with zero cloud and zero build.

Principles:

1. **Chrome in sans, data in mono.** UI text (nav, labels, headings) moves to a
   system sans stack; ids, numbers, tokens, JSON stay mono with tabular figures.
2. **One detail surface.** Everything inspectable (event, span, run, search hit)
   opens the same right-side drawer. The bottom dock dies.
3. **Master–detail everywhere.** List on the left, detail on the right — the
   pattern users already know from every tracing tool.
4. **Status = icon + text + color**, never color alone.
5. **Keep the soul.** Tokyo Night hues, the Race view's playfulness, and the
   zero-dependency philosophy are features, not debt.

## 3. Design system

### 3.1 Color tokens (semantic layer over the existing hues)

```css
:root {
  /* surfaces — 5-step elevation ramp (avoid pure #000: OLED smear) */
  --surface-0: #0e0e14;   /* app background */
  --surface-1: #14141b;   /* view background (current --bg) */
  --surface-2: #1b1b26;   /* cards, nav rail (current --panel) */
  --surface-3: #22222f;   /* inputs, hover, nested (current --panel2) */
  --surface-4: #2a2a3a;   /* drawer, popovers, command palette */
  --border:    #2c2c3a;  --border-strong: #3b3b4f;

  /* text — contrast-verified on surface-1/2 */
  --text-hi:  #e2e2ec;   /* ≥ 9:1  — primary content */
  --text-md:  #b6b6c6;   /* ≥ 6:1  — body (old --fg, lifted) */
  --text-lo:  #8b8b9e;   /* ≥ 4.5:1 — secondary (old --dim, lifted) */
  --text-faint: #6a6a7e; /* ≥ 3:1  — decorative only, never data */

  /* brand + status (existing hues, kept) */
  --accent: #7aa2f7;  --accent-hover: #93b4f9;  --on-accent: #0d0d14;
  --ok: #9ece6a;  --warn: #e0af68;  --err: #f7768e;
  --info: #7dcfff;  --special: #bb9af7;
  /* tinted status surfaces for chips/rows: color-mix(in srgb, var(--ok) 12%, transparent) */

  /* data-viz categorical ramp (agents, series) — 8 steps, colorblind-checked */
  --viz-1: #7aa2f7; --viz-2: #9ece6a; --viz-3: #e0af68; --viz-4: #bb9af7;
  --viz-5: #7dcfff; --viz-6: #f7768e; --viz-7: #73daca; --viz-8: #ff9e64;
}
```

### 3.2 Typography

```css
--font-ui:   -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
/* scale: 11 (micro labels) 12 (table) 13 (body) 14 (section) 16 (view title) 20 (KPI) */
```

- Body/labels/nav → `--font-ui` 13px/1.5. Tables → 12px. KPI values → 20px/600.
- Mono **only** for: run/session ids, tool args, JSON, token/cost/duration
  columns (`font-variant-numeric: tabular-nums` so columns never jitter).
- Weights: 600 headings/KPIs, 500 labels, 400 body. (Optional self-hosted Fira
  Sans/Fira Code later — system stack first, no network fonts by default.)

### 3.3 Spacing, radius, elevation, motion

- 4px base grid: `4 / 8 / 12 / 16 / 24 / 32`. Card padding 12px (dense), view
  gutter 16px. `--radius-s: 4px; --radius-m: 8px; --radius-l: 12px`.
- Elevation = surface step + 1px border; single soft shadow only for
  drawer/palette (`0 8px 32px rgb(0 0 0 / .45)`).
- Motion tokens: `--t-fast: 150ms; --t-med: 240ms;` ease-out enter / ease-in
  exit; everything inside `@media (prefers-reduced-motion: no-preference)`.
  Live-dot pulse and bar shimmer freeze under reduced motion.

### 3.4 Iconography — kill the emoji

Inline SVG sprite (`icons.svg`, hand-picked ~24 Lucide outlines, 1.5px stroke,
`currentColor`): play, square (stop), zap (turn), wrench (tool), file-text,
brain (thinking), git-branch (dispatch), rotate-cw (retry), shrink
(compaction), alert-triangle, x-circle, check-circle, circle-dashed (open),
search, clock, coins, cpu, layers, list, bar-chart, diff, radio (live),
download, command. Verdicts become chips: `✓ pass` → `<svg check-circle> pass`.
The Race view's `emojiFor()` maps to the same sprite. ~3 KB, no dependency.

### 3.5 Primitive components (one shared CSS file)

`chip` (status/filter), `btn` / `btn-primary` / `btn-icon`, `card`, `kpi`,
`table` (sticky header, sortable, row hover, `td.num`), `input` / `select`
(consistent 28px height), `drawer`, `palette`, `skeleton` (shimmer block),
`dot` (live/stalled/error with paired label), `bar` (horizontal meter),
`tooltip` (CSS-only, data-tip). Every interactive element: visible 2px
`outline-offset` focus ring in `--accent`, `cursor: pointer`, hover state.

## 4. Information architecture

### 4.1 Layout shell (the biggest structural change)

```
┌──────────────────────────────────────────────────────────────┐
│ Header: ⌘K search · project switcher · time hint · live ●    │
├────────┬────────────────────────────────────┬────────────────┤
│ Nav    │                                    │ Detail drawer  │
│ rail   │           Active view              │ (on demand,    │
│ 64/200 │                                    │ 380–560px,     │
│ px     │                                    │ resizable)     │
├────────┴────────────────────────────────────┴────────────────┤
│ Status bar: agents · events · tokens · cost · tok/s · health │
└──────────────────────────────────────────────────────────────┘
```

- **Left nav rail** (collapsible 64px icons ↔ 200px icon+label), grouped the
  way Langfuse/Datadog group:
  - **LIVE** — Swimlane, Single, Race
  - **ANALYZE** — Trace, Stats, Compare
  - **FIND** — Search
  - Agent lane toggles (the current letter-buttons) move into a "Agents"
    section of the rail under LIVE, with full names + live/stalled dots.
  - Active item: accent left-bar + tinted background (`nav-state-active`).
- **Header slims to four things**: command palette trigger (`⌘K` —
  search-as-navigation: views, runs by name/id, agents, "score this run",
  "export OTLP"), project switcher (a proper menu instead of a bare `<select>`,
  with per-project live counts), run-filter pill (when a project is active),
  connection/live state.
- **Status bar (bottom, 28px)** absorbs the 8 header stat numbers + health
  chip — always visible, never wraps, the Datadog/IDE pattern.
- **Detail drawer (right)** replaces the bottom inspector: event JSON,
  span detail, run summary, search hit — tabbed (`Summary · Payload · Raw`),
  resizable via drag handle, `Esc` closes, deep-linkable (`#…&ev=<sess>:<seq>`).

### 4.2 URL state

Extend the existing hash permalinks: `view`, `project`, `run`, `stats`, `a/b`,
plus `q` (search query), `t` (replay position), `ev` (open drawer item),
`agents` (lane visibility). Back/forward must restore all of it
(`state-preservation`).

## 5. View-by-view redesign

### 5.1 Trace — flagship, LangSmith-style master–detail

- **Two-pane**: left = span tree (indented rows: status icon, agent name,
  model chip, duration); right = the time axis with bars. One scroll container;
  tree column sticky-left. Clicking a row opens **span detail in the drawer**
  (rollup, dispatch info, boot snapshot, slowest tools of that agent, "open in
  Single" link) instead of silently jumping views.
- **Time axis upgrades**: labeled gridlines (T+0 / 25 / 50 / 75 / 100%),
  hover crosshair with timestamp, click-drag **brush zoom** (Honeycomb
  pattern), tool calls rendered as tick marks inside agent bars, retries as
  ↻ badges at their actual time.
- **Replay scrubber** becomes a proper timeline control under the axis: play
  button (auto-advance ×1/×4/×16), draggable cursor line over the chart,
  "live" snap zone. Keyboard: ←/→ step events, space play/pause.
- Run picker → searchable combobox (runs by name, verdict chip inline, grouped
  by project) — the current `<select>` breaks past ~30 runs.
- Empty state: skeleton waterfall + one-line instruction + copyable
  `PI_OBS=1 ./run.sh …` snippet.

### 5.2 Single — virtualized log view

- Virtualize the feed (fixed row height; render viewport ±50 — removes the
  4k cap honestly). Sticky day/turn separators ("Turn 3 · 14:02:11 · 41s").
- Filter chips → one **filter bar**: severity-style quick filters
  (`Errors only`), category multiselect, regex toggle on search.
- Row anatomy: icon (sprite) · time (mono) · badge chip · one-line detail ·
  right-aligned latency/tokens. Click → drawer (not inline expand).
- Agent switcher: drawer-left list inside the view is replaced by the nav
  rail's Agents section (single source of truth).

### 5.3 Swimlane — live wall

- Lane cards on an responsive grid (`minmax(340px, 1fr)`), status icon + ctx
  meter as a thin progress bar under the header, mini-feed rows reduced to
  icon + text + time. Stalled = amber left border + `⚠ stalled 3m` chip
  (already computed). Card click → Single; card header dots get text pairing.

### 5.4 Race — keep the fun, lose the emoji

- Sprite icons in event cards; turn pills get a subtle stagger-in (30ms) under
  reduced-motion guard. Expanded turn renders in a horizontal scroll-snap
  strip. Everything else stays — it's the most original view in the product.

### 5.5 Stats — dashboard grid

- 12-col grid: KPI row (cost, tokens, turns, tools, errors, tok/s — `kpi`
  component with delta-vs-previous-run arrows), then cards.
- Replace the hand-rolled cost SVG with a small **uPlot-style canvas helper**
  (~150 lines, ours): crosshair, tooltip, hover values. Reused by Compare and
  Run history sparklines.
- Tables become the shared sortable `table` component (tool leaderboard sorts
  by any column, `aria-sort`).
- **Run history** gains per-run sparkline (cost trend), verdict chips, and row
  click → drawer run summary with "Compare with previous" button.

### 5.6 Compare — verdict-aware A/B

- A/B pickers become the same searchable combobox as Trace; swap button
  animates a crossfade. Δ chips get arrows + tooltips ("$0.60 → $1.15").
- New **side-by-side mini-waterfalls** card (one per run, same time scale) —
  the visual diff Braintrust/Langfuse lack locally.
- Boot-diff chips link to the drawer showing full before/after values.

### 5.7 Search — query language lite

- Results in the shared table; matched text highlighted in `--warn`; row →
  drawer; `run:` `agent:` `type:` prefixes parsed client-side and sent as
  filters (server already returns full events — filter post-fetch first,
  endpoint params later). Recent-queries dropdown (localStorage).

### 5.8 Header/status-bar details

- Live indicator: radio icon + "live" / "reconnecting…" text (not color-only).
- Health chip in the status bar opens a popover listing stalled/erroring lanes
  with jump links.

## 6. Cross-cutting work

- **Keyboard**: `⌘K` palette; `1–7` view switch; `j/k` row navigation in any
  list; `Enter` opens drawer; `Esc` closes; `/` focuses search; visible focus
  rings everywhere; `tab-order = visual order`.
- **A11y**: contrast pass per §3.1; `aria-live="polite"` on the status bar
  totals; `role="alert"` for health degradation; icons get `<title>`/aria
  labels; tables get `scope`/`aria-sort`; reduced-motion covered.
- **Loading/empty**: skeleton cards (shimmer) for archived-run fetches, /runs,
  search; every view's empty state = icon + sentence + action.
- **Performance**: virtualized Single feed; `content-visibility: auto` on lane
  cards; rAF-coalesced renders already exist — keep; canvas for charts; sprite
  instead of font icons.
- **Responsive floor**: usable at 1024px (rail collapses to icons, drawer
  becomes overlay); readable read-only at 768px (rail hidden behind hamburger,
  status bar scrolls). Phone support is explicitly out of scope.

## 7. Implementation plan (each phase ships usable)

| Phase | Scope | Touches |
|---|---|---|
| **P1 — Foundation** | Token layer (§3.1–3.3) mapped onto existing markup (old var names aliased to new), `styles.css` + `icons.svg` extracted from index.html, sans/mono split, chip/btn/table primitives, focus rings, reduced-motion guards | index.html → 3 files; no JS changes; pure re-skin |
| **P2 — Shell** | Nav rail (+ agent section), slim header, bottom status bar, right drawer replacing inspector, command palette, extended hash state | new `shell.js`, `palette.js`, `drawer.js`; edits to views.js/main.js/header.js/lanes.js |
| **P3 — Flagship views** | Trace master–detail + axis/zoom/scrubber upgrade; Single virtualization + filter bar; searchable run combobox (shared) | trace.js rewrite, single.js rewrite, new `combobox.js`, `vlist.js` |
| **P4 — Analytics** | Stats grid + canvas chart helper + sortable tables; Compare upgrades + mini-waterfalls; Run-history drawer; Search prefixes | stats.js, compare.js, find.js, new `chart.js` |
| **P5 — Polish** | Race sprite swap + stagger, skeletons everywhere, a11y audit (axe), 1024/768 responsive passes, screenshot regression set | all views, CSS |

Sequencing notes: P1 is risk-free and immediately improves everything; P2 is
the only structural break (do it in one PR with before/after screenshots);
P3–P5 are independent per-view PRs. Existing JS module boundaries
(state/lanes/views per-view files) survive the redesign — this is a re-skin +
shell swap, not a rewrite of the data layer. The SSE/event model, archive,
and server need **zero changes** except serving two new static files (already
generic via `/scripts/`; add `/styles.css`, `/icons.svg` routes).

## 8. Explicit non-goals

- No framework, no bundler, no npm UI deps, no web fonts by default.
- No light mode (dark-only is correct for this tool; revisit on demand).
- No phone layout (read-only 768px floor is the limit).
- No server-side rendering changes; the dashboard stays a static shell over SSE.

## 9. Inspiration map (what we're borrowing from whom)

| Pattern | Source | Lands in |
|---|---|---|
| Span tree + detail drawer | LangSmith / Langfuse trace view | Trace (P3) |
| Left nav rail w/ grouped sections | Langfuse, Datadog, Grafana | Shell (P2) |
| Command palette (⌘K) | Linear, Vercel, Datadog | Shell (P2) |
| Bottom status bar | IDEs, Datadog | Shell (P2) |
| Brush-zoom on timelines | Honeycomb, Grafana | Trace (P3) |
| KPI row with deltas | Braintrust experiment view | Stats (P4) |
| Side-by-side run diff | Braintrust / W&B compare | Compare (P4) |
| Sortable dense tables, sticky headers | Datadog | Stats/Search (P4) |
| Skeleton shimmer loading | every modern SaaS | All (P5) |
