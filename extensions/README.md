# agent-workflow.ts — plan / implement / review / test / validate / document / ship orchestrator

A self-contained pi extension that runs the agents as a **self-healing loop**,
gated by the reviewer and the validator — optionally led by a read-only **scout**
recon pass. The validator runs twice: once to gate the correctness loop, and once
at the end to ship.

### Full workflow

```
scout ──▶ planner ──▶ implementer ──▶ reviewer ──▶ tester ──▶ validate ──▶ document ──▶ ship
(optional)                ▲              │              ▲          │          (on PASS)
                          │   REVISE     │              │   FAIL   │
                          └──────────────┘              └──────────┘
                          (reviewer loops to            (validator loops to
                           the implementer)              the implementer)
```

The **reviewer** reviews the implementation against the plan after the implementer
runs. If it requests changes (`REVISE BEFORE MERGE`), its findings go back to the
implementer, which fixes exactly those issues, and the reviewer re-reviews. This
loop runs up to `loops=N` times (default 3). Once the reviewer approves (or the
limit is reached), the change proceeds to the tester and validator.

### Partial teams (roster = pipeline)

There is no separate "spec" mode. A team simply runs the subsequence of the
pipeline its roster contains. For example a `planner`-only team just runs:

```
scout ──▶ planner   (produces .agent/plan.md)
(optional)
```

The **implement↔review** loop only runs when the team has both an implementer and a
reviewer; likewise the **test↔validate** loop only runs when it has both a tester and
a validator. A team missing a loop's agents just runs its phases straight through.

Documentation runs **only after** the change passes validation — no docs are
written for an implementation that might be reworked. The ship step then commits
code + tests + docs together and opens the PR, so the docs are in it.

- **PASS** → document, then ship. Ship opens a draft PR (if a GitHub remote exists).
- **PAUSED** → ship found no GitHub remote. It made the local branch + commit and stopped; the report shows the exact commands to add a remote.
- **FAIL** → the validator's findings are fed back to the implementer and it retries (up to `max_loops`, default 3). Documentation/ship are skipped.
- **UNKNOWN** → no clear verdict; surfaced for human review.

Handles **bug fixes, new features, and new apps** — the planner classifies the request and the pipeline follows.

## How it loads

pi auto-discovers `cwd/.pi/extensions/*.ts`. Run `pi` from this directory and the
extension loads automatically — no registration. It reads the agent definitions
from `.pi/agents/` (scout, planner, implementer, reviewer, tester, validator, shipper).

`agent-workflow.ts` is the single workflow extension. It runs each agent on its own
model (the agent's `.md` `model:`, `PI_AGENT_<NAME>_MODEL`, or `.pi/agents/models.yaml`,
falling back to `PI_WORKFLOW_MODEL` / the session model) with a per-agent session.
Launch it with `pi -e .pi/extensions/agent-workflow.ts`, or rely on auto-discovery.

### `dispatch.ts` — required by the workflow

`dispatch.ts` is a **standalone extension that owns the `dispatch_agent` and
`select_agents` tools**, so any agent can dispatch a specialist in a plain pi
session — not only inside a workflow. The workflow extension **depends on it**:
it no longer registers those tools and instead subscribes to its `dispatch:update`
event (`pi.events`) to mirror dispatch activity into its dashboard. Keep
`dispatch.ts` loaded alongside it — under auto-discovery (`.pi/extensions/*.ts`)
it loads automatically; with explicit `-e`, add it too:

```bash
pi -e .pi/extensions/dispatch.ts -e .pi/extensions/agent-workflow.ts
```

Without `dispatch.ts`, `/agent-workflow` still runs its automated
lifecycle, but the orchestrator's free-form `dispatch_agent`/`select_agents` tools
will be unavailable. To use dispatch from a non-workflow agent, add `dispatch_agent`
to that agent's `tools:` frontmatter.

#### Recursion (nested dispatch)

A dispatched agent that has `dispatch_agent` in its frontmatter can itself dispatch,
forming a tree. Sub-agents are separate `pi` processes, so a recursion guard rides
down through the environment (`PI_DISPATCH_DEPTH`, `PI_DISPATCH_ANCESTRY`, set
automatically on each spawn):

- **Depth** — `PI_DISPATCH_MAX_DEPTH` (default **1** = single level: only the top
  agent dispatches; deeper dispatch is refused). Raise it to allow nesting.
- **Cycles** — always refused (an agent dispatching one already in its chain, e.g.
  A → B → A), independent of the depth setting.
- **Breadth** — `PI_MAX_DISPATCHES_PER_TURN` still caps dispatches per agent-turn.

The default keeps behaviour single-level; opt into deeper trees with
`PI_DISPATCH_MAX_DEPTH=2+`. The bundled agents are all single-level — only add an
agent with `dispatch_agent`/`dispatch_parallel` in its frontmatter to need this.

## Use it

```bash
pi
/agent-workflow Fix the off-by-one in pagination on /api/users
/agent-workflow Add CSV export to the reports page
/agent-workflow Build a todo app with a REST API
```

Or let the primary agent call the **`run_agent_workflow`** tool for any non-trivial task.

The primary agent keeps its **full toolset and skills** and **does the work itself by
default** — it is not forced to delegate. A system prompt injected at session start
catalogs the available specialist agents and the delegation tools (`select_agents`,
`dispatch_agent`, `dispatch_parallel`, `run_agent_workflow`), and
tells it to **delegate only when** (1) a team is active, (2) the user asks, or (3) a
specialist agent is genuinely a better fit (e.g. a multi-phase build, deep web
research, or ticket lookups). When it does delegate, it
declares the plan with `select_agents`, chains `dispatch_agent` (or runs the
pipeline), finishes every selected agent, then **stops and summarizes**.

A live widget renders the phases as connected cards
(`Scout ──▶ Plan ──▶ Implement ──▶ Review ──▶ Test ──▶ Validate ──▶ Ship`,
with the leading `Scout` card present only when the team includes it). Each card
shows a status icon
(`○` pending, `●` running, `✓` done, `✗` error), elapsed time, and a context-usage
bar. Once an agent has run on a **priced** model, its **estimated USD cost** is
appended to the usage line (e.g. `· $0.012`) — pi computes per-response cost from
the model's token rates, so this is accurate for models that carry pricing and
shows nothing for models priced at 0 (e.g. a custom proxy). The card shows **not**
a snippet of the agent's log; that lives in the live activity
panel below the cards, so the cards stay compact. A status badge by the title shows
the overall result (`● running`, `✓ shipped`, `‖ paused (no remote)`, `✗ failed`).

Below the cards, a **live activity panel** streams what the running agent is
doing in real time (`─── Implement · live ───`): its reasoning, each tool call
(`→ edit file=src/app.ts`), tool completions (`✓ edit`), and the answer text as
it is written. Reasoning models often think and call tools for a while before
emitting any answer text, so this panel is where you watch the work happen. The
panel is height-bounded (never more than half the terminal) so the input box and
footer always stay on screen.

To **scroll through the full logs**, the run ends by posting a single
collapsible card with every phase's complete activity log
(`▤ Activity logs (4 phases) — expand to read`). Because it is a normal
conversation message, it scrolls with the editor pinned at the bottom; expand it
to read each phase (`## Plan`, `## Implement`, …) in full.

When the workflow finishes, the **report is posted inline in the conversation**
as a card that flows with the chat (collapsed to a one-line summary; expand it
like any tool result to read the full markdown). It is also written to
`workflow-report.md` in the project root (CWD). The report leads with:

- **Outcome** — a plain-English result (SHIPPED / PAUSED / FAILED / NEEDS REVIEW),
  the verdict, pass count, and the PR URL when one was opened.
- **Summary of work** — one digest line per phase (scout when present, planner,
  implementer, reviewer, tester, validator, then ship once it passes)
  with the time each took, its token count and **USD cost**, and, for the tester,
  a passed/failed count. When scout ran, a **Reconnaissance** section precedes the
  Plan in the Details.
- **Totals** — wall-clock time, tool calls, total tokens, and **total run cost**
  (summed across every phase, each priced on its own model). The footer also shows
  this running total live during the run.
- **Details** — the full transcript from every agent below the summary.

When idle (no run in progress), the widget shows a **team dashboard** instead —
a grid of cards, one per agent in the active team, each with its status, the
**model it will run** (`◆ <model>`), and a short description. Teams come from
`.pi/agents/teams.yaml`. There is **no spec/full mode**: a team's roster *is* the
pipeline — the workflow runs exactly the agents the team lists, in the canonical
order `scout → planner → implementer → reviewer → tester → validator → shipper`. A
`planner` team produces a plan; an `implementer, reviewer, tester, validator, shipper`
team builds, reviews, tests, and ships; each loop (implement↔review, test↔validate)
runs only when both of its agents are on the team. (Docs are part of the
implementer's change — there is no documenter phase.)

When the primary agent drives **ad-hoc work** (rather than the full
`run_agent_workflow` pipeline), the dashboard grid **stays on screen** and narrows
to the agents selected for the work. At bootup every agent in the team is shown;
once the orchestrator has determined the agents the work needs, it calls
**`select_agents`** to declare them and the grid **drops the unselected cards**,
keeping only the chosen ones — a status-colored border and a `▸` marker, each
showing `◌ queued` before it runs. The header also updates to the chosen set — it
retitles to `selected from <team>` and its agent count reflects the selection
(e.g. `7/7 agents` → `3/7 agents`). As the
orchestrator then dispatches each agent, the cards update in place (`◌ queued` →
`● running` → `✓ done`/`✗ error`) with elapsed time, and the badge counts
completions over the selected set (`◌ queued: 0/3` → `● working: 1/3` →
`✓ done: 3/3`). The running agent's live activity panel streams below the grid. So
the whole team is visible at bootup, and the view narrows to exactly the agents
doing the work as soon as the plan is decided. A workflow run still switches to
the connected-cards view.

**Each new request resets the grid.** When the orchestrator starts a new workflow
(a new user request), the first `select_agents`/`dispatch_agent` rebuilds the cards
from scratch: cards for agents the previous workflow used but the new one doesn't
are **dropped**, agents the new workflow reuses are **reset to `◌ queued`** (no
stale `✓ done`, context, or fallback-model state carries over), and any newly
needed agents are **added**. Refining the selection *within* the same request still
preserves the progress of agents already run.

**Off-team dispatch.** The orchestrator can dispatch any loaded agent, not just the
active team's members (e.g. a research/browser agent that belongs to no team). When
a dispatched agent is **not** on the active team, the grid **hides the team
information and the idle team roster** and shows only the dispatched agent(s); the
header drops the `team <name> (N agents · mode)` descriptor and reads
`agent-workflow · ad-hoc dispatch` instead, with the hint *"primary agent dispatched
work outside the workflow team."* This way the dashboard reflects the actual work
rather than an irrelevant team grid.

Running `/agent-workflow` opens a **Select Team** dialog first — the team you pick
decides exactly which agents run. Skip the dialog by naming a team as the first
token (e.g. `/agent-workflow building add CSV export` runs the `building` team).

If the chosen team includes the **`scout`** agent (the default `full` team does),
a read-only **Scout** recon phase runs first and its concise findings (structure,
patterns, key entry points) are fed into the planner to ground the plan. Scout
never modifies files; it appears as the first card in the flow and gets its own
"Reconnaissance" section in the report. Remove `scout` from the team in
`.pi/agents/teams.yaml` to skip the recon pass.

Commands:
- `/agent-workflow [request]` — pick a team (Select Team dialog), then run the lifecycle (prompts for the request if omitted). Add a `loops=N` token (e.g. `/agent-workflow loops=5 fix the bug`) to override the retry limit for this run.
- `/agent-model [<agent> <model>]` — change a sub-agent's model **on the fly** for this session only (held in memory, resets on restart). No args lists every agent's effective model (overrides flagged `*`); `/agent-model <agent> <model>` sets one; `/agent-model <agent> reset` clears one; `/agent-model reset` clears all. The `<model>` position tab-completes the available models (from the model registry). A runtime override wins over `PI_AGENT_<NAME>_MODEL`, the `.md` `model:`, and `models.yaml`.
- `/agent-workflow-clear` — clear the progress widget

## Config

- **Model** — each agent runs on its **own model**: the agent's `.md` `model:` frontmatter, `PI_AGENT_<NAME>_MODEL`, or a `<name>: <model>` line in `.pi/agents/models.yaml` (env wins). Agents without one fall back to `PI_WORKFLOW_MODEL`, then the current session's model.
- `PI_WORKFLOW_AGENT_TIMEOUT` — optional watchdog (in minutes). If set, any agent that runs longer is killed and the phase fails with a clear "timed out" note. `0`/unset disables it.
- `run_agent_workflow { request, max_loops }` — `max_loops` overrides the retry limit per call

### Shared context across phases

The phase agents share a **curated context bundle** so each
can build on the others' work instead of relying on lossy hand-offs. The scout's
reconnaissance and the reviewer's verdict — the artifacts the per-phase prompts would
otherwise drop — are prepended to every downstream agent's task as a `## Shared run
context` block. Combined with what the prompts already thread through (the plan,
the implementer's change summary, the tester's report), every agent
(reviewer → tester → validator → ship) sees the full cross-agent
context, with no duplication. The bundle stays small, so it adds context without
bloating the window.

Each agent runs in its own per-agent session; the curated bundle above is how
cross-agent context is shared (a single shared session window is ill-defined when
each agent runs on its own model).

Each report now ends its header with a **Totals** line — wall-clock time and the total number of tool calls across the run. On failure, the agent's captured `stderr` tail is included so failures are diagnosable; if the agent run is aborted (turn cancelled), the running subprocess is killed instead of leaking.

### `.env` file (recommended)

Rather than `export`ing variables in every shell, put them in a **`.env` file in
the project root (the `cwd` you run pi from)**. Both extensions read it on load
and inject any keys that aren't already set in the real environment (so a real
shell variable still wins). This is the most reliable way to configure models —
it works even when pi is launched from an IDE/GUI that doesn't inherit your shell.

Create `.env` next to `.pi/`:

```bash
# .env — workflow model config
PI_WORKFLOW_MODEL=anthropic/claude-opus-4-8        # global fallback for all agents

# Per-agent model overrides
PI_AGENT_SCOUT_MODEL=anthropic/claude-haiku-4-5
PI_AGENT_PLANNER_MODEL=anthropic/claude-opus-4-8
PI_AGENT_IMPLEMENTER_MODEL=anthropic/claude-sonnet-4-6
PI_AGENT_REVIEWER_MODEL=anthropic/claude-opus-4-8
PI_AGENT_TESTER_MODEL=anthropic/claude-haiku-4-5
PI_AGENT_VALIDATOR_MODEL=anthropic/claude-opus-4-8
```

`export KEY=value` lines and `# comments` are both accepted. Add `.env` to your
`.gitignore` if it holds anything sensitive. (The `.pi/agents/models.yaml` file
described below is an alternative for the per-agent model config specifically.)

## Per-agent models and teams

The workflow runs each agent on its **own model** and lets you **pick a team from
`.pi/agents/teams.yaml`**.

### Using it

```bash
# launch (include dispatch.ts so dispatch_agent/select_agents are available)
pi -e .pi/extensions/dispatch.ts -e .pi/extensions/agent-workflow.ts
# ...or just `pi` from this directory — auto-discovery loads both together.

/agent-workflow Add CSV export to the reports page
```

- **`/agent-workflow [request]`** — opens a **Select Team** dialog (the team decides
  exactly which agents run), then runs it. Prompts for the request if omitted.
  Skip the dialog by naming a team as the first token (`/agent-workflow building add
  CSV export`); cap retries with a `loops=N` token (`/agent-workflow loops=5 fix the
  bug`).
- **`/agent-model [<agent> <model>]`** — swap a sub-agent's model for the current
  session (in memory, resets on restart). No args lists effective models; `reset`
  clears one or (bare) all.
- **`/agent-workflow-clear`** — clear the progress widget.
- **Or just talk to the primary agent.** It keeps its full tools/skills and **does
  the work itself by default**, delegating only when a team is active, you ask, or a
  specialist is clearly better. When it delegates it uses `select_agents` to declare
  the plan (the dashboard marks them queued), `dispatch_agent`/`dispatch_parallel` to
  run specialists, or `run_agent_workflow` as a shortcut for the full pipeline — then
  stops and summarizes.
- **Tools** (available to the primary agent): `select_agents { agents }`,
  `dispatch_agent { agent, task }` (both from `dispatch.ts`), and
  `run_agent_workflow { request, max_loops }`.

### Per-agent models

Per-agent models come from either source (env wins over the file):

- **Env vars** — `PI_AGENT_SCOUT_MODEL`, `PI_AGENT_PLANNER_MODEL`,
  `PI_AGENT_IMPLEMENTER_MODEL`, `PI_AGENT_REVIEWER_MODEL`, `PI_AGENT_TESTER_MODEL`,
  `PI_AGENT_VALIDATOR_MODEL`. These only work if
  they're **exported in the shell that launches pi** — if you start pi from an
  IDE/GUI or forget to `export`, they won't be visible.
- **`.pi/agents/models.yaml`** — a flat `agent: model` file, robust regardless of
  how pi is launched. An optional `default:` covers any unset agent:

  ```yaml
  scout: anthropic/claude-haiku-4-5
  planner: anthropic/claude-opus-4-8
  reviewer: anthropic/claude-opus-4-8
  default: anthropic/claude-haiku-4-5
  ```

`PI_WORKFLOW_MODEL` is the global env fallback for any agent left unset.

**Model fallback.** If an agent's configured model fails to load or run (bad model
id, missing API key, provider error), the run does not just fail: it **falls back
to the primary agent's model** — the one pi itself is using, known to work — and
retries that agent once. You are **notified** of what happened and the action
taken (`<Agent>: model "<x>" failed to load or run — falling back to the primary
agent's model (<y>) and retrying`), the agent's card **updates its model line to
the fallback** (the `◆` bullet becomes `⚠` and the text is highlighted), and a
follow-up notification reports whether the agent recovered on the fallback or the
fallback also failed. If the agent was already on the primary model (no
distinct fallback), you are told that no fallback is available. Only model
load/run errors trigger this — timeouts, tool failures, and bad output do not.

When idle, the widget shows a **team dashboard** — a grid of cards, one per agent
in the active team, each with its status, a **context-usage bar** (`[-----] 0%`
until the agent runs), the **model it will run** (`◆ <model>`), and its
description:

```
 agent-workflow  ·  team full (7/7 agents)
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Scout        │ │ Planner      │ │ Implementer  │ │ Reviewer     │
│ ○ idle       │ │ ○ idle       │ │ ○ idle       │ │ ○ idle       │
│ [-----] 0%   │ │ [-----] 0%   │ │ [-----] 0%   │ │ [-----] 0%   │
│ ◆ haiku-4-5  │ │ ◆ opus-4-8   │ │ ◆ opus-4-8   │ │ ◆ opus-4-8   │
│ Fast codeb…  │ │ Architectu…  │ │ Requiremen…  │ │ Reviews im…  │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

Once the primary agent has **determined which agents the work needs**, it calls
`select_agents` and the grid **drops the unselected agents** and shows only the
chosen ones, marked (`▸` + status-colored border). The header retitles to
`selected from <team>` and its **agent count updates to the chosen set** — here 3
of 7, so it flips from `7/7 agents` to `3/7 agents`. The plan is visible up front;
selected agents show `◌ queued` before any of them runs, and the badge counts
completions (`0/3`):

```
 agent-workflow  ·  selected from full (3/7 agents)  ·  ◌ queued: 0/3
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ ▸ Scout            │ │ ▸ Planner          │ │ ▸ Implementer      │
│ ◌ queued           │ │ ◌ queued           │ │ ◌ queued           │
│ [-----] 0%         │ │ [-----] 0%         │ │ [-----] 0%         │
│ ◆ haiku-4-5        │ │ ◆ opus-4-8         │ │ ◆ opus-4-8         │
│ Fast codebase rec… │ │ Architecture and … │ │ Requirement and b… │
└────────────────────┘ └────────────────────┘ └────────────────────┘
```

As it then dispatches each agent (`dispatch_agent`), the cards update in place —
`◌ queued` → `● running` → `✓ done` — and the badge tracks completions
(`◌ queued: 0/3` → `● working: 1/3` → `✓ done: 3/3`):

```
 agent-workflow  ·  selected from full (3/7 agents)  ·  ● working: 1/3
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ ▸ Scout            │ │ ▸ Planner          │ │ ▸ Implementer      │
│ ✓ done 4s          │ │ ● running 9s       │ │ ◌ queued           │
│ [#----] 12%        │ │ [##---] 34%        │ │ [-----] 0%         │
│ ◆ haiku-4-5        │ │ ◆ opus-4-8         │ │ ◆ opus-4-8         │
│ Fast codebase rec… │ │ Architecture and … │ │ Requirement and b… │
└────────────────────┘ └────────────────────┘ └────────────────────┘
```

Teams are defined in `.pi/agents/teams.yaml` (a flat `team:` → `- member` list).
A team's roster **is** the pipeline: the workflow runs exactly its members in the
canonical order `scout → planner → implementer → reviewer → tester → validator →
ship`. There is no spec/full mode — `full` (all seven) runs the whole pipeline,
`building` (implementer + tester + validator + shipper) builds and ships,
`plan-build` (planner + implementer + reviewer + validator) plans and builds, and so
on. Running `/agent-workflow` opens a **Select Team** dialog
first; name a team as the first token to skip it (`/agent-workflow building …`).

The footer shows the **workflow status**, the **primary (orchestrator) agent's
model** (`◆ <model>` — the model pi was loaded with), and that primary agent's own
**context-usage bar** (`[##########] %`). The *per-agent* models and context bars
live on the dashboard cards; the footer carries only the primary session's, so you
can see what model is driving the orchestrator and how full its context is. The
status tracks both paths: a workflow run reads `running`/`shipped`/`failed`, and
ad-hoc dispatch reads `dispatching` while a dispatched agent is working, then
`dispatch done` — so it never reads `idle` while the team is busy. Set scout's
model with `PI_AGENT_SCOUT_MODEL` or a `scout:` line in `models.yaml` — a
fast/cheap model is a good fit for read-only recon.

(Commands and orchestrator tools are listed under [Using it](#using-it) above.)

## Development

Type-checking and unit tests run against the **real pi types**. pi isn't a node
dependency of this repo, so a one-time step links the globally-installed pi (the
exact version you run) into `node_modules` — no install of pi's native runtime,
and `node_modules` is gitignored:

```bash
npm run setup:types     # link pi types into node_modules (needs `pi` on PATH)
npm run typecheck       # tsc --noEmit  (0 errors expected)
npm test                # unit tests (tsx) for utils/*.test.ts
npm run test:linear     # Python tests for the linear skill
```

`setup:types` runs automatically before `typecheck`/`test` (pre-hooks), so those
work after a fresh clone or `npm install` — just re-run it if the links go stale.
Extensions can't be `tsc`'d against installed types without this link step, so run
`npm run typecheck` after editing any `extensions/*.ts` or `utils/*.ts`.

## Code layout

Both extensions share their stateless guts via `.pi/utils/workflow-core.ts`
(types, constants, the agent/team/`.env` loaders, and the prompt templates) and
`.pi/utils/workflow-utils.ts` (verdict/digest helpers). These live in `.pi/utils/`
— **not** `.pi/extensions/` — so pi doesn't try to auto-load them as extensions.
Only the model-aware orchestration, rendering, and per-extension identity stay
in `agent-workflow.ts`.

## Portability — moving the folder

The whole folder is **relocatable**: copy it anywhere, on any machine, and it runs
with no code edits — only `.env` config. Everything resolves relative to itself
(extensions find `agents/`/`utils/` next to them; `loadDotEnv` finds this folder's
`.env` from its own source path; `linear`/setup scripts self-resolve). The only
external requirement is `pi` on PATH; `node_modules` is dev-only (typecheck/tests),
not needed to run.

New machine / new location — config only, no code changes:

1. Copy the folder anywhere.
2. Ensure `pi` is installed and on PATH.
3. `cp example.env .env` and fill in your models/keys. The folder-root `.env` is
   loaded as the global config (no whitelist), so **every** setting works there —
   `PI_WORKFLOW_MODEL`, `PI_AGENT_*_MODEL`, `PI_DISPATCH_MAX_DEPTH`, `LINEAR_API_KEY`, …
4. Launch with the bundled script, which loads the extensions resolved relative to
   itself (no per-machine pi config needed):

   ```bash
   ./run.sh          # loads dispatch.ts + agent-workflow.ts
   ```

5. *Optional:* `bash skills/linear/install.sh` for the `linear` CLI;
   `npm install && npm run setup:types` only if you want to typecheck/run tests.

**Why a launcher?** Extension loading can't be driven by `.env` — pi must know which
extensions to load *before* it reads `.env`. `run.sh` resolves and `-e`-loads
`dispatch.ts` + both workflows from its own path, so you never edit
`~/.pi/agent/settings.json` per machine.

### Using it inside another project's `.pi/`

To make the workflows available from a *different* project's directory (so plain
`pi` there picks them up), copy `extensions/` (incl. `dispatch.ts`), `utils/`
(workflow-core + workflow-utils), and `agents/` into that project's `.pi/` — keep
the `extensions/ ↔ ../utils/ ↔ ../agents/` relative layout intact. Or symlink the
extensions into `~/.pi/agent/extensions/` to make them global, keeping the
`../utils/` and `../agents/` modules reachable at the same relative path.
