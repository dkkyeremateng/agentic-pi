---
name: metrics
description: "Report agent-workflow observability metrics for a project — the trifecta (cost, tokens, speed) plus pipeline facts (per-phase breakdown, retries, ship outcome, context-prune savings, per-tool counts). Reads the workflow-report.md and the per-agent pi session logs offline; no live server. Use when asked how much a run cost, how long it took, where it spent time/tokens, whether pruning helped, or to compare runs. Keywords - metrics, observability, cost, tokens, latency, telemetry, trifecta, how much, how long, prune savings, per-phase."
allowed-tools: Bash
---

# Agent observability — run metrics

Offline analyzer over the artifacts a workflow run already leaves behind:

- **`.agent/metrics.json`** — the authoritative, machine-readable single-run record
  the workflow now emits alongside the report: totals (cost / tokens / wall-clock /
  tool calls), per-phase breakdown, attempts (retries), ship outcome, and the exact
  run window (`startedAt`/`endedAt`). `.agent/metrics.jsonl` appends one line per run
  for trends. Preferred when present; falls back to parsing `workflow-report.md`.
- **`workflow-report.md`** (project root or `.agent/`) — the human report; parsed for
  the same headline facts when `metrics.json` is absent (older runs).
- **Per-agent pi session logs** (`~/.pi/agent/sessions/<project-hash>/*.json`) — add
  the detail the report summarizes away: per-tool counts, tool errors, and
  context-prune savings. Auto-scoped to the run's time window (from the report) so
  reused session files aren't double-counted across runs.

## Run it

```
bash <this-skill-dir>/run.sh [project-path] [flags]
```

- `project-path` — defaults to the current directory.
- `--all [root]` — **cross-run trends**: discover every `.agent/metrics.jsonl` under
  `root` (default cwd) and aggregate all runs across projects.
- `--json` — emit the machine-readable object instead of text (single run: `{ report,
  run }`; `--all`: the `TrendReport`).
- `--since <ISO> --until <ISO>` — single run: scope the session-log window (overrides
  the auto window). With `--all`: filter runs by start date.
- `--session <file.jsonl>` — analyze one session file directly (e.g. an orchestrator
  log), bypassing project lookup.

Examples:

```
bash <this-skill-dir>/run.sh ~/Documents/Dev/slf/ai/projects/plp
bash <this-skill-dir>/run.sh . --json
bash <this-skill-dir>/run.sh --all ~/Documents/Dev/slf/ai/projects
bash <this-skill-dir>/run.sh --session ~/.pi/agent/sessions/--Users-.../2026-...jsonl
```

From the config repo you can also use `npm run metrics -- [project-path] [flags]`.

## Metrics reported

**Trifecta (authoritative, from the report)**
- cost (USD), tokens (in / out / cache), wall-clock, tool calls
- ship outcome + verdict + attempts (e.g. `paused (verdict UNKNOWN), 0/3 attempt(s)`)

**Per phase (from the report)** — duration, cost, tokens for scout → … → ship.

**Pipeline facts** — phase ledger from `.agent/progress.md` (done/total).

**Detail (from session logs)** — per agent: duration, cost, tokens, turns, tool calls,
per-tool breakdown, tool errors, and context-prune events + estimated tokens reclaimed.

**Cross-run trends (`--all`)** — runs count + date range; aggregate cost/tokens/speed
(total and per-run); ship outcomes (shipped/paused/failed) + validator pass rate; retry
rate + mean attempts/run; slowest and costliest phase; per-phase averages; per-project
rollup (runs, total cost, mean wall-clock, shipped count). Reads the append-only
`.agent/metrics.jsonl` (one line per run); `node_modules`/`.git`/build dirs are skipped.

## Notes

- If there is no `workflow-report.md`, the tool falls back to a session-log-only
  rollup and warns that totals may be cumulative across runs — pass `--since/--until`
  to scope one run.
- The report's cost/tokens include the orchestrator's own session; the per-agent log
  detail covers only the spawned sub-agents, so the two columns differ slightly.
