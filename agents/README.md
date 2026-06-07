# Workflow agents — pi orchestrator definitions

Agent definitions for the self-healing **plan → refine → implement → review → validate → ship** workflow, plus an optional read-only recon pass.
These `.md` files are consumed by the `agent-workflow.ts`
extension in `../extensions/` (see `../extensions/README.md`). pi discovers
agents from `cwd/.pi/agents/` first, so running `pi` from this directory — or
copying this `.pi/agents/` folder into another project — makes the agents
available there.

## Files

| File | Purpose |
|------|---------|
| `scout.md` | Read-only recon — maps structure, patterns, key entry points; runs first when the team includes it |
| `planner.md` | Identifies the bug/requirement, writes a phased plan + acceptance criteria |
| `refiner.md` | Reviews and hardens the planner's plan before implementation — completeness, edge cases, security, testability, sequencing; rewrites `.agent/plan.md` |
| `implementer.md` | Applies the plan exactly **and writes the tests that prove it (TDD)**; reports a precise change summary |
| `reviewer.md` | Reviews the implementation against the plan — finds bugs, regressions, missed criteria; sends the implementer back to fix them |
| `validator.md` | Independent gate — runs the full suite, judges the implementer's tests, confirms acceptance criteria, loops back to the implementer on FAIL |
| `teams.yaml` | Selectable teams for the workflow extensions. A team's roster IS the pipeline — the workflow runs exactly its members in canonical order (`scout → planner → refiner → implementer → reviewer → validator → shipper`). No spec/full mode; e.g. `full` (all), `spec` (planner), `plan-build`, `building`. Each agent updates the docs/comments its own work touches — there is no separate documenter. |

Also present are **specialist** agents that are not linear pipeline phases —
`seeker` (browser/web), `linear` (issue tracking), and `atlassian` (Jira tickets).
These are **not** run as teams; the orchestrator dispatches them directly. There is
no dedicated research agent: for an investigate-and-write-up the orchestrator
assembles it itself — pick the relevant specialists/skills for the request, gather
(in parallel when independent), then write the findings doc to
`.agent/findings/<slug>.md`. (The `reviewer` reviews code against a plan, not
research write-ups, so it is not used here.)

## Run it

The workflow is driven by the extensions, not by a YAML pipeline definition:

```bash
cd <the codebase you want to fix>   # or stay here to try it out
cp -r /path/to/.pi .pi              # only if copying into another project (include .pi/extensions and .pi/utils)
pi
/agent-workflow                     # pick a team (Select Team dialog), then type the request
```

Type the bug or requirement. The planner produces a phased plan, which the
implementer applies. The **reviewer** then reviews that implementation against the
plan — if it requests changes (`REVISE BEFORE MERGE`), the implementer fixes them and
the reviewer re-reviews (looping up to the configured max). The implementer writes
the tests as part of implementing; the **validator** then gates a correctness loop
(validate ⇄ implement, retrying on FAIL up to the configured max) — it runs the full
suite and confirms the acceptance criteria independently. Only after it passes does the
shipper ship — committing code + tests + docs and opening a draft PR on a `fix/...`
branch (or pausing if there is no remote). The implementer updates any docs its change
touches as part of implementing. If the chosen team includes `scout`, a read-only
recon pass runs first and feeds the planner.

- `/agent-workflow [request]` — run the lifecycle; each agent runs on its own model (its `.md` `model:`, `PI_AGENT_<NAME>_MODEL`, or `models.yaml`, falling back to the session model). See `../extensions/README.md`.
- `/agent-model [<agent> <model>]` — change an agent's model on the fly for this session (in memory, resets on restart); no args lists effective models, `reset` clears one or (bare) all. A runtime override outranks the env var, `.md` `model:`, and `models.yaml`.
- Name a team as the first token to skip the picker (e.g. `/agent-workflow building …`), or add `loops=N` to override the retry limit.

For plan-only work (no code change), pick the `spec` team (planner) — it produces a
plan under `.agent/plan.md`. A team's roster determines exactly which pipeline phases
run; non-pipeline specialists added to a team are ignored — dispatch those ad-hoc
through the orchestrator instead. Documentation is the implementer's job (it updates
the docs its change touches), so there is no documenter phase.

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

2. To run it from `/agent-workflow`, add it to a team in
   `teams.yaml`:

   ```yaml
   my-team:
       - <name>
   ```

   - Naming it one of `scout, planner, refiner, implementer, reviewer, validator,
     shipper` slots it into the linear pipeline at that position, and a team listing
     it runs it there.
   - Any **other** (non-pipeline) agent is a specialist the orchestrator dispatches
     ad-hoc (e.g. `seeker`); it is not run via a team — adding it to a team roster
     has no effect, since only pipeline roles execute.

3. Per-agent model: set `PI_AGENT_<NAME>_MODEL=...`, add a `<name>: <model>` line to
   `.pi/agents/models.yaml`, or set the agent's `.md` `model:` frontmatter. Agents
   without one fall back to `PI_WORKFLOW_MODEL` / the session model.

**The only change that needs TypeScript** is introducing a brand-new *linear
pipeline phase* — a new step woven into `scout → … → ship` with its own
retry/gating logic — which lives in `PIPELINE_ORDER`, the per-phase task builders,
and `runWorkflowCore` (`../utils/`). Standalone specialist agents are files-only.

## Note

These files override the global package versions only while pi runs from this
directory. The orchestration lives entirely in the extensions (`../extensions/`),
driven by these agent `.md` files and `teams.yaml`.
