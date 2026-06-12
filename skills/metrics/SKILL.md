---
name: metrics
description: "Report agent-workflow observability metrics for a project — the trifecta (cost, tokens, speed) plus pipeline facts (per-phase breakdown, retries, ship outcome, context-prune savings, per-tool counts). Also explains a single run (anomaly digest: retries, errors, slow tools, cost outliers) and scores runs pass/fail. Reads workflow-report.md, pi session logs, and the obs event sink offline; no live server. Use when asked how much a run cost, how long it took, where it spent time/tokens, what happened in a run, why a run was slow/expensive/failed, or to score/compare runs. Keywords - metrics, observability, cost, tokens, latency, telemetry, trifecta, how much, how long, prune savings, per-phase, explain, debug run, why slow, why failed, what happened, score, verdict, pass, fail."
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
- **The obs event sink** (`~/.pi/agent/obs/events.jsonl`, written when runs use
  `PI_OBS=1`) — the per-event stream behind `explain` and `score` below.

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

## Explain a run (anomaly digest)

```
bash <this-skill-dir>/run.sh explain <runId|--last> [--json] [--sink <file>]
```

Distills one run's event stream (from the obs sink) into a compact digest:
header facts (cost/tokens/wall/verdict/models), an agent timeline, a typed
**anomaly list** (dispatch retries, truncated outputs, tool errors with the
failing command, provider errors, slow tools/turns, cost outliers vs the run's
own median, compactions, context pressure), per-agent and per-tool rollups, and
the boot setup (tools/skills/context-file/prompt sizes).

**How to use it:** run the command, read the digest, then ANSWER THE USER'S
QUESTION from it — lead with the anomalies that explain the symptom they asked
about (slow → slow-tool/slow-turn/retries; expensive → cost-outlier/context/
compaction; failed → tool-error/provider-error/truncated/verdict). Quote the
specific numbers. `<runId|--last>` accepts a unique runId prefix; `--last` is
the most recent run. Run ids are visible in the dashboard's Trace view, or from
a wrong-id error (it lists recent runs).

## Score a run (verdict)

```
bash <this-skill-dir>/run.sh score <runId|--last> --pass|--fail [--note <text>] [--sink <file>]
```

Appends a `verdict` event for the run to the obs sink. The workflow auto-emits
a verdict at terminal status (shipped/done → pass, retries exhausted → fail,
else open); this records or OVERRIDES the human judgement — the last verdict
wins. Verdicts power the dashboard's Run history (pass rate, medians) and the
✓/✗ marks in its run pickers.

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
