// Automated evaluators — score a run against a set of checks, producing numeric
// scores tracked over run history. Phase 1 ships deterministic *heuristic*
// evaluators (computed purely from a run's telemetry, so they need no LLM and
// are fully testable). LLM-as-judge evaluators are a follow-up: they produce the
// same EvalResult shape (id/score/level/value/reason), so the UI and the history
// rollup below work unchanged once they land.
import type { RunMeta } from "../types";
import { formatCost, formatDuration } from "../../lib/format";

export type EvalLevel = "pass" | "warn" | "fail";

export interface EvalConfig {
  costBudgetUsd: number;
  maxDurationMs: number;
  maxToolCalls: number;
}

// Sensible defaults for a single agentic run; surfaced as constants now, editable
// from the UI in a later pass.
export const DEFAULT_EVAL_CONFIG: EvalConfig = {
  costBudgetUsd: 1.0,
  maxDurationMs: 10 * 60_000,
  maxToolCalls: 60,
};

export interface EvalResult {
  id: string; // evaluator id, stable across runs (for history)
  label: string;
  score: number; // 0..1
  level: EvalLevel; // derived from score thresholds
  value: string; // the measured value, human-readable
  reason: string; // one-line explanation
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
function levelFor(score: number): EvalLevel {
  return score >= 0.999 ? "pass" : score >= 0.5 ? "warn" : "fail";
}
// A "budget" check: at/under budget = 1; degrades to 0 at 2× budget.
function budgetScore(value: number, budget: number): number {
  if (budget <= 0) return 1;
  const ratio = value / budget;
  return ratio <= 1 ? 1 : clamp01(2 - ratio);
}
function overPct(value: number, budget: number): number {
  return budget > 0 ? Math.round((value / budget - 1) * 100) : 0;
}

// Run the heuristic evaluators over one run's metadata.
export function evaluateRun(run: RunMeta, cfg: EvalConfig = DEFAULT_EVAL_CONFIG): EvalResult[] {
  // Latency = the run's ACTIVE makespan (work time with idle gaps and any
  // abandoned/lingering tail removed), not lastTs - firstTs, which counts idle
  // waits and an open-but-quiet session — an interactive run left open reads as
  // hours of "latency". Fall back to wall-clock only for runs from an older server
  // that predate activeMs.
  const durMs = run.activeMs ?? Math.max(0, run.lastTs - run.firstTs);
  const tools = run.toolCalls ?? 0;
  const errs = run.errors;

  // error-free: any error is significant; degrade ~a third per error.
  const errScore = errs === 0 ? 1 : clamp01(1 - errs * 0.34);
  const costScore = budgetScore(run.costUsd, cfg.costBudgetUsd);
  const latScore = budgetScore(durMs, cfg.maxDurationMs);
  const toolScore = budgetScore(tools, cfg.maxToolCalls);

  return [
    {
      id: "error-free",
      label: "Error-free",
      score: errScore,
      level: levelFor(errScore),
      value: errs === 0 ? "0 errors" : `${errs} error${errs === 1 ? "" : "s"}`,
      reason: errs === 0 ? "No errors or failed tools." : `${errs} error${errs === 1 ? "" : "s"} during the run.`,
    },
    {
      id: "cost-budget",
      label: "Cost budget",
      score: costScore,
      level: levelFor(costScore),
      value: `${formatCost(run.costUsd)} / ${formatCost(cfg.costBudgetUsd)}`,
      reason:
        run.costUsd <= cfg.costBudgetUsd
          ? "Within the cost budget."
          : `Over budget by ${overPct(run.costUsd, cfg.costBudgetUsd)}%.`,
    },
    {
      id: "latency",
      label: "Latency",
      score: latScore,
      level: levelFor(latScore),
      value: formatDuration(durMs),
      reason:
        durMs <= cfg.maxDurationMs
          ? `Finished within ${formatDuration(cfg.maxDurationMs)}.`
          : `${overPct(durMs, cfg.maxDurationMs)}% over the ${formatDuration(cfg.maxDurationMs)} budget.`,
    },
    {
      id: "tool-efficiency",
      label: "Tool efficiency",
      score: toolScore,
      level: levelFor(toolScore),
      value: `${tools} tool call${tools === 1 ? "" : "s"}`,
      reason:
        tools <= cfg.maxToolCalls
          ? `Under the ${cfg.maxToolCalls}-call budget.`
          : `${tools} calls — over the ${cfg.maxToolCalls}-call budget.`,
    },
  ];
}

// The run's overall evaluator score (mean of the checks) + its level.
export function overallScore(results: EvalResult[]): { score: number; level: EvalLevel } {
  if (!results.length) return { score: 1, level: "pass" };
  const score = results.reduce((s, r) => s + r.score, 0) / results.length;
  return { score, level: levelFor(score) };
}

// Scored history: per-evaluator pass-rate + mean score across a set of runs.
export interface EvalSummaryRow {
  id: string;
  label: string;
  passRate: number; // 0..1, share of runs at "pass"
  avgScore: number; // 0..1
  runs: number;
}
// Per-evaluator score trend: the chronological score sequence (oldest → newest)
// plus the pass-rate and mean — for the Analytics regression sparklines.
export interface EvalTrendRow {
  id: string;
  label: string;
  scores: number[]; // 0..1, oldest run first
  passRate: number;
  avgScore: number;
}
export function evalTrends(runsOldestFirst: RunMeta[], cfg: EvalConfig = DEFAULT_EVAL_CONFIG): EvalTrendRow[] {
  const acc = new Map<string, { label: string; scores: number[]; pass: number }>();
  for (const r of runsOldestFirst) {
    for (const res of evaluateRun(r, cfg)) {
      let a = acc.get(res.id);
      if (!a) {
        a = { label: res.label, scores: [], pass: 0 };
        acc.set(res.id, a);
      }
      a.scores.push(res.score);
      if (res.level === "pass") a.pass++;
    }
  }
  return [...acc.entries()].map(([id, a]) => ({
    id,
    label: a.label,
    scores: a.scores,
    passRate: a.scores.length ? a.pass / a.scores.length : 0,
    avgScore: a.scores.length ? a.scores.reduce((s, x) => s + x, 0) / a.scores.length : 0,
  }));
}

export function evalSummary(runs: RunMeta[], cfg: EvalConfig = DEFAULT_EVAL_CONFIG): EvalSummaryRow[] {
  const acc = new Map<string, { label: string; pass: number; sum: number; n: number }>();
  for (const r of runs) {
    for (const res of evaluateRun(r, cfg)) {
      let a = acc.get(res.id);
      if (!a) {
        a = { label: res.label, pass: 0, sum: 0, n: 0 };
        acc.set(res.id, a);
      }
      a.n++;
      a.sum += res.score;
      if (res.level === "pass") a.pass++;
    }
  }
  return [...acc.entries()].map(([id, a]) => ({
    id,
    label: a.label,
    passRate: a.n ? a.pass / a.n : 0,
    avgScore: a.n ? a.sum / a.n : 0,
    runs: a.n,
  }));
}
