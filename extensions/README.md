# workflow.ts — plan / critic / implement / test / validate / document / ship orchestrator

A self-contained pi extension that runs the agents as a **self-healing loop**,
gated by the validator — optionally led by a read-only **scout** recon pass. The
validator runs twice: once to gate the correctness loop, and once at the end to
ship.

### Full workflow

```
scout ──▶ planner ◀──┐                tester ──▶ validate
(optional)     │      │ REVISE             ▲            │
               ▼      │                     │            │
            critic ───┘    implementer ─────┘      FAIL ◀┘ (loops back)
               │ APPROVED                              │ PASS
               ▼                                       ▼
                                        document ──▶ ship (open PR)
```

The **critic** evaluates the planner's output before the implementer sees it.
If the critic rejects the plan (`REVISE BEFORE IMPLEMENTING`), findings are
fed back to the planner for revision. This loop runs up to `loops=N` times
(default 3). Once the critic approves (or the limit is reached), the approved
plan proceeds to the implementer.

### Spec workflow

```
scout ──▶ planner ◀──┐
(optional)     │      │ REVISE
               ▼      │
            critic ───┘   (loops back with findings)
               │ APPROVED
               ▼
           document ──▶ spec saved
```

In spec mode, the **critic** evaluates the planner's output and sends findings
back to the planner for revision if it rejects the plan (`REVISE BEFORE
DOCUMENTING`). The planner addresses the issues and produces a revised plan,
which the critic re-evaluates. This loop runs up to `loops=N` times (default 3).
Once the critic approves (or the limit is reached), the documenter turns the
final plan into a standalone spec. If the critic never approves, the report
status is `NEEDS REVIEW` and the spec includes the last revision with a warning.

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
from `.pi/agents/` (scout, planner, critic, implementer, tester, documenter, validator).

Both `workflow.ts` and `workflow-team.ts` live here and auto-load together, but
only **one** renders the dashboard/footer at a time so they don't stack: launch
with `pi -e .pi/extensions/workflow.ts` to get the base UI, or
`pi -e .pi/extensions/workflow-team.ts` for the per-agent-model variant. With no
`-e` (plain auto-discovery) the base `workflow` owns the chrome by default. The
other extension's commands stay registered either way.

## Use it

```bash
pi
/workflow Fix the off-by-one in pagination on /api/users
/workflow Add CSV export to the reports page
/workflow Build a todo app with a REST API
```

Or let the primary agent call the **`run_workflow`** tool for any non-trivial task.

In `workflow-team.ts`, the primary agent acts as an **orchestrator that determines the workflow**: it receives
the user's request, reviews it, and decides which agents to dispatch and in what order.
It declares that plan with `select_agents` (so the dashboard shows the chosen agents up front), then
composes the workflow by chaining `dispatch_agent` calls (e.g., scout → planner → critic → implementer),
or uses `run_workflow_team` as a shortcut for the standard full pipeline — picking ONE approach per request.
Once the deliverable is produced it **stops and summarizes**; it does not auto-start a new workflow or
chain `run_workflow_team` onto finished dispatch work.
A system prompt is injected at session start that catalogs all available agents,
describes the standard pipeline stages, and guides the orchestrator to reason about
what the request needs — rather than following a fixed sequence for every task.

A live widget renders the phases as connected cards
(`Scout ──▶ Plan ──▶ Critique ──▶ Implement ──▶ Test ──▶ Validate ──▶ Document ──▶ Ship`,
with the leading `Scout` card present only when the team includes it). Both the full and
spec workflows include the Critique card. Each card shows a status icon
(`○` pending, `●` running, `✓` done, `✗` error), elapsed time, and a context-usage
bar — but **not** a snippet of the agent's log; that lives in the live activity
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
  critic, implementer, tester, validator, then documenter + ship once it passes)
  with the time each took and, for the tester, a passed/failed count. When scout
  ran, a **Reconnaissance** section precedes the Plan in the Details.
- **Details** — the full transcript from every agent below the summary.

When idle (no run in progress), the widget shows a **team dashboard** instead —
a grid of cards, one per agent in the active team, each with its status, the
**model it will run** (`◆ <model>`), and a short description. Teams come from
`.pi/agents/teams.yaml`; a team that has the implementer, tester, and validator
runs the **full pipeline**, while any other team (e.g. `info` = planner +
documenter) runs the **plan→document (spec)** workflow.

When the primary agent drives **ad-hoc work** (rather than the full
`run_workflow_team` pipeline), the dashboard grid **stays on screen** and narrows
to the agents selected for the work. At bootup every agent in the team is shown;
once the orchestrator has determined the agents the work needs, it calls
**`select_agents`** to declare them and the grid **drops the unselected cards**,
keeping only the chosen ones — a status-colored border and a `▸` marker, each
showing `◌ queued` before it runs. The header also updates to the chosen set — it
retitles to `selected from <team>` and its agent count and workflow mode reflect
the selection (e.g. `7 agents · full pipeline` → `3 agents · spec mode`). As the
orchestrator then dispatches each agent, the cards update in place (`◌ queued` →
`● running` → `✓ done`/`✗ error`) with elapsed time, and the badge counts
completions over the selected set (`◌ queued: 0/3` → `● working: 1/3` →
`✓ done: 3/3`). The running agent's live activity panel streams below the grid. So
the whole team is visible at bootup, and the view narrows to exactly the agents
doing the work as soon as the plan is decided. A full pipeline run still switches
to the connected-cards view.

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
`workflow-team · ad-hoc dispatch` instead, with the hint *"primary agent dispatched
work outside the workflow team."* This way the dashboard reflects the actual work
rather than an irrelevant team grid.

Running `/workflow` opens a **Select Team** dialog first — the team you pick
decides which agents run and the mode (full vs spec). Skip the dialog by forcing
a mode with a `spec ` or `full ` prefix (e.g. `/workflow spec add CSV export`).

If the chosen team includes the **`scout`** agent (the default `full` team does),
a read-only **Scout** recon phase runs first and its concise findings (structure,
patterns, key entry points) are fed into the planner to ground the plan. Scout
never modifies files; it appears as the first card in the flow and gets its own
"Reconnaissance" section in the report. Remove `scout` from the team in
`.pi/agents/teams.yaml` to skip the recon pass.

Commands:
- `/workflow [request]` — pick a team (Select Team dialog), then run the lifecycle in that team's mode (prompts for the request if omitted). Add a `loops=N` token (e.g. `/workflow loops=5 fix the bug`) to override the retry limit for this run.
- `/workflow-clear` — clear the progress widget

## Config

- **Model** — every agent in the pipeline runs on the **current session's model** (the model you launched pi with), so one model drives the whole workflow. Set `PI_WORKFLOW_MODEL` to override all agents with a specific model instead. (Per-agent `model:` frontmatter is ignored here — use the `workflow-team.ts` variant for per-agent models.)
- `PI_WORKFLOW_AGENT_TIMEOUT` — optional watchdog (in minutes). If set, any agent that runs longer is killed and the phase fails with a clear "timed out" note. `0`/unset disables it.
- `run_workflow { request, max_loops }` — `max_loops` overrides the retry limit per call

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

# Per-agent overrides (workflow-team.ts only)
PI_AGENT_SCOUT_MODEL=anthropic/claude-haiku-4-5
PI_AGENT_PLANNER_MODEL=anthropic/claude-opus-4-8
PI_AGENT_CRITIC_MODEL=anthropic/claude-opus-4-8
PI_AGENT_IMPLEMENTER_MODEL=anthropic/claude-sonnet-4-6
PI_AGENT_TESTER_MODEL=anthropic/claude-haiku-4-5
PI_AGENT_VALIDATOR_MODEL=anthropic/claude-opus-4-8
PI_AGENT_DOCUMENTER_MODEL=openrouter/google/gemini-3-flash
```

`export KEY=value` lines and `# comments` are both accepted. Add `.env` to your
`.gitignore` if it holds anything sensitive. (The `.pi/agents/models.yaml` file
described below is an alternative for the per-agent model config specifically.)

## Team variant — `workflow-team.ts`

`workflow-team.ts` runs the same pipeline but lets you **set the model per agent**
and **pick a team from `.pi/agents/teams.yaml`**. Per-agent models come from
either source (env wins over the file):

- **Env vars** — `PI_AGENT_SCOUT_MODEL`, `PI_AGENT_PLANNER_MODEL`,
  `PI_AGENT_CRITIC_MODEL`, `PI_AGENT_IMPLEMENTER_MODEL`, `PI_AGENT_TESTER_MODEL`,
  `PI_AGENT_VALIDATOR_MODEL`, `PI_AGENT_DOCUMENTER_MODEL`. These only work if
  they're **exported in the shell that launches pi** — if you start pi from an
  IDE/GUI or forget to `export`, they won't be visible.
- **`.pi/agents/models.yaml`** — a flat `agent: model` file, robust regardless of
  how pi is launched. An optional `default:` covers any unset agent:

  ```yaml
  scout: anthropic/claude-haiku-4-5
  planner: anthropic/claude-opus-4-8
  documenter: openrouter/google/gemini-3-flash
  default: anthropic/claude-haiku-4-5
  ```

`PI_WORKFLOW_MODEL` is the global env fallback for any agent left unset.
Everything else about the pipeline is identical.

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
 workflow-team  ·  team full (7 agents · full pipeline)
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Scout        │ │ Planner      │ │ Critic       │ │ Implementer  │
│ ○ idle       │ │ ○ idle       │ │ ○ idle       │ │ ○ idle       │
│ [-----] 0%   │ │ [-----] 0%   │ │ [-----] 0%   │ │ [-----] 0%   │
│ ◆ haiku-4-5  │ │ ◆ opus-4-8   │ │ ◆ opus-4-8   │ │ ◆ opus-4-8   │
│ Fast codeb…  │ │ Architectu…  │ │ Critical e…  │ │ Requiremen…  │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

Once the primary agent has **determined which agents the work needs**, it calls
`select_agents` and the grid **drops the unselected agents** and shows only the
chosen ones, marked (`▸` + status-colored border). The header retitles to
`selected from <team>` and its **agent count and workflow mode update to the chosen
set** — here 3 spec agents, so it flips from `7 agents · full pipeline` to
`3 agents · spec mode`. The plan is visible up front; selected agents show
`◌ queued` before any of them runs, and the badge counts completions (`0/3`):

```
 workflow-team  ·  selected from full (3 agents · spec mode)  ·  ◌ queued: 0/3
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ ▸ Scout            │ │ ▸ Planner          │ │ ▸ Critic           │
│ ◌ queued           │ │ ◌ queued           │ │ ◌ queued           │
│ [-----] 0%         │ │ [-----] 0%         │ │ [-----] 0%         │
│ ◆ haiku-4-5        │ │ ◆ opus-4-8         │ │ ◆ opus-4-8         │
│ Fast codebase rec… │ │ Architecture and … │ │ Critical evaluati… │
└────────────────────┘ └────────────────────┘ └────────────────────┘
```

As it then dispatches each agent (`dispatch_agent`), the cards update in place —
`◌ queued` → `● running` → `✓ done` — and the badge tracks completions
(`◌ queued: 0/3` → `● working: 1/3` → `✓ done: 3/3`):

```
 workflow-team  ·  selected from full (3 agents · spec mode)  ·  ● working: 1/3
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ ▸ Scout            │ │ ▸ Planner          │ │ ▸ Critic           │
│ ✓ done 4s          │ │ ● running 9s       │ │ ◌ queued           │
│ [#----] 12%        │ │ [##---] 34%        │ │ [-----] 0%         │
│ ◆ haiku-4-5        │ │ ◆ opus-4-8         │ │ ◆ opus-4-8         │
│ Fast codebase rec… │ │ Architecture and … │ │ Critical evaluati… │
└────────────────────┘ └────────────────────┘ └────────────────────┘
```

Teams are defined in `.pi/agents/teams.yaml` (a flat `team:` → `- member` list).
a team that has the implementer, tester, and validator runs the **full pipeline**
(plan → critique → implement → test → validate → document → ship);
any other team (e.g. `spec` = planner + critic + documenter) runs the
**plan→critique→document (spec)** workflow. Running `/workflow-team` opens a
**Select Team** dialog first
and the chosen team decides the mode; an explicit `spec ` or `full ` prefix skips
the dialog and forces the mode.

The footer shows the **workflow status**, the **primary (orchestrator) agent's
model** (`◆ <model>` — the model pi was loaded with), and that primary agent's own
**context-usage bar** (`[##########] %`). The *per-agent* models and context bars
live on the dashboard cards; the footer carries only the primary session's, so you
can see what model is driving the orchestrator and how full its context is. The
status tracks both modes: the full pipeline reads `running`/`shipped`/`failed`, and
ad-hoc dispatch reads `dispatching` while a dispatched agent is working, then
`dispatch done` — so it never reads `idle` while the team is busy. Set scout's
model with `PI_AGENT_SCOUT_MODEL` or a `scout:` line in `models.yaml` — a
fast/cheap model is a good fit for read-only recon.

Commands:
- `/workflow-team [request]` — pick a team (Select Team dialog), then run the lifecycle in that team's mode (prompts if omitted). Add a `loops=N` token to override the retry limit for this run.
- `/workflow-team-clear` — clear the progress widget

Tools (available to the primary agent as the orchestrator):
- `select_agents { agents }` — declare the agents the work will use, in order. Called first, once the workflow is determined, so the dashboard marks them **queued** before any agent runs.
- `run_workflow_team { request, max_loops }` — run the full automated lifecycle
- `dispatch_agent { agent, task }` — dispatch a task to any loaded agent outside the pipeline

The primary agent receives an **orchestrator system prompt** that catalogs all
available agents, describes the pipeline, and guides it to choose between the
full workflow and targeted dispatches based on the request.

## Code layout

Both extensions share their stateless guts via `.pi/utils/workflow-core.ts`
(types, constants, the agent/team/`.env` loaders, and the prompt templates) and
`.pi/utils/workflow-utils.ts` (verdict/digest helpers). These live in `.pi/utils/`
— **not** `.pi/extensions/` — so pi doesn't try to auto-load them as extensions.
Only the model-aware orchestration, rendering, and per-extension identity stay
in `workflow.ts` / `workflow-team.ts`.

## Using it on another project

These extensions only auto-load when pi runs from this directory. To use them elsewhere:
- copy `.pi/extensions/workflow*.ts`, **`.pi/utils/`** (workflow-core + workflow-utils), and `.pi/agents/` into that project's `.pi/`, or
- symlink `workflow.ts` into `~/.pi/agent/extensions/` to make it global — but keep the `../utils/` modules reachable at the same relative path (agents still load from the active project's `.pi/agents/`).
