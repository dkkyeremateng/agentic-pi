// Monitors — user-defined thresholds that raise alerts when runs breach them
// (cost, latency, low eval score, or aggregate error rate). Pure + tested; the
// view and the header badge both read evaluateMonitors(). Client-side only —
// persisted in the store; a webhook/notification sink is a later add.
import type { RunMeta } from "../types";
import { evaluateRun, overallScore, DEFAULT_EVAL_CONFIG, type EvalConfig } from "./evals";
import { formatCost, formatDuration } from "../../lib/format";

export type MonitorMetric = "cost" | "latency" | "evalScore" | "errorRate";

export interface Monitor {
  id: string;
  name: string;
  metric: MonitorMetric;
  threshold: number; // cost $, latency minutes, evalScore 0-100, errorRate %
  enabled: boolean;
}

// Per-metric display metadata (unit + comparison direction + threshold stepper
// defaults: `step` sizes the +/- increment, `def` pre-fills the "add" row).
export const METRIC_META: Record<
  MonitorMetric,
  { label: string; unit: string; cmp: "above" | "below"; scope: "run" | "aggregate"; step: number; def: number }
> = {
  cost: { label: "Cost per run", unit: "$", cmp: "above", scope: "run", step: 1, def: 5 },
  latency: { label: "Run latency", unit: "min", cmp: "above", scope: "run", step: 5, def: 20 },
  evalScore: { label: "Eval score", unit: "/100", cmp: "below", scope: "run", step: 5, def: 50 },
  errorRate: { label: "Error rate", unit: "%", cmp: "above", scope: "aggregate", step: 5, def: 20 },
};

// One default monitor per metric (id = metric so seeds are stable).
export const DEFAULT_MONITORS: Monitor[] = [
  { id: "cost", name: "Cost per run", metric: "cost", threshold: 5, enabled: true },
  { id: "latency", name: "Slow run", metric: "latency", threshold: 20, enabled: true },
  { id: "evalScore", name: "Low eval score", metric: "evalScore", threshold: 50, enabled: true },
  { id: "errorRate", name: "Error rate", metric: "errorRate", threshold: 20, enabled: true },
];

export interface Alert {
  monitorId: string;
  monitorName: string;
  metric: MonitorMetric;
  scope: "run" | "aggregate";
  severity: "warn" | "crit"; // crit = breached by ≥2× (or ≤½ for eval score)
  runId?: string; // per-run alerts
  value: number;
  threshold: number;
  ts: number; // run.lastTs (per-run) or `now` (aggregate)
  detail: string;
}

const MAX_ALERTS = 200;

// An alert describes something that needs attention NOW, so a breach ages out:
// without this every run over budget in the whole index alerts forever, the
// header badge latches on permanently, and the count stops meaning anything.
// Both per-run breaches and the aggregate error rate are scoped to this window.
export const ALERT_WINDOW_MS = 24 * 60 * 60_000;

export function evaluateMonitors(
  monitors: Monitor[],
  allRuns: RunMeta[],
  cfg: EvalConfig = DEFAULT_EVAL_CONFIG,
  now = Date.now(),
  windowMs: number = ALERT_WINDOW_MS,
): Alert[] {
  const runs = windowMs > 0 ? allRuns.filter((r) => now - r.lastTs <= windowMs) : allRuns;
  const alerts: Alert[] = [];
  for (const m of monitors) {
    if (!m.enabled) continue;

    if (m.metric === "errorRate") {
      if (!runs.length) continue;
      const withErr = runs.filter((r) => r.errors > 0).length;
      const rate = (withErr / runs.length) * 100;
      if (rate > m.threshold) {
        alerts.push({
          monitorId: m.id,
          monitorName: m.name,
          metric: m.metric,
          scope: "aggregate",
          severity: rate > m.threshold * 2 ? "crit" : "warn",
          value: rate,
          threshold: m.threshold,
          ts: now,
          detail: `${Math.round(rate)}% of ${runs.length} runs errored (> ${m.threshold}%)`,
        });
      }
      continue;
    }

    for (const r of runs) {
      let value: number;
      let breach: boolean;
      let crit: boolean;
      let detail: string;
      if (m.metric === "cost") {
        value = r.costUsd;
        breach = value > m.threshold;
        crit = value > m.threshold * 2;
        detail = `${formatCost(value)} > ${formatCost(m.threshold)}`;
      } else if (m.metric === "latency") {
        // active makespan, not wall-clock — an idle/lingering run isn't "slow"
        const ms = r.activeMs ?? Math.max(0, r.lastTs - r.firstTs);
        value = ms / 60_000;
        breach = value > m.threshold;
        crit = value > m.threshold * 2;
        detail = `${formatDuration(ms)} > ${m.threshold}m`;
      } else {
        // evalScore
        value = overallScore(evaluateRun(r, cfg)).score * 100;
        breach = value < m.threshold;
        crit = value < m.threshold / 2;
        detail = `score ${Math.round(value)} < ${m.threshold}`;
      }
      if (breach) {
        alerts.push({
          monitorId: m.id,
          monitorName: m.name,
          metric: m.metric,
          scope: "run",
          severity: crit ? "crit" : "warn",
          runId: r.runId,
          value,
          threshold: m.threshold,
          ts: r.lastTs,
          detail,
        });
      }
    }
  }
  alerts.sort((a, b) => b.ts - a.ts);
  return alerts.slice(0, MAX_ALERTS);
}
