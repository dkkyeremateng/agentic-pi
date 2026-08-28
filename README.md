# pi-config

Configuration that turns [**pi**](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
into a multi-agent software-engineering workflow. A primary orchestrator drives a
team of specialized sub-agents — **scout → planner → refiner → implementer →
reviewer → validator → documenter → shipper** — through a self-healing **plan →
refine → implement → review → validate → document → ship** pipeline, each agent
running its own configurable model.

The folder is **relocatable**: copy it anywhere, on any machine, and run it with
only `.env` config — no code edits.

## Highlights

- **Team presets** — `plan-build` (full, validated), `soft-plan-build` (no
  validator), `spec` (plan only), `roadmap` (milestones for work too large for one
  plan), and `build`, which **resumes** an existing plan from the first unfinished
  phase.
- **Verifiable, recoverable runs** — per-phase checkpoints with a progress ledger,
  transient-error retries, context-bounded prompts, and a live dashboard + a
  written run report.
- **Sub-agent dispatch** — `dispatch_agent` / `dispatch_parallel` for ad-hoc
  delegation to any agent, in any session.
- **Background sessions** — run a persistent interactive pi session in `tmux`
  (`./run.sh --bg`), then attach/detach the terminal or steer it live from the
  dashboard without reattaching.
- **Observability** — an offline metrics analyzer (per-run reports + cross-project
  trends) and an opt-in live dashboard (`PI_OBS=1`) — a React app in
  [`obs/ui`](obs/ui) with eight segments (Runs, Live, Analytics, Datasets,
  Monitors, Prompts, Chat, Search), full run history, automated **evals**
  (+ optional LLM-as-judge), a versioned prompt-config registry, and an
  OpenTelemetry export — spanning every pi instance you're running.
- **Skills** — LSP diagnostics & navigation (Python/Go/TS/PHP), Playwright browser
  automation, live-Chrome control over CDP, Linear and Jira CLIs, GitHub, and
  commit helpers.
- **Per-agent models** — point each agent at a different model via `.env`; mix a
  cheap model for recon with a strong one for review/validation.
- **Config-only & portable** — everything resolves relative to itself; nothing to
  edit per machine.

## How it works

The active team's roster **is** the pipeline. A typical full run:

```
scout → planner → refiner → implementer → reviewer → validator → documenter → shipper
(recon)  (plan)   (harden)   (build)      (review)   (gate)      (README)     (PR)
```

The validator's verdict drives a feedback loop rather than a static chain:

- **PASS** → ship (the shipper opens a PR when a git remote exists)
- **FAIL** → the findings are fed back to the implementer, which fixes exactly
  those issues; the loop repeats up to `max_loops` (default 3)
- **PAUSED / UNKNOWN** → stop and surface for human review

The planner classifies the request (bug fix, feature, or new app) and the rest of
the pipeline follows. The plan is written to `.agent/plan.md` and read from disk by
downstream agents, so it is never re-threaded through the context.

## Prerequisites

- **`pi`** on your `PATH` — the only hard requirement to *run*.
- **`python3`** — for the skills (`lsp`, `linear`, `atlassian`) and Playwright.
- **Node.js + npm** — runs the observability server (via `tsx`) and builds the
  obs dashboard, and is used for type-checking/tests during development. Not
  needed to run the workflow itself.
- **`just`** (optional) — runs the [`justfile`](justfile) recipes; every one of
  them is a plain command you can also type by hand.
- **`tmux`** (optional) — only for [background sessions](#background-sessions)
  (`./run.sh --bg`); `install.sh` installs it best-effort.
- Optional per-language tools you want the agents to use: language servers for
  `lsp` (pyright, gopls, typescript-language-server, intelephense), `gh` for
  GitHub, Playwright browsers for `playwright-cli`.
- **Context-pruning package (recommended)** — `pi-context-prune` powers the
  [context management](#context-management) below. Install once; it registers in
  pi's global config and loads automatically (including in sub-agents):

  ```bash
  pi install npm:pi-context-prune  # prunes stale tool output (recommended mode: agent-message)
  pi install npm:pi-context        # OPTIONAL — only for on-context-tag mode (the context_tag tool)
  ```

  Without `pi-context-prune` the workflow still runs, relying only on pi's built-in
  compaction. `pi-context` is needed **only** if you switch the pruner to
  `on-context-tag` mode; in the default `agent-message` mode the agents'
  `context_tag` calls are just harmless bookmarks.

  **Patch the pruner for sub-agents — `npm run patch:prune`.** In `agent-message`
  mode pruning flushes only on the *final* assistant message, which never happens
  mid-run in a spawned sub-agent (`pi -p` is one user turn, many tool-calling
  messages, one final message at the end). So sub-agents carry every turn's tool
  output for the whole phase and flush once, uselessly, at the end — measured as a
  phase-implementer reaching 98.6% of a 256k window and truncating a turn, and later
  as all 12 sessions of a build logging exactly ONE flush while context grew
  monotonically and never dropped.

  The patch is **pressure-triggered with a keep-recent floor**: below
  `PI_PRUNE_AT_PCT` (default 60) of the context window it prunes *nothing* — there
  is room, and an agent's working set is worth more than the tokens — and above it
  it summarizes oldest-first while always keeping the most recent
  `PI_PRUNE_KEEP_RECENT` (default 3) batches raw.

  Two earlier attempts pruned on a schedule instead, and both failed with the window
  barely 10% full. Flushing every turn removed turn N's output before turn N+1 could
  use it: an agent reading a 113KB file looped ~30 times at 8-9k of a 1M window,
  escalating through `python3`, `dd`, `base64` and ROT13 to get its own read back.
  Keeping only the last 3 turns was better but still wrong: a planner surveying a
  codebase at 25k of a 256k window re-read the same files every ~3 minutes for 53
  turns. Pruning exists to prevent overflow, so it should fire when overflow
  threatens — not on a cadence.

  Verified behaviourally in both directions — 12 source files, one read per turn,
  then recall every file's token without re-reading:

  | | below threshold | forced (`PI_PRUNE_AT_PCT=1`) |
  |---|---|---|
  | mid-run flushes | 1 (end only) | **10** |
  | tokens recalled | **12/12** | **12/12** |
  | files re-read | none | none |

  Interactive sessions are untouched (`every-turn` keeps its upstream branch;
  `agent-message` with a UI still flushes on the final message). `-- --revert`
  restores upstream.

  **`install.sh` applies this patch for you**, right after it installs the pruner —
  it is part of installing it, not an optional extra. But `pi update` replaces the
  package and wipes the patch, and an upgrade never re-runs the installer, so
  **`run.sh` checks for the patch marker at startup and warns when it is gone**.
  That check is the thing that actually catches an upgrade; it warns rather than
  blocking, because an unpatched pruner degrades a run without breaking it. Restore
  with `npm run patch:prune`.

  The installer also sets `showStartupNotice: false` in
  `~/.pi/agent/context-prune/settings.json` to suppress the per-session "pruner
  loaded" banner — and only when the key is absent, so an explicit choice is never
  overwritten. This used to require editing the package source; upstream now has a
  real setting for it.

  **Suppress pi's `Model:` status line — `npm run patch:statusline`.** Optional and
  separate: every model switch pushes a `Model: <id>` line into the transcript,
  where it stacks up in scrollback, while the footer already shows the active
  model. This one edits pi's own package, so **neither `install.sh` nor `run.sh`
  runs it** — it is opt-in, idempotent, and `-- --revert` puts it back.

  It finds its target by content rather than by path, because pi moves files:
  0.84.3 relocated `dist/core/interactive-mode.js` to
  `dist/modes/interactive/interactive-mode.js`, which silently invalidated the
  hand-edit this script replaced.

### The sticky widget is a status line, not a dashboard

The terminal widget shows **at most 6 rows**:

```
build ▸ Implement 1/4 · 1m 7s · $0.141
  ▸ Implementer  ● running 14s · 3 tools  ◆ gfr_local/gateframe_ionix/dspark  $0.0088  6.0%/256K
    Reviewer     ◌ queued
    Shipper      ◌ queued
  Todos 1/3
    [x] Phase 1: Add the `:root` design-token block
    [•] Phase 2: Rewrite component rules to reference the tokens
    [ ] Phase 3: Automated literal audit (regression gate)
→ read path=.agent/plan.md
✓ read
```

The header carries the whole workflow's wall-clock and what the agents have cost
between them — both distinct from the per-agent figures on the rows below. The total
is summed from the phases on screen, including the agent still running, so it can
never disagree with the column beneath it. Context stays off the header: each agent
has its own window, so one figure there would answer a question nobody asked.

Three levels: the header at the margin, sections indented under it, their entries
under those. The tool trail runs **flush at the margin**, outdented from the whole
status block — it is the agent's raw output, not another field of the dashboard, and
at the ledger's indent the two read as one undifferentiated block.

Both ledgers — Todos and Review — render the same way, and are styled to read as their own block rather than more log: done in the
success colour, the phase in flight in the accent colour **and bold** (the only bold
text in the widget, so it is what your eye lands on), everything else muted — all
distinct from the trail's dim. It is listed in full when it fits, with `[•]` on the
phase being worked on (one per worker, so a parallel wave marks each phase it is on). When the rows are
not there it collapses to `todos 2/3` rather than showing a partial list — a
truncated ledger reads as the whole list, which is worse than a count.

Each agent carries its own spend and context usage, in aligned columns so they can
be scanned down the roster. The model an agent ran on stays on its row after it finishes, marked `⚠` instead of
`◆` when it is a fallback rather than the configured choice. The header row
deliberately repeats none of this — per agent is the useful cut, and the footer
already reports the session totals. Agents that have not run show neither — `$0.00 · 0.0%`
on a queued row is just noise — and there is no usage bar, since it duplicates the
percentage beside it.

The whole selected team is listed, one row each — what is done, what is in flight
(marked `▸`), what is still queued — because during a run the question is where the
pipeline is up to. Below it, the running agent's tool trail fills the remaining
space. When rows are scarce the roster gives them up first and counts what it
dropped (`+7 more`): knowing *what* is happening beats knowing who is queued.

On startup, before a run, it lists the whole roster — every agent and the model it
will run on — filling the space and counting any overflow:

```
 agent-workflow · 13 agents · 6 teams
   /agent-workflow <request>   ·   dashboard: PI_OBS=1

   Scout        ◆ gfr_local/gateframe_ionix/dspark  256K
   Planner      ◆ gfr_local/gateframe_ionix/dspark  256K
   Implementer  ◆ anthropic/claude-opus-5           1.0M
   …
```

Each row carries the model that agent will run on and its context window, resolved
the way the cards did (the agent's frontmatter wins, else the registry's window for
the model it resolved to). The columns are padded so an agent pointed at a different
model — the usual reason to look at this screen — stands out instead of being buried
mid-line.

It used to render a five-card grid, per-agent context bars, a todo ledger, a review
checklist and a live log — about **40 rows**, four times pi's `MAX_WIDGET_LINES`
budget of 10. A sticky region that large competes with the renderer for the screen:
it has to be height-managed, it pushes the transcript around, and rows a previous
frame left behind stay visible (the duplicated `# Todos` header and the agent card
that grew a `running Ns` line every second). Every rendering problem the dashboard
had came from its size.

None of that detail needed to be in a non-scrolling region. [`obs/ui`](obs/ui)
already shows runs, live agents, analytics and full history, and pi already streams
each sub-agent's tool trail into the transcript — both of which scroll. What a
terminal status line is for is "is it moving, where is it, what is it costing".

```bash
PI_WORKFLOW_WIDGET=full ./run.sh    # restore the old five-card dashboard
PI_WORKFLOW_REPAINT_MS=4000 ./run.sh  # force periodic repaints (only `full` needs this)
PI_WORKFLOW_DEBUG_WIDGET=1 ./run.sh   # dump the widget array to ~/.pi/agent/pi-widget.log
```

**The agent's tool trail** fills the space below the status lines, newest closest to
the prompt — a tall window shows a long trail, a short one shows a few rows. It
reserves 6 rows for the transcript and whatever the editor and footer need; pin it
with `PI_WORKFLOW_ACTIVITY_LINES` (`0` for status only).

**Growing past pi's 10-row budget re-arms the repaint pulse automatically.** Inside
the budget the renderer does not strand rows and a periodic repaint would be pure
flicker; past it, a displaced live region leaves rows behind and only an absolute
repaint clears them. The two are coupled in code (`repaintIntervalFor`) so the
mitigation is armed by the condition that makes it necessary, rather than by a flag
someone has to remember. `PI_WORKFLOW_REPAINT_MS` overrides either way.

When the workflow runs as a **tool call** (the agent invoking `run_agent_workflow`)
the same trail also streams into the transcript as an updating result block —
scrollable, with history. The `/agent-workflow` **command** path cannot do that: pi
exposes only `notify` to a command, which appends a message rather than updating a
block, so there the widget tail is the live view. `PI_WORKFLOW_STREAM=0` disables
the transcript stream.

No pi package is modified. The card/grid builders are still there and still tested —
`full` uses them, and they are what a future on-demand overlay would reuse.

## Quick start

```bash
./install.sh                 # one-time setup (macOS/Linux): pi CLI + deps + types + context pruner + .env
# edit .env to set your models / API keys, then:
./run.sh                     # loads dispatch + interactive + agent-workflow + footer + revert
```

[`install.sh`](install.sh) sets up everything to run/develop the workflow and the
observability server, including building its dashboard — the React app in
[`obs/ui`](obs/ui), whose build output is not in the repo. Already have `pi` and
the deps? Just `cp example.env .env` and `./run.sh`.

If you have [`just`](https://github.com/casey/just), the [`justfile`](justfile)
wraps these and the rest of the day-to-day commands — `just` on its own lists
them, grouped by setup / run / ui / test / metrics / docker:

```bash
just install                 # ./install.sh
just obs                     # pi + the dashboard server
just ui-build                # rebuild obs/ui after editing it
just verify                  # both test suites, both typechecks, a dashboard build
```

The recipes are thin wrappers, so `install.sh`, `run.sh` and the npm scripts
stay the source of truth and nothing has to be kept in sync.

`run.sh` loads the extensions resolved relative to itself, so you never edit pi's
global settings per machine. Then, inside pi:

```
/agent-workflow add rate limiting to the public API
```

…or just ask the primary agent to do non-trivial work and it will dispatch the
pipeline itself. You'll be asked to pick a team, then the run streams on a live
dashboard and writes `workflow-report.md` at the end.

### Background sessions

A normal `./run.sh` is an interactive session and needs a terminal, so plain
`&`/`nohup` can't keep one usable. `--bg` hosts a **persistent** interactive
session in [`tmux`](https://github.com/tmux/tmux) instead — attach and detach at
will, and (emission is on by default) drive it from the dashboard's live chat
without ever reattaching the terminal:

```bash
./run.sh --bg [name]          # start a detached session (default name: pi-<dir>)
./run.sh --attach [name]      # attach to it (detach again with Ctrl-b then d)
./run.sh --bg-list            # list background pi sessions
./run.sh --bg-stop [name]     # kill it
```

`--bg` turns emission on **and starts the dashboard server if it isn't already
running** (a shared server that outlives the session — stop it with `./run.sh
--stop`), so the session is immediately observable. It registers a control
channel, so it shows up under the **Active** filter and can be steered from
**Chat** (see [Observability](#observability)). Extra flags pass through, so
`./run.sh --bg work -- -n "nightly"` also names the underlying pi session.
Requires `tmux` on `PATH`.

## Using the workflow

### Slash commands

| Command | What it does |
|---------|--------------|
| `/agent-workflow <request>` | Run the full lifecycle on a request (prompts for a team). |
| `/agent-workflow roadmap <request>` | Milestones only — runs the `roadmap` team (scout → roadmapper), writing `roadmap.md`. |
| `/agent-workflow spec <request>` | Plan only — runs the `spec` team (scout → planner → refiner). |
| `/agent-workflow-clear` | Clear the progress widget. |
| `/agent-model` | List per-agent models; `/agent-model <agent> <model>` to set, `/agent-model <agent> reset` (or `/agent-model reset`) to clear — for this session only. |
| `/revert` | Restore the workspace to the checkpoint taken before the last run (current state is stashed first). |

### Tools (callable by the primary agent, or any agent that has them)

| Tool | Purpose |
|------|---------|
| `run_agent_workflow { request, team?, max_loops? }` | Launch the pipeline programmatically. `team` selects a preset; `max_loops` caps the review/validate retry loop (default 3). |
| `dispatch_agent` | Delegate one task to a specific agent and get its result. |
| `dispatch_parallel` | Fan a set of tasks out to several agents at once. |
| `select_agents` | Let the orchestrator choose which agents to dispatch for a request. |

### Teams

Defined in [`agents/teams.yaml`](agents/teams.yaml) — the roster is the pipeline.

| Team | Roster | Use |
|------|--------|-----|
| `plan-build` | scout → planner → refiner → implementer → reviewer → **validator** → documenter → shipper | Full, independently validated. |
| `soft-plan-build` | scout → planner → refiner → implementer → reviewer → documenter → shipper | Skips the validator's full re-run — faster/cheaper. |
| `roadmap` | scout → roadmapper | Cut work too large for one plan into milestones (`roadmap.md`). |
| `spec` | scout → planner → refiner | Produce a reviewable plan only (no code). |
| `build` | implementer → reviewer → validator → documenter → shipper | **Resume** / build from an existing `.agent/plan.md`. |

### Keeping the README honest

The `documenter` phase updates the project's `README.md` at the end of a run. It is
gated on the same condition as the shipper — the run must have **passed** — so the
README never advertises work that did not land, and it runs **before** the shipper
so the README change is committed with the change it describes.

It edits rather than regenerates: it reads the existing README first and preserves
every section that is still accurate, verbatim. Badges, licence, contribution notes
and your prose are not its to rewrite; it corrects what the run made untrue and adds
what is now missing. Commands and paths are verified against the real
`package.json`/`Makefile`/`go.mod` (or your `AGENTS.md`, which wins) before being
written, so a README cannot promise a command that does not run. Its only write is
`README.md`.

A failure here is not fatal — the work is already validated, so the run still ships
and you get a warning to update the README by hand.

### Work too large for one plan

A big spec does not fit in one implementation plan, and forcing it produces a plan
whose phases are each a week of work. The `roadmap` team adds a level above the
plan:

| | Milestone | Phase |
|---|---|---|
| Lives in | `roadmap.md` (project root) | `.agent/plan.md` |
| Lifetime | many runs — survives `resetRunScratch` | one run — wiped on the next |
| Written by | `roadmapper` | `planner` |
| Sized for | one plan-and-build run | one dispatched worker |
| Ticked off by | **you** | the implementer |

Run the roadmap once, then a `spec` run per milestone. When `roadmap.md` exists the
orchestrator resolves the **first milestone still `- [ ]`** and names it in the
planner's task, quoting that milestone's section so its `Scope` and `Done when` are
in front of the planner verbatim. Which milestone is next is therefore decided by
code, not by a model scanning the file — and the same resolved number is what gets
ticked off afterwards, so a planner that forgets the machine-read `Milestone: N`
line no longer breaks the loop. The rest go under Deferred:

```
/agent-workflow roadmap break down the architecture in spec.md   # -> roadmap.md, N milestones
/agent-workflow spec                                             # -> plans milestone 1
/agent-workflow continue the implementation                      # -> build team
# then tick `- [x] Milestone 1` in roadmap.md yourself, and run `spec` again for milestone 2
```

The orchestrator ticks a milestone off when the run that built it earns it, and
stamps the evidence:

```
## Milestone 2: Ingestion
- [x] complete — 2026-08-11, validator PASS, https://github.com/o/r/pull/7
```

The gate is conjunctive, because "shipped" alone is too weak a claim: the roster
must have included a **validator** (an independent re-run, not the implementer's own
GREEN), **every phase** in `.agent/progress.md` must be done, and the plan must have
named which milestone it was building (`Milestone: 2 of 9`). A `soft-plan-build` run
never ticks anything — it has no validator. Already-complete milestones are never
restamped, so a re-run cannot rewrite history, and you can still tick one by hand.
Set `PI_ROADMAP_AUTOTICK=0` to keep it fully manual.

No agent writes to `roadmap.md` — only the roadmapper, which preserves every
existing `[x]` when it re-runs, and the orchestrator, which is deterministic code
holding the validator verdict rather than a model reporting on its own work.

### Resuming a build

A run that fails or stops mid-implementation can be continued without redoing the
planning. The `build` team has no planner, so when `.agent/plan.md` already exists
it **keeps** the plan and the progress ledger and the implementer **picks up from
the first unfinished phase** (`.agent/progress.md`), reusing the work branch and
its `wip` commits:

```
# after a spec run, or a failed plan-build run:
/agent-workflow continue the implementation   # pick the `build` team
```

(If a `build`-style team is run with no plan on disk, it errors and tells you to
run a planning team first.)

### What you'll see

- **Live dashboard** — per-agent cards (status, model, context usage) and the
  pipeline with progress, plus two live checklists during a run: a **`# Todos`**
  panel mirroring the implementer's phases as they tick `[ ] → [x]`, and a
  **`# Review`** panel ticking the reviewer's checklist (Plan conformance,
  Correctness, Tests, …) as it works.
- **Footer** — a dim `~/path: branch ✔` line (cwd + git branch + clean/dirty mark)
  above the orchestrator's model, run status, and its context-usage bar + cost.
  Other extensions' status lines surface below it (e.g. the context pruner's
  `prune: …`). It's a standalone `pi -e extensions/footer.ts` extension that also
  works on its own (without the workflow) as a minimal model + context footer.
- **`workflow-report.md`** — the end-of-run report (requirement, files changed,
  suite/diagnostics results, verdict, branch/commits, PR link or next steps).
- **`.agent/`** scratch — `plan.md` (and `plan.draft.md`), `progress.md` (phase
  ledger), `metrics.json`/`metrics.jsonl` (run metrics for the analyzer),
  `checkpoints/` (for `/revert`), `screenshots/` (browser QA). Gitignored.
- **`docs/plans/`** — optional permanent plan archive per run (opt-in; see
  `PI_WORKFLOW_ARCHIVE_PLANS`).

## Agents

Definitions live in [`agents/`](agents/) as Markdown with frontmatter (model,
tools). See [`agents/README.md`](agents/README.md).

| Agent | Role |
|-------|------|
| `scout` | Read-only codebase recon (grounds the plan in real files). |
| `planner` | Produce the implementation plan. |
| `refiner` | Verify and harden the plan against the real code. |
| `implementer` | Build the change in verifiable phases (TDD, per-phase checkpoints). |
| `reviewer` | Static review of the diff against the plan. |
| `validator` | Independent gate — re-runs the build/tests/LSP; PASS/FAIL. |
| `shipper` | Squash `wip` commits, stage docs, open a PR. |
| `seeker` | Browser automation, web research, and UI/QA (via the `playwright-cli` and `chrome-agent` skills). |
| `linear` | Linear issue tracking. |
| `atlassian` | Jira tickets (read/update via the REST API). |

## Skills

On-demand capabilities in [`skills/`](skills/). Most are stdlib-only Python CLIs;
each is an optional one-time install that puts a command on your `PATH`.

| Skill | What it gives the agents | Install |
|-------|--------------------------|---------|
| `lsp` | Type/compile **diagnostics** + **navigation** (def/refs/hover/symbols) for Python/Go/TS/PHP. The implementer and validator run `lsp diagnostics` as a required check. | `bash skills/lsp/install.sh` (then install the language servers you use) |
| `playwright-cli` | Playwright browser automation — headless browsing, scraping, screenshots, UI testing. | see `skills/playwright-cli/SKILL.md` |
| `chrome-agent` | Drive a **real Chrome over CDP** — any protocol command one-shot, any event streamed via `attach`. For live/observable browsers, network + console forensics, and human-agent sharing. | `uv tool install chrome-agent` (needs system Chrome) |
| `linear` | Linear GraphQL CLI. | `bash skills/linear/install.sh` (`LINEAR_API_KEY`) |
| `atlassian` | Jira Cloud REST CLI. | `bash skills/atlassian/install.sh` (`ATLASSIAN_*`) |
| `github` / `commit` | GitHub (`gh`) recon helpers and commit conventions. | — |

```bash
linear issues --assignee me --active     # after installing the linear skill
atlassian tickets                        # after installing the atlassian skill
lsp diagnostics src/app.ts               # diagnostics for one file
lsp servers                              # which servers this project needs + install status
```

## Configuration

All settings live in `.env` at the folder root (loaded as global config — no
allowlist). See [`example.env`](example.env) for the full, commented list. Common
ones:

| Variable | Purpose |
|----------|---------|
| `PI_WORKFLOW_MODEL` | Global fallback model for all agents. |
| `PI_AGENT_<NAME>_MODEL` | Per-agent model (e.g. `PI_AGENT_IMPLEMENTER_MODEL`). Accepts pi's `[provider/]id[:thinking]` form — e.g. `gfr_prt/gateframe_yoda/qwen-max-3-7-yoda-2:low` pins a provider and thinking level; a bare `id` or `id:thinking` uses the default provider. (Set thinking lower for recon/review agents to avoid output-token truncation.) The dashboard context-window comes from pi's model registry. |
| `PI_DISPATCH_MAX_DEPTH` | How deep dispatch may nest (default 1; a cycle guard is always on). |
| `PI_MAX_DISPATCHES_PER_TURN` | Breadth cap on dispatches per turn. |
| `PI_AGENT_TRANSIENT_RETRIES` | Same-model retries on transient errors (interrupted stream, dropped connection, 429/502/503/504/529). |
| `PI_WORKFLOW_AGENT_TIMEOUT` | Per-agent watchdog (minutes; 0 = off). |
| `PI_CONFINE_CWD` | Confine sub-agents' file tools to the working directory. |
| `PI_PRUNE_AT_PCT` | Context-window % at which a headless session starts pruning at all (default 60). |
| `PI_PRUNE_KEEP_RECENT` | Turns of tool output never summarized, even under pressure (default 3). |
| `PI_ROADMAP_AUTOTICK` | `0` stops the orchestrator ticking milestones off `roadmap.md` on a validated run. |
| `PI_WORKFLOW_ARCHIVE_PLANS` | Archive each run's final plan to `docs/plans/`. |
| `PI_WORKFLOW_APPROVE_PROJECT` | Force project-trust `--approve` on/off for spawned agents (see below). |
| `PI_NOTIFY` | Desktop/terminal notifications when a run finishes. |
| `LINEAR_API_KEY`, `ATLASSIAN_SITE` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` | Skill credentials. |

### Project trust (pi ≥ 0.79)

Run `/trust` once in your project so the **headless sub-agents** inherit its
project-local inputs (`AGENTS.md`/`CLAUDE.md`, `.pi` settings/skills). Without a
saved trust decision, headless pi silently ignores those, so the workflow
auto-passes `--approve` to spawns **only when the project is trusted**. Override
with `PI_WORKFLOW_APPROVE_PROJECT=1` (force on, e.g. session-only trust) or `=0`
(force off).

## Resilience & recovery

- **Transient retries** — interrupted streams, dropped connections, and
  `429/502/503/504/529` are retried on the same model (bounded by
  `PI_AGENT_TRANSIENT_RETRIES`) instead of failing the run.
- **Per-phase checkpoints** — the implementer commits `wip(phase N)` on a work
  branch and tracks `.agent/progress.md`, so a failed run can resume (see
  *Resuming a build*) and the shipper squashes the wips into clean commits.
- **`/revert`** — restore the pre-run state if you don't like the result.
- **Context bounding** — agent outputs and shared context are clamped so a long
  run can't blow the context window (see *Context management* for the pruning layer
  on top).

## Context management

Long runs are kept inside the model's context window by two complementary layers:

1. **pi's built-in compaction** (always on, no setup) — as a session nears the
   window, pi summarizes the older messages and keeps the most recent. The coarse
   safety net.
2. **pi-context-prune** (the third-party package from *Prerequisites*) — precise,
   lossless, **cache-aware** pruning of *verbose tool output* (file reads, command
   output, sub-agent dumps) once it has been used. Originals stay retrievable via the
   `context_tree_query` tool, and the session file on disk is never modified.

**Recommended mode: `agent-message`** (the package default). A prune flushes
automatically after each final agent reply — no agent has to remember to do
anything — batching a whole tool-using run and pruning it once, so the next request
becomes cacheable again. This is the most robust choice for a multi-agent workflow:
it behaves the same for the orchestrator and every headless sub-agent, with **no
reliance on a model calling a tool**. For the workflow's bursty requests (one ask
triggers many back-to-back dispatch/read rounds), pair it with `batchingMode:
agent-message` so all those rounds merge into one cohesive summary:

```
/pruner prune-on agent-message
/pruner batching agent-message
```

**Alternative: `on-context-tag`** — prunes only when an agent calls **`context_tag`**
(from the optional `pi-context` package), batching by explicit milestone. The agents
are prompted to tag at natural boundaries — the **implementer** after each completed
phase (alongside the `.agent/progress.md` update), the **orchestrator** after each
`run_agent_workflow` run / dispatch / delivered file — so this can be marginally more
cache-friendly *when tagging is reliable*. The catch is that it depends on the model:
a session whose agent skips `context_tag` never prunes (the footer just shows
"N turns queued — will summarize on next context_tag"). Prefer `agent-message` unless
you specifically want milestone batching. (`every-turn` busts prompt caches and is
debug-only; `agentic-auto` and `on-demand` exist too — see `/pruner help`.)

Because `pi-context-prune` (and, for `on-context-tag`, `pi-context`) are registered in
pi's global config (`packages` in `~/.pi/agent/settings.json`), they load in **every**
pi process, including the spawned sub-agents. Pruning settings (enable/disable,
trigger mode, batching, summarizer model) live in pi's global config at
`~/.pi/agent/context-prune/settings.json` — **not** this folder's `.env`. Inside pi,
`/pruner` views or changes them and `/pruner stats` shows how much it has reclaimed.
A cheaper summarizer model (`/pruner settings`) cuts the per-flush LLM cost.

## Observability

Two layers measure what a run actually costs, where it spends time, and where it
stalls — the *trifecta* (cost / tokens / speed) plus pipeline facts (per-phase
breakdown, retries, ship outcome, context-prune savings).

**Offline analyzer (always available).** Every run writes a structured
`.agent/metrics.json` (latest) and appends `.agent/metrics.jsonl` (one line per run);
the analyzer also reads `workflow-report.md` and the per-agent pi session logs.

```bash
npm run metrics -- <project>          # single-run report (trifecta + per-phase + detail)
npm run metrics -- --all <root>       # cross-run trends across projects
npm run metrics -- <project> --json   # machine-readable
```

Trends include cost/run, validator pass rate, retry rate, slowest/costliest phase, and a
per-project rollup. The `metrics` skill wraps the same CLI for the agent to call.

**Live dashboard (opt-in, `PI_OBS=1`).** With observability on, the orchestrator and
every sub-agent append canonical events to a shared sink (`~/.pi/agent/obs/events.jsonl`
by default): a one-time **boot snapshot** (selected tools, loaded skills, context files +
hashes, system-prompt size/hash), then turns, tool calls (with **execution latency**),
tokens, cost, **per-turn throughput (tok/s)**, model changes, compaction, the run's
**verdict** (pass/fail/paused), and **provider errors**. A dependency-free Node server
tails that file and streams it to the browser over SSE. The dashboard is the React
app in [`obs/ui`](obs/ui), served by the same server at `/` (and `/app/`), with
eight segments:

- **Runs** — the inbox: filter by status, date window, project, and free text, with
  low-signal no-op runs folded away. Opening a run gives its hero metrics
  (cost/tokens/duration/verdict), a digest pane (narrative, anomaly cards, pass/fail
  scoring) and six tabs — **Trace** (span tree with per-span I/O), **Timeline**
  (zoomable gantt + scrubbable replay), **Events** (turn-banded feed), **Stats**,
  **Evals**, and **Raw** (JSONL). Open runs stream live into every tab.
- **Live** — an agent wall off the event stream: a card per session with rollups, a
  live tail, throughput, stall badges, and which sub-agents the orchestrator is
  blocked on. Pausable (buffers rather than drops).
- **Analytics** — KPI strip, throughput chart, run history, and **Compare** A/B: a
  side-by-side diff of any two runs (headline metrics, per-agent and tool usage,
  and setup changes from the boot snapshots).
- **Datasets** — curated run sets (a regression suite, a golden set, a
  known-failures bucket) tracked by their aggregate evaluator scores.
- **Monitors** — thresholds on cost, latency, eval score, or error rate; breaches
  raise alerts in the header and can relay to a webhook.
- **Prompts** — the versioned per-agent boot snapshots (prompt hash, model, tools,
  skills, context files), plus a one-shot prompt playground.
- **Chat** — talk to an agent with streaming replies and attachments; a chat can
  attach to a live run and steer it, with an optional approval gate on its tools.
- **Search** — server-side substring search over **every run ever recorded**, with a
  `tool:` / `status:` / `agent:` / `model:` / `run:` prefix grammar and a facet rail.

Automated **evaluators** grade a run against cost / duration / tool-call budgets, and
with `PI_OBS_LLM=1` an **LLM-as-judge** rubric adds a 0–100 score (cached per run);
run explanations, I/O summaries, the playground and Chat need the same flag. A
**⌘K command palette** jumps to any segment, project, or run, and every view is
linkable via the hash router (`#/<segment>[/<runId>/<tab>]`).

The UI's own [README](obs/ui/README.md) documents its architecture, configuration
and deploy modes — including pointing one deployed dashboard at several agents
with `?api=<obs-url>`.

**Its build (`obs/ui/dist`) is a derived artifact and is not tracked.**
`install.sh` produces it and the Docker image builds its own (in a first stage,
so the React toolchain stays out of the runtime layer). The server reads the
build, not the sources, so after changing `obs/ui/src` run `just ui-build` (or
`npm run build` there). Until a build exists the server and `/api` work normally
and the dashboard route answers **503** with that instruction rather than a bare
404.

**Its config lives in this repo's `.env`**, not a second file — `vite.config.ts`
points Vite's `envDir` at the repo root, so `PI_OBS_URL` (which obs-server the
dev proxy targets) sits beside the `PI_OBS_TOKEN`/`PI_OBS_PORT` it pairs with.
None of it is needed to *use* the dashboard; it only affects `just ui-dev` and
custom builds. See the "dashboard UI" section of [`example.env`](example.env).
Only `VITE_`-prefixed vars reach browser code, so the other secrets in `.env`
never enter the bundle — and by the same rule anything you *do* prefix with
`VITE_` is public, which is why a `VITE_PI_OBS_TOKEN` makes the build warn.

**Run history & selection.** The server indexes the whole sink by run, so the dashboard
isn't limited to the live tail: `/runs` lists **every run ever recorded** and any one's
events are fetched on demand. A run picker (per-view on Trace/Stats/Compare, plus a header
filter that scopes the lane views) defaults to the **live run** (green live dot) and labels
runs by their **session name** when one was set (`pi.setSessionName`), else by timestamp;
runs beyond the live buffer are marked `archived`. A header **recency filter** windows the
whole run set (last day / week / month / max) — it only offers a window when some runs fall
inside it and some outside, keeps the open run pinned, and is permalinked (`?since=`).

Every event is tagged with a **trace id** (`runId`, shared across the orchestrator and the
agents it dispatches) and a **parent** (the agent that dispatched it), so a whole workflow
reads as one trace. The orchestrator also emits **dispatch lifecycle events**
(`dispatch_start`/`dispatch_retry`/`dispatch_end`) carrying why a sub-agent re-ran
(empty output, or output-token truncation) and a final **verdict**. Parallel instances of
the same agent stay distinct (their own lanes/spans, `#n` labels).

Because the sink is shared, **multiple pi instances across different projects stream into
one dashboard** — events carry their `cwd`, so lanes stay separated by project and a
project filter in the header scopes the views. To scope obs to one project instead, add
**`--project`** (alias `--cwd`): the collector emits to and the server tails a
per-project sink under `~/.pi/agent/obs/<cwd-slug>-<hash>/events.jsonl`, named like
pi's session folder (e.g. `-Users-me-Documents-Dev-slf-ai-p-0d3c1ef2`). Equivalently,
set `PI_OBS_SINK` to any path yourself, or point the server at one project with
`npm run obs:server -- <project>`. A read-only **`/api`** is exposed for external UIs,
including `/api/runs` + `/api/runs/:id`, `/api/prompts` (the **versioned prompt-config
registry** — each agent's boot config — system-prompt hash/size, tools, skills, context
files — tracked as versions across runs), and, gated on `PI_OBS_LLM=1`,
`/api/runs/:id/judge` (the LLM-as-judge score) and `/api/playground` (a one-shot
prompt sandbox). `POST /api/notify {url, payload}` relays a monitor alert to a webhook.

**Chat into a live agent (`/api/live-sessions`, `/api/chat-live`).** Every running
agent (with `PI_OBS=1`) opens a per-process **control channel** (a Unix socket +
metadata sidecar under `~/.pi/agent/obs/control/`). `GET /api/live-sessions` lists the
sessions alive *right now* — the only attachable ones — and `GET /api/chat-live`
**steers** one: your prompt is injected into that running pi instance
(`pi.sendUserMessage`, delivered as a follow-up) and the agent's reply streams straight
back over SSE, token by token. The channel exists only while the process does and the
server prunes dead ones by pid, so you can only chat into a live, active session; when a
session ends mid-chat the caller gets a clean *"no longer live"* error. The whole path is
best-effort and never disrupts the agent — opt out entirely with `PI_OBS_CHAT=0`.

```bash
./run.sh                              # pi only
./run.sh --obs                        # pi + the dashboard (http://127.0.0.1:7616)
./run.sh --obs --project              # …scoped to this project's sink (cwd), not the global one
./run.sh --emit                       # pi with emission ON but no server (use with a running --server)
./run.sh --server                     # the dashboard server only (background; prints a pid to stop)
./run.sh --server --project           # …server only, tailing this project's sink (cwd)
./run.sh --server -- --port 8000      # …server only, on a custom port / project
./run.sh --restart                    # stop the server on $PORT, then start it fresh (reload edited obs/*.ts)
./run.sh --stop                       # stop the dashboard server on $PORT
# equivalents:
npm run obs:server                    # same as `./run.sh --server`
PI_OBS=1 ./run.sh                      # same as `./run.sh --obs`
```

Run the dashboard once and observe many pi sessions: `./run.sh --server` (start
it, leave it running), then `./run.sh --emit` for each pi run you want on the
dashboard. Both default to the same shared sink, so the events show up live.

`./run.sh --obs` starts the dashboard server in the background (port `PI_OBS_PORT`,
default 7616) and stops it when pi exits; it needs the dev deps (`npm install`).

**Expose it via Tailscale serve.** The server binds to `127.0.0.1` (the open `/api`
CORS is safe only because nothing but loopback reaches it, and auth is off by
default), so to view the dashboard from another device without exposing it to the
network, front it with [Tailscale serve](https://tailscale.com/kb/1242/tailscale-serve):
with the server running, `tailscale serve 7616` proxies it over your tailnet (auth +
TLS via Tailscale) at `https://<machine>.<tailnet>.ts.net/`. Use `tailscale funnel 7616`
only if you intend it to be reachable from the public internet. Run
`tailscale serve --https=443 off` to stop sharing.

**Require a token (`PI_OBS_TOKEN`).** Auth is opt-in and off by default (loopback-only).
Set `PI_OBS_TOKEN` (in `.env` or the launch env) and every data and control route
requires it — `Authorization: Bearer <token>`, or `?token=` for the SSE streams that
use `EventSource`. The dashboard prompts for it and caches it in `localStorage`; the
static shell stays open only so the page can load. The control routes can steer a live
agent, so set a token whenever the server is reachable beyond your own loopback (e.g.
behind Tailscale or a proxy). Generate one with `openssl rand -hex 32`. Details in
[`obs/API.md`](obs/API.md#authentication).

**Talk to it from Telegram (`./run.sh --bridge`).** A messaging bridge lets you
chat with your observability from your phone. It **long-polls** the Telegram Bot
API (no inbound webhook, so the obs-server stays on loopback) and maps messages
onto the API: free text chats with the assistant (it knows your runs; needs
`PI_OBS_LLM=1`); `/runs`, `/last`, `/digest <id>`, `/search <text>`, `/live`,
`/pass`/`/fail` inspect and score runs; `/attach <run-id>` binds the chat to a
**live run** so your messages drive that orchestrator until you `/detach`; and
`/dispatch <agent>, <prompt>` runs a single agent standalone (no run needed —
file tools confined to `PI_OBS_TG_CWD`, and bash too with an OS sandbox via
`PI_OBS_DISPATCH_SANDBOX`; needs `PI_OBS_DISPATCH=1`). Replies
**edit-stream** — one message
grows as tokens arrive. Set `PI_OBS_TG_TOKEN` (a [@BotFather](https://t.me/BotFather)
token) and `PI_OBS_TG_ALLOW` (the chat ids allowed — fail-closed; message the bot
once and it replies with yours), then `./run.sh --bridge` — which **cold-starts the
obs-server on `$PORT` if none is running** (use `npm run obs:bridge` instead when a
server is already up). The bridge holds `PI_OBS_TOKEN` and calls the server
locally, so the token never leaves the machine. See `example.env` and
[`obs/API.md`](obs/API.md#telegram-bridge).

**Run it in Docker.** The dashboard + API can run in a container (the bundled
dashboard only — not the React app). Your agents still run on the host and write
the event sink; the container tails it. `PI_OBS_TOKEN=$(openssl rand -hex 32)
docker compose up --build`, then open `http://localhost:7616/`. The image binds
`0.0.0.0` (a loopback bind is unreachable through a published port), so always set
`PI_OBS_TOKEN`. Build/run, the sink mount, and limitations (LLM/chat need the `pi`
CLI, which the image omits) are in [`DOCKER.md`](DOCKER.md).

**OpenTelemetry export.** The same sink converts to an OTLP/JSON trace following the
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
(`invoke_agent` / `chat` / `execute_tool` spans with `gen_ai.*` attributes), so a run can
feed any OTel-aware backend (Datadog, Phoenix, Langfuse, Honeycomb, …). Use the **Trace**
view's `⤓ OTLP` / `⤓ JSON` buttons, the server's `/otel?run=<id>` endpoint, or the CLI:

```bash
tsx obs/obs-export.ts                       # OTLP for every run in the sink → stdout
tsx obs/obs-export.ts --run <runId> --out trace.json
curl "http://127.0.0.1:7616/otel?run=<runId>" # OTLP from the running server
```

The collector is inert unless `PI_OBS=1` and never disrupts a run if the sink can't
be written. Tool args/results are captured **in full** so the expand panel shows
everything; set `PI_OBS_TOOL_MAX=<chars>` to cap them (e.g. to bound the sink size).
Agent **message and thinking text** is a separate opt-in (it can echo file
contents): `PI_OBS_CONTENT=1`, capped to `PI_OBS_CONTENT_MAX` (default 2000) — e.g.
`PI_OBS=1 PI_OBS_CONTENT=1 ./run.sh`.

**LLM features (opt-in, `PI_OBS_LLM=1`).** The server can call a model — via `pi`
itself — to **explain** or **summarize** a run, **judge** it on a rubric
(`/api/runs/:id/judge`, surfaced in Stats), and back the `/api/playground` prompt
sandbox. All are gated on `PI_OBS_LLM=1`, cached per run, and never run a model
unless asked. Because the background server may not inherit your shell's full
`PATH` (where `pi` lives under a version manager), `run.sh` resolves `pi`'s absolute
path and passes it through as `PI_OBS_PI_BIN` so the spawn never fails to find it.

## Develop

`pi` isn't a node dependency of this repo, so type-checking/tests link the
globally-installed pi (the exact version you run) into `node_modules`:

```bash
npm run setup:types     # link pi types (auto-runs before typecheck/test)
npm test                # unit tests (tsx) — utils/*/*.test.ts + obs/*.test.ts
npm run typecheck       # tsc --noEmit
npm run test:linear     # Python tests for the linear skill
npm run test:atlassian  # Python tests for the atlassian skill
```

`npm test` is the primary gate. For a quick per-file syntax/type-strip check use
`node --experimental-strip-types --check <file>`.

**The dashboard is a separate package.** `obs/ui` is browser code (DOM, JSX) with
its own `package.json` and tsconfig, so it has its own gates — and the root
tsconfig deliberately **excludes** it. Running the two together is a config
mismatch, not a finding:

```bash
cd obs/ui
npm ci && npm test      # 139 unit tests
npm run typecheck       # tsc -b --noEmit
npm run build           # → dist/, which obs-server serves (untracked)
```

`just verify` runs both suites, both typechecks and a dashboard build in one go.

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every PR, in
three jobs: the tsx unit suite + a `node --check` of every `extensions/`, `utils/`
and `obs/` `.ts` file; the dashboard's typecheck/tests/build; and the Python skill
tests. The syntax check prunes `obs/ui` — its ambient `.d.ts` declarations aren't
erasable-syntax-only, so they can't be type-stripped. The first job needs no `pi`
install: the pi imports are type-only (erased at runtime) and `node --check` does
no module resolution.

`node_modules` is dev-only and gitignored — it is **not** needed to run.

## Portability

Everything resolves relative to itself (extensions find `agents/`/`utils/` next to
them; `loadDotEnv` finds this folder's `.env` from its own path; scripts
self-resolve), so moving the folder needs no code changes — just `.env` +
`./run.sh`. Details in
[`extensions/README.md` → Portability](extensions/README.md#portability--moving-the-folder).
