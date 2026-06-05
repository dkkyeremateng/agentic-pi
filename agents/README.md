# Workflow agents — pi orchestrator definitions

Agent definitions for the self-healing **plan → critic → implement → test →
validate → document → ship** workflow, plus an optional read-only recon pass.
These `.md` files are consumed by the `agent-pipeline.ts` / `agent-team.ts`
extensions in `../extensions/` (see `../extensions/README.md`). pi discovers
agents from `cwd/.pi/agents/` first, so running `pi` from this directory — or
copying this `.pi/agents/` folder into another project — makes the agents
available there.

## Files

| File | Purpose |
|------|---------|
| `scout.md` | Read-only recon — maps structure, patterns, key entry points; runs first when the team includes it |
| `planner.md` | Identifies the bug/requirement, writes a phased plan + acceptance criteria |
| `critic.md` | Critically evaluates the plan — flags flaws, gaps, risks, and unverified assumptions before any code is written |
| `implementer.md` | Applies the plan exactly, reports a precise change summary |
| `tester.md` | Writes and runs tests, reports pass/fail |
| `documenter.md` | Updates READMEs/docs, adds comments where needed, writes usage examples in the existing style |
| `validator.md` | Runs the full suite, confirms criteria; in ship mode opens a draft PR on PASS |
| `teams.yaml` | Selectable teams for the workflow extensions. A team's roster IS the pipeline — the workflow runs exactly its members in canonical order (`scout → planner → critic → implementer → tester → validator → documenter → shipper`). No spec/full mode; e.g. `full` (all), `spec` (planner + critic), `plan-build`, `building`, `research`. |

Also present are **delegating / specialist** agents that are not linear pipeline
phases — `researcher.md` (investigate-and-write: gathers via specialists, gets the
critic's review, writes `.pi/findings/<slug>.md`), plus `coordinator`, `seeker`,
`linear`, `atlassian`. The orchestrator can dispatch any of these directly, and a
team that lists one runs it as a **lead agent** (see [Adding a new agent](#adding-a-new-agent)).

## Run it

The workflow is driven by the extensions, not by a YAML pipeline definition:

```bash
cd <the codebase you want to fix>   # or stay here to try it out
cp -r /path/to/.pi .pi              # only if copying into another project (include .pi/extensions and .pi/utils)
pi
/agent-pipeline                     # pick a team (Select Team dialog), then type the request
```

Type the bug or requirement. The planner produces a phased plan, which the
**critic** evaluates before the implementer sees it — if the critic rejects the
plan, findings are fed back to the planner for revision (looping up to the
configured max). Once approved, the implementer applies the plan, the tester
writes and runs tests, and the validator gates a correctness loop
(implement ⇄ test ⇄ validate, retrying on FAIL up to the configured max). Only
after it passes does the documenter update the docs, after which the validator
ships — committing code + tests + docs and opening a draft PR on a `fix/...`
branch (or pausing if there is no remote). If the chosen team includes `scout`,
a read-only recon pass runs first and feeds the planner.

- `/agent-pipeline [request]` — single-model lifecycle (every agent uses the session model)
- `/agent-team [request]` — per-agent models (env / `models.yaml`); see `../extensions/README.md`
- Name a team as the first token to skip the picker (e.g. `/agent-team building …`), or add `loops=N` to override the retry limit.

For plan-only work (no code change), pick a partial team — `spec` (planner +
critic) produces a reviewed plan, and a team that also includes the `documenter`
can render it into a spec under `.pi/specs/`. A team's roster determines exactly which
agents run, and a team led by a delegating agent (e.g. `research`) dispatches that
agent with your request instead of running the linear pipeline.

## Adding a new agent

Agents are auto-discovered from files — adding one needs **no TypeScript changes**.

1. Drop a `<name>.md` in this folder (`agents/`, the shared fallback) or in a
   project's `.pi/agents/` (which overrides it for that project), with frontmatter:

   ```markdown
   ---
   name: <name>                     # the dispatch id
   description: <what it does / when to use it>   # the orchestrator matches on this
   model:                           # blank = primary/session model
   context_window:                  # e.g. 1000000 (drives the context-usage bar)
   tools: read,write,grep,find,ls   # add dispatch_agent,dispatch_parallel if it delegates
   aliases: foo,bar                 # optional
   ---
   <system prompt / instructions>
   ```

   It is loaded on the next run, listed in the orchestrator's **Available Agents**,
   and dispatchable by name (`dispatch_agent agent="<name>"`) immediately.

2. To run it from `/agent-team` / `/agent-pipeline`, add it to a team in
   `teams.yaml`:

   ```yaml
   my-team:
       - <name>
   ```

   - A **delegating / utility** agent (anything not named one of the eight canonical
     roles) runs as a **lead agent** — dispatched directly with your prompt, doing
     its own sub-dispatches (e.g. the researcher calls `atlassian`/`linear`). If the
     team also lists the `critic`, it then runs as a visible reviewer of the lead's
     output, looping back on REVISE — so `research: [researcher, critic]` runs the
     researcher, then the critic reviews its findings.
   - Naming it one of `scout, planner, critic, implementer, tester, validator,
     documenter, shipper` slots it into the linear pipeline at that position.

3. Per-agent model (`agent-team` only): set `PI_AGENT_<NAME>_MODEL=...` or add a
   `<name>: <model>` line to `.pi/agents/models.yaml`. (`agent-pipeline` runs every
   agent on the primary/session model.)

**The only change that needs TypeScript** is introducing a brand-new *linear
pipeline phase* — a new step woven into `scout → … → ship` with its own
retry/gating logic — which lives in `PIPELINE_ORDER`, the per-phase task builders,
and `runWorkflowCore` (`../utils/`). Standalone and delegating agents are files-only.

## Note

These files override the global package versions only while pi runs from this
directory. The orchestration lives entirely in the extensions (`../extensions/`),
driven by these agent `.md` files and `teams.yaml`.
