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
- **Background sessions** — run a persistent interactive pi session in `tmux`
  (`./run.sh --bg`), then attach/detach the terminal or steer it live from the
  dashboard without reattaching.
- **Observability** — an offline metrics analyzer (per-run reports + cross-project
  trends) and an opt-in live dashboard (`PI_OBS=1`) with seven views (Swimlane,
  Single, Race, Trace, Stats, Compare, Search), full run history, automated
  **evals** (+ optional LLM-as-judge), a versioned prompt-config registry, and an
  OpenTelemetry export — spanning every pi instance you're running.
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
- **`tmux`** (optional) — only for [background sessions](#background-sessions)
  (`./run.sh --bg`); `install.sh` installs it best-effort.
- Optional per-language tools you want the agents to use: language servers for
  `lsp` (pyright, gopls, typescript-language-server, intelephense), `gh` for
  GitHub, Playwright browsers for `bowser`.
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

## Quick start

```bash
./install.sh                 # one-time setup (macOS/Linux): pi CLI + deps + types + context pruner + .env
# edit .env to set your models / API keys, then:
./run.sh                     # loads dispatch + interactive + agent-workflow + footer + revert
```

[`install.sh`](install.sh) sets up everything to run/develop the workflow and the
observability server (it excludes the React dashboard in `pi-obs/` — set that up
separately with `cd pi-obs && npm install`). Already have `pi` and the deps? Just
`cp example.env .env` and `./run.sh`.

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
| `PI_AGENT_<NAME>_MODEL` | Per-agent model (e.g. `PI_AGENT_IMPLEMENTER_MODEL`). Accepts pi's `[provider/]id[:thinking]` form — e.g. `gfr_prt/gateframe_yoda/qwen-max-3-7-yoda-2:low` pins a provider and thinking level; a bare `id` or `id:thinking` uses the default provider. (Set thinking lower for recon/review agents to avoid output-token truncation.) The dashboard context-window comes from pi's model registry. |
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
tails that file and streams it to a browser dashboard over SSE with seven views:

- **Swimlane** — a live lane per agent.
- **Single** — one agent's full (virtualized) timeline, banded by turn-cycle, with
  filters, search, a stat bar + context widget, and click-to-expand tool args/results.
- **Race** — a turn-normalized grid of who reached which step, grouped by agent
  (parallel instances collapse under one header) and, across projects, by project.
- **Trace** — a hierarchical waterfall of one run: the orchestrator at the root with
  each dispatched agent nested on a shared time axis, annotated with dispatch
  retries/truncation.
- **Stats** — aggregate analytics (latency percentiles, cost/tokens by agent, a
  tool-duration leaderboard, cost over time) with vs-previous-run deltas, plus
  **automated evaluators** that grade the selected run against cost / duration /
  tool-call budgets — and, with `PI_OBS_LLM=1`, an **LLM-as-judge** rubric score
  (0–100 on a small rubric, cached per run).
- **Compare** — a side-by-side diff of any two runs (A baseline vs B candidate):
  headline metrics, per-agent and tool usage, and setup changes from the boot snapshots.
- **Search** — server-side substring search over **every run ever recorded**, with
  `run:` / `agent:` / `type:` / `project:` filters.

A **⌘K command palette** jumps to any view, project, or run.

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
`PI_OBS_LLM=1`), and `/runs`, `/last`, `/digest <id>`, `/search <text>`, `/live`,
`/pass`/`/fail` inspect and score runs. Replies **edit-stream** — one message
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
npm test                # unit tests (tsx) — utils/*/*.test.ts — the source of truth
npm run typecheck       # tsc --noEmit — best-effort; see note below
npm run test:linear     # Python tests for the linear skill
npm run test:atlassian  # Python tests for the atlassian skill
```

`npm test` is the primary gate. `npm run typecheck` is best-effort: the extensions
use loose (`any`) handler signatures that don't fully line up with pi's strict type
defs, so `tsc` reports known mismatches. For a quick per-file syntax/type-strip
check use `node --experimental-strip-types --check <file>`.

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every PR: the
tsx unit suite + a `node --check` of every `extensions/` and `utils/` `.ts` file,
and the Python skill tests. It needs no `pi` install — the pi imports are type-only
(erased at runtime) and `node --check` does no module resolution.

`node_modules` is dev-only and gitignored — it is **not** needed to run.

## Portability

Everything resolves relative to itself (extensions find `agents/`/`utils/` next to
them; `loadDotEnv` finds this folder's `.env` from its own path; scripts
self-resolve), so moving the folder needs no code changes — just `.env` +
`./run.sh`. Details in
[`extensions/README.md` → Portability](extensions/README.md#portability--moving-the-folder).
