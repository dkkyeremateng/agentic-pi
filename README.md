# pi-config

Configuration that turns [**pi**](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
into a multi-agent software-engineering workflow. A primary orchestrator drives a
team of specialized sub-agents — **scout → planner → refiner → implementer →
reviewer → validator → shipper** — through a self-healing **plan → refine →
implement → review → validate → ship** pipeline, each agent running its own
configurable model.

The folder is **relocatable**: copy it anywhere, on any machine, and run it with
only `.env` config — no code edits.

## Highlights

- **Team presets** — `plan-build` (full, validated), `soft-plan-build` (no
  validator), `spec` (plan only), and `build`, which **resumes** an existing plan
  from the first unfinished phase.
- **Verifiable, recoverable runs** — per-phase checkpoints with a progress ledger,
  transient-error retries, context-bounded prompts, and a live dashboard + a
  written run report.
- **Sub-agent dispatch** — `dispatch_agent` / `dispatch_parallel` for ad-hoc
  delegation to any agent, in any session.
- **Skills** — LSP diagnostics & navigation (Python/Go/TS/PHP), Playwright browser
  automation, Linear and Jira CLIs, GitHub, and commit helpers.
- **Per-agent models** — point each agent at a different model via `.env`; mix a
  cheap model for recon with a strong one for review/validation.
- **Config-only & portable** — everything resolves relative to itself; nothing to
  edit per machine.

## How it works

The active team's roster **is** the pipeline. A typical full run:

```
scout → planner → refiner → implementer → reviewer → validator → shipper
(recon)  (plan)   (harden)   (build)      (review)   (gate)      (PR)
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
- **Node.js** — only for type-checking/tests during development (not to run).
- Optional per-language tools you want the agents to use: language servers for
  `lsp` (pyright, gopls, typescript-language-server, intelephense), `gh` for
  GitHub, Playwright browsers for `bowser`.
- **Context-pruning packages (recommended)** — two third-party `pi` packages power
  the [context management](#context-management) below. Install once; they register
  in pi's global config and load automatically (including in sub-agents):

  ```bash
  pi install npm:pi-context        # provides the context_tag tool
  pi install npm:pi-context-prune  # prunes stale tool output on each tag
  ```

  Without them the agents' `context_tag` milestone calls are inert — the workflow
  still runs, relying only on pi's built-in compaction.

## Quick start

```bash
cp example.env .env          # then fill in your models / API keys
./run.sh                     # launches dispatch.ts + agent-workflow.ts
```

`run.sh` loads the extensions resolved relative to itself, so you never edit pi's
global settings per machine. Then, inside pi:

```
/agent-workflow add rate limiting to the public API
```

…or just ask the primary agent to do non-trivial work and it will dispatch the
pipeline itself. You'll be asked to pick a team, then the run streams on a live
dashboard and writes `workflow-report.md` at the end.

## Using the workflow

### Slash commands

| Command | What it does |
|---------|--------------|
| `/agent-workflow <request>` | Run the full lifecycle on a request (prompts for a team). |
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
| `plan-build` | scout → planner → refiner → implementer → reviewer → **validator** → shipper | Full, independently validated. |
| `soft-plan-build` | scout → planner → refiner → implementer → reviewer → shipper | Skips the validator's full re-run — faster/cheaper. |
| `spec` | scout → planner → refiner | Produce a reviewable plan only (no code). |
| `build` | implementer → reviewer → validator → shipper | **Resume** / build from an existing `.agent/plan.md`. |

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
- **Footer** — the active model, context usage + cost, run status, and an inline
  **`LSP:`** segment showing which language servers the project needs and whether
  they're installed (`✓` ready / `○` missing).
- **`workflow-report.md`** — the end-of-run report (requirement, files changed,
  suite/diagnostics results, verdict, branch/commits, PR link or next steps).
- **`.agent/`** scratch — `plan.md` (and `plan.draft.md`), `progress.md` (phase
  ledger), `checkpoints/` (for `/revert`), `screenshots/` (browser QA). Gitignored.
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
| `seeker` | Browser automation, web research, and UI/QA (via the `bowser` skill). |
| `linear` | Linear issue tracking. |
| `atlassian` | Jira tickets (read/update via the REST API). |

## Skills

On-demand capabilities in [`skills/`](skills/). Most are stdlib-only Python CLIs;
each is an optional one-time install that puts a command on your `PATH`.

| Skill | What it gives the agents | Install |
|-------|--------------------------|---------|
| `lsp` | Type/compile **diagnostics** + **navigation** (def/refs/hover/symbols) for Python/Go/TS/PHP. The implementer and validator run `lsp diagnostics` as a required check. | `bash skills/lsp/install.sh` (then install the language servers you use) |
| `bowser` | Playwright browser automation — headless browsing, scraping, screenshots, UI testing. | see `skills/bowser/SKILL.md` |
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
| `PI_AGENT_<NAME>_MODEL` | Per-agent model (e.g. `PI_AGENT_IMPLEMENTER_MODEL`). The context-window for the dashboard comes from pi's model registry. |
| `PI_DISPATCH_MAX_DEPTH` | How deep dispatch may nest (default 1; a cycle guard is always on). |
| `PI_MAX_DISPATCHES_PER_TURN` | Breadth cap on dispatches per turn. |
| `PI_AGENT_TRANSIENT_RETRIES` | Same-model retries on transient errors (interrupted stream, dropped connection, 429/502/503/504/529). |
| `PI_WORKFLOW_AGENT_TIMEOUT` | Per-agent watchdog (minutes; 0 = off). |
| `PI_CONFINE_CWD` | Confine sub-agents' file tools to the working directory. |
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

This config drives the second layer in **`on-context-tag`** mode: a prune flushes
when an agent calls **`context_tag`** (from the `pi-context` package). The agents tag
at natural milestones, so each flush reclaims a batch of now-stale output with a
single cache-friendly rewrite:

- the **implementer** tags after each completed phase (alongside the
  `.agent/progress.md` update), so a phase's reads/commands are pruned before the
  next phase — keeping a long implement run well under the window;
- the **orchestrator** tags at task boundaries — a `run_agent_workflow` run, a
  dispatch, or a delivered file completes — to keep a long multi-task session lean.

Because both `pi-context` and `pi-context-prune` are registered in pi's global config
(`packages` in `~/.pi/agent/settings.json`), they load in **every** pi process,
including the spawned sub-agents. Pruning settings (enable/disable, trigger mode,
summarizer model) live in pi's global config at
`~/.pi/agent/context-prune/settings.json` — **not** this folder's `.env`. Inside pi,
`/pruner` views or changes them and `/pruner stats` shows how much it has reclaimed.

## Develop

`pi` isn't a node dependency of this repo, so type-checking/tests link the
globally-installed pi (the exact version you run) into `node_modules`:

```bash
npm run setup:types     # link pi types (auto-runs before typecheck/test)
npm run typecheck       # tsc --noEmit
npm test                # unit tests (tsx) — utils/*.test.ts
npm run test:linear     # Python tests for the linear skill
npm run test:atlassian  # Python tests for the atlassian skill
```

`node_modules` is dev-only and gitignored — it is **not** needed to run.

## Portability

Everything resolves relative to itself (extensions find `agents/`/`utils/` next to
them; `loadDotEnv` finds this folder's `.env` from its own path; scripts
self-resolve), so moving the folder needs no code changes — just `.env` +
`./run.sh`. Details in
[`extensions/README.md` → Portability](extensions/README.md#portability--moving-the-folder).
