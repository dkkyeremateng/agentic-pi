# React app — design explorations

Three static, pixel-real mockups for the React observability app
(`ui.md` §7). Each is a single self-contained HTML file with fake-but-
realistic data — open directly in a browser:

```
open utils/obs/obs-ui/mockups/v1-evolution.html
open utils/obs/obs-ui/mockups/v2-observe.html
open utils/obs/obs-ui/mockups/v3-mission.html
```

They are **concept frames, not implementations** — no JS, hand-positioned
data, one representative screen each. Their purpose is to pick (or blend)
a direction before R1 of the React plan.

---

## v1 — Evolution (`v1-evolution.html`)

**The vanilla design, matured.** Same Tokyo Night tokens, nav rail, and
status bar as the shipped vanilla app, plus the React-only upgrades:
breadcrumb header (`project / run / view`), tabbed detail drawer
(Summary · Timeline · Raw) with per-span KPI deltas and a slowest-tools
card, and an inline **Score this run** control (`POST /api/runs/:id/verdict`).

- **References**: the shipped vanilla app, LangSmith's span drawer.
- **Character**: familiar, low-risk; users of the bundled UI feel at home.
- **IA**: view-centric (pick a view, then a run) — same as vanilla.

## v2 — Observe (`v2-observe.html`)

**Clean-sheet, run-centric product.** Zinc near-black with violet/cyan
gradient accents, glass panels, large radii — Linear/Vercel material
language. Three panes: a **runs inbox** (cards with status chips, agent
avatar dots, cost/duration, activity sparkline) → the selected run as a
hero page (gradient KPI band, action row, view tabs) → an **AI digest
pane** rendering `/api/runs/:id/digest` as a narrative with typed anomaly
cards and pass/fail scoring.

- **References**: Linear (material + typography), Braintrust (experiment
  page, KPI deltas), LangSmith (run-as-entity), Superhuman (inbox IA).
- **Character**: the boldest product statement; the digest pane is the
  differentiator nobody else has locally.
- **IA**: run-centric — the run is the entity, views are tabs of it.

## v3 — Mission Control (`v3-mission.html`)

**Full-bleed ops console.** Graphite + signal-amber palette, hairline
grid instead of cards, maximum density. Top: Honeycomb-style query pills
+ a **brushable run timeline strip** (runs as verdict-colored blocks over
real time). Left: **agent small multiples** (Grafana-style tiles with
activity bars, LED lamps, retry badges). Right: compact trace with an
alerts list + a dense tail-style **event log table**. Bottom: ticker.

- **References**: Grafana (small multiples), Datadog (density, host-map
  strip), Honeycomb (query pills), terminal aesthetics (modern, not retro).
- **Character**: for watching fleets run all day; most information per
  pixel, least hand-holding.
- **IA**: time-centric — the timeline strip is the primary navigation.

---

## Comparison

| | v1 Evolution | v2 Observe | v3 Mission |
|---|---|---|---|
| Primary entity | view | **run** | **time window** |
| Palette | Tokyo Night | zinc + violet/cyan | graphite + amber |
| Material | flat cards | glass, gradients | hairline grid, no cards |
| Density | medium | medium-low | **high** |
| AI digest | drawer card | **dedicated pane** | DIGEST button |
| Risk / build cost | low | medium | medium |
| Best for | continuity with vanilla | product polish, demos | all-day monitoring |

## Decision notes

- The three are **composable**: e.g. v2's run-inbox IA + v3's timeline
  strip, or v2's visual language on v1's IA. The pick feeds `ui.md` §7
  (R1 shell) — update that section once a direction is chosen.
- All three render the same underlying data; every element shown maps to
  an existing endpoint (`/api/runs`, `/api/stream`, `/api/runs/:id/digest`,
  `POST /:id/verdict`) — nothing depicted requires new server work.
- The §4 behavioral contracts in `ui.md` apply to all of them unchanged.
