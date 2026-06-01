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
| `teams.yaml` | Selectable teams for the workflow extensions: `full` (scout + full pipeline) and `info` (plan→critique→document spec) |

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
- Add `spec ` / `full ` to force the mode, or `loops=N` to override the retry limit.

For a standalone implementation **spec** (no code change), pick the `info`
team or use the `spec ` prefix: the planner produces a detailed phased plan,
the **critic** evaluates it and sends findings back to the planner for revision
if it rejects the plan (looping up to the configured `loops=N` limit), and
finally the documenter turns the approved plan into `specs/<slug>.md` that any
agent or human can build from.

## Note

These files override the global package versions only while pi runs from this
directory. The orchestration lives entirely in the extensions (`../extensions/`),
driven by these agent `.md` files and `teams.yaml`.
