// collectAnalytics — cross-run aggregates computed from the /api/runs list, so
// they're limited to what RunMeta exposes. Per-agent spend and slowest tools
// need per-run digests (N fetches) and are deferred.
import type { RunMeta } from "../types";
import { projectOf } from "../../lib/format";

export interface DayBucket {
  day: string; // YYYY-MM-DD
  label: string; // e.g. "Jun 13"
  runs: number;
  costUsd: number;
}

export interface ProjectStat {
  project: string;
  runs: number;
  costUsd: number;
  tokens: number;
  scored: number;
  passed: number; // pass rate = passed / scored
}

export interface ModelStat {
  model: string;
  costUsd: number;
  runs: number; // runs that used this model
}

export interface Analytics {
  totalRuns: number;
  scored: number;
  passRate: number; // 0..1 over scored runs
  p50DurationMs: number;
  p95DurationMs: number;
  totalCost: number;
  costPerDay: number;
  totalTokens: number;
  totalToolCalls: number;
  // How many runs hit AT LEAST ONE error, and that as a share of all runs.
  // NOT a fail rate: an agent run routinely recovers from a failed tool call
  // and still passes its verdict, so a run can land in both `outcomes.pass`
  // and here. Callers that show this next to pass-rate should say which they
  // mean — two bare percentages side by side read as a contradiction.
  errRuns: number;
  errorRate: number; // 0..1, errRuns / totalRuns
  avgAgents: number;
  outcomes: { pass: number; fail: number; open: number }; // open = everything not pass/fail
  projects: ProjectStat[]; // costliest first
  models: ModelStat[]; // spend by model, costliest first
  days: DayBucket[];
}

function dayKey(ts: number): string {
  // local date parts, so the key agrees with the local-timezone dayLabel below
  // (toISOString would bucket late-evening runs into the next UTC day)
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function hourLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric" });
}
function monthLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

// ── time series (for the headline trend + KPI sparklines) ──
export interface SeriesPoint {
  t: number; // bucket start (epoch ms)
  label: string;
  runs: number;
  costUsd: number;
  tokens: number;
  errors: number;
  errRuns: number; // runs with ≥1 error (for error rate)
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const MAX_BUCKETS = 600; // cap path density for very long spans

// One trend across all runs: window = oldest run → latest activity, with the
// bucket size auto-chosen from the span so every run is on the chart.
export function buildSeries(runs: RunMeta[], now = Date.now()): SeriesPoint[] {
  if (!runs.length) return [];
  const oldest = Math.min(...runs.map((r) => r.firstTs));
  const end = Math.min(now, Math.max(...runs.map((r) => r.lastTs)));
  const span = Math.max(HOUR, end - oldest);
  const step = span <= 2 * DAY ? HOUR : span <= 90 * DAY ? DAY : span <= 2 * 365 * DAY ? WEEK : MONTH;
  const label = step >= MONTH ? monthLabel : step >= DAY ? dayLabel : hourLabel;

  const endB = Math.floor(end / step);
  let start = Math.floor(oldest / step);
  if (endB - start + 1 > MAX_BUCKETS) start = endB - (MAX_BUCKETS - 1);
  const pts: SeriesPoint[] = [];
  for (let b = start; b <= endB; b++) {
    const t = b * step;
    pts.push({ t, label: label(t), runs: 0, costUsd: 0, tokens: 0, errors: 0, errRuns: 0 });
  }
  for (const r of runs) {
    const i = Math.floor(r.lastTs / step) - start;
    if (i < 0 || i >= pts.length) continue;
    const p = pts[i];
    p.runs++;
    p.costUsd += r.costUsd;
    p.tokens += r.tokens ?? 0;
    p.errors += r.errors;
    if (r.errors > 0) p.errRuns++;
  }
  return pts;
}

export function collectAnalytics(runs: RunMeta[], now = Date.now(), windowDays = 14): Analytics {
  const totalRuns = runs.length;
  const scored = runs.filter((r) => r.verdict?.status === "pass" || r.verdict?.status === "fail").length;
  const passed = runs.filter((r) => r.verdict?.status === "pass").length;
  const durations = runs.map((r) => Math.max(0, r.lastTs - r.firstTs));
  const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
  // costPerDay averages only spend inside the window — all-time cost / windowDays
  // would understate recent burn on a long history
  const windowStart = now - windowDays * 86_400_000;
  const windowCost = runs.reduce((s, r) => (r.lastTs >= windowStart ? s + r.costUsd : s), 0);
  const totalTokens = runs.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const totalToolCalls = runs.reduce((s, r) => s + (r.toolCalls ?? 0), 0);
  const withErrors = runs.filter((r) => r.errors > 0).length;
  const agentSum = runs.reduce((s, r) => s + r.agents.length, 0);

  // outcome mix
  const outcomes = { pass: 0, fail: 0, open: 0 };
  for (const r of runs) {
    if (r.verdict?.status === "pass") outcomes.pass++;
    else if (r.verdict?.status === "fail") outcomes.fail++;
    else outcomes.open++;
  }

  // per-project breakdown (costliest first)
  const projMap = new Map<string, ProjectStat>();
  for (const r of runs) {
    const key = projectOf(r.cwd);
    let p = projMap.get(key);
    if (!p) {
      p = { project: key, runs: 0, costUsd: 0, tokens: 0, scored: 0, passed: 0 };
      projMap.set(key, p);
    }
    p.runs++;
    p.costUsd += r.costUsd;
    p.tokens += r.tokens ?? 0;
    if (r.verdict?.status === "pass" || r.verdict?.status === "fail") p.scored++;
    if (r.verdict?.status === "pass") p.passed++;
  }
  const projects = [...projMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  // spend by model (accurate when the server provides per-model cost; else the
  // run's whole cost falls to its primary model)
  const modelMap = new Map<string, ModelStat>();
  const bump = (model: string, cost: number) => {
    let m = modelMap.get(model);
    if (!m) {
      m = { model, costUsd: 0, runs: 0 };
      modelMap.set(model, m);
    }
    m.costUsd += cost;
    m.runs++;
  };
  for (const r of runs) {
    const mc = r.modelCost && Object.keys(r.modelCost).length ? r.modelCost : null;
    if (mc) {
      for (const [model, cost] of Object.entries(mc)) bump(model, cost);
    } else if (r.models?.length) {
      bump(r.models[0], r.costUsd); // fallback: attribute to the primary model
    }
  }
  const models = [...modelMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  // day buckets across the window, oldest → newest
  const buckets = new Map<string, DayBucket>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const ts = now - i * 86_400_000;
    buckets.set(dayKey(ts), { day: dayKey(ts), label: dayLabel(ts), runs: 0, costUsd: 0 });
  }
  for (const r of runs) {
    const b = buckets.get(dayKey(r.lastTs));
    if (b) {
      b.runs++;
      b.costUsd += r.costUsd;
    }
  }
  const days = [...buckets.values()];

  return {
    totalRuns,
    scored,
    passRate: scored ? passed / scored : 0,
    p50DurationMs: median(durations),
    p95DurationMs: percentile(durations, 0.95),
    totalCost,
    costPerDay: windowCost / windowDays,
    totalTokens,
    totalToolCalls,
    errRuns: withErrors,
    errorRate: totalRuns ? withErrors / totalRuns : 0,
    avgAgents: totalRuns ? agentSum / totalRuns : 0,
    outcomes,
    projects,
    models,
    days,
  };
}
