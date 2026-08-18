import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAnalytics, buildSeries } from "./analytics.ts";
import type { RunMeta } from "../types.ts";

function run(p: Partial<RunMeta>): RunMeta {
  return {
    runId: "r",
    firstTs: 0,
    lastTs: 0,
    events: 1,
    agents: ["orchestrator"],
    costUsd: 0,
    errors: 0,
    startOffset: 0,
    endOffset: 0,
    ...p,
  };
}

test("collectAnalytics computes pass rate over scored runs only", () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  const a = collectAnalytics(
    [
      run({ verdict: { status: "pass", ts: 0 } }),
      run({ verdict: { status: "fail", ts: 0 } }),
      run({ verdict: { status: "open", ts: 0 } }),
      run({}), // unscored
    ],
    now,
  );
  assert.equal(a.totalRuns, 4);
  assert.equal(a.scored, 2);
  assert.equal(a.passRate, 0.5);
});

test("a run can both pass and have errored — pass rate and errRuns overlap", () => {
  // The pair that read as a contradiction in the telemetry strip: one run,
  // verdict pass, 37 recovered tool errors → pass 100% AND every run errored.
  // Both are correct and measure different things, so neither may be derived
  // from the other.
  const a = collectAnalytics([run({ verdict: { status: "pass", ts: 0 }, errors: 37 })]);
  assert.equal(a.passRate, 1);
  assert.equal(a.errRuns, 1);
  assert.equal(a.errorRate, 1);
  assert.equal(a.outcomes.pass, 1);
  assert.equal(a.outcomes.fail, 0); // errors are NOT failures
});

test("errRuns counts runs touched by an error, not the errors themselves", () => {
  const a = collectAnalytics([run({ errors: 99 }), run({ errors: 1 }), run({ errors: 0 })]);
  assert.equal(a.errRuns, 2); // two runs affected — not 100
  assert.ok(Math.abs(a.errorRate - 2 / 3) < 1e-9);
  assert.equal(collectAnalytics([]).errRuns, 0); // and no divide-by-zero on an empty set
  assert.equal(collectAnalytics([]).errorRate, 0);
});

test("collectAnalytics aggregates tokens/tools, outcome mix, and per-project breakdown", () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  const a = collectAnalytics(
    [
      run({ cwd: "/u/proj-a", costUsd: 1, tokens: 100, toolCalls: 3, verdict: { status: "pass", ts: 0 } }),
      run({ cwd: "/u/proj-a", costUsd: 2, tokens: 200, toolCalls: 5, verdict: { status: "fail", ts: 0 } }),
      run({ cwd: "/u/proj-b", costUsd: 0.5, tokens: 50, toolCalls: 1 }), // unscored → open
    ],
    now,
  );
  assert.equal(a.totalTokens, 350);
  assert.equal(a.totalToolCalls, 9);
  assert.deepEqual(a.outcomes, { pass: 1, fail: 1, open: 1 });
  // projects, costliest first
  assert.equal(a.projects[0].project, "proj-a");
  assert.equal(a.projects[0].costUsd, 3);
  assert.equal(a.projects[0].tokens, 300);
  assert.equal(a.projects[0].scored, 2);
  assert.equal(a.projects[0].passed, 1);
  assert.equal(a.projects[1].project, "proj-b");
});

test("collectAnalytics sums spend by model (per-model cost, else primary)", () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  const a = collectAnalytics(
    [
      run({ costUsd: 0.8, models: ["anthropic/x", "gateframe/y"], modelCost: { "anthropic/x": 0.6, "gateframe/y": 0.2 } }),
      run({ costUsd: 0.5, models: ["anthropic/x"], modelCost: { "anthropic/x": 0.5 } }),
      run({ costUsd: 0.3, models: ["gateframe/y"] }), // no modelCost → falls to primary
    ],
    now,
  );
  const byModel = Object.fromEntries(a.models.map((m) => [m.model, m]));
  assert.ok(Math.abs(byModel["anthropic/x"].costUsd - 1.1) < 1e-9); // 0.6 + 0.5
  assert.equal(byModel["anthropic/x"].runs, 2);
  assert.ok(Math.abs(byModel["gateframe/y"].costUsd - 0.5) < 1e-9); // 0.2 + 0.3 (fallback)
  assert.equal(a.models[0].model, "anthropic/x"); // costliest first
  assert.equal(a.costPerDay, 0); // lastTs 0 → every run precedes the 14d window
});

test("collectAnalytics buckets runs/cost by day and medians duration", () => {
  // local-time constructors: day buckets key on LOCAL date parts, so the
  // fixture must share a local day regardless of the machine's timezone
  const now = new Date(2026, 5, 13, 12, 0, 0).getTime();
  const today = new Date(2026, 5, 13, 9, 0, 0).getTime();
  const a = collectAnalytics(
    [
      run({ firstTs: today, lastTs: today + 60_000, costUsd: 1 }),
      run({ firstTs: today, lastTs: today + 120_000, costUsd: 2 }),
      run({ firstTs: today, lastTs: today + 180_000, costUsd: 3, errors: 1 }),
    ],
    now,
  );
  assert.equal(a.days.length, 14);
  const last = a.days[a.days.length - 1];
  assert.equal(last.runs, 3);
  assert.equal(last.costUsd, 6);
  assert.ok(Math.abs(a.costPerDay - 6 / 14) < 1e-9); // all three runs are inside the 14d window
  assert.equal(a.p50DurationMs, 120_000);
  assert.equal(a.p95DurationMs, 180_000);
  assert.ok(Math.abs(a.errorRate - 1 / 3) < 1e-9);
});

test("buildSeries spans all runs, auto-bucketed by span", () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  const hourAgo = now - 3_600_000;
  const s = buildSeries(
    [
      run({ firstTs: now, lastTs: now, costUsd: 1, tokens: 100, errors: 0 }),
      run({ firstTs: now, lastTs: now, costUsd: 2, tokens: 200, errors: 1 }),
      run({ firstTs: hourAgo, lastTs: hourAgo, costUsd: 0.5, tokens: 50, errors: 0 }),
    ],
    now,
  );
  assert.equal(s.length, 2); // 1h span → 2 hourly buckets, no padding
  const last = s[s.length - 1];
  assert.equal(last.runs, 2);
  assert.equal(last.costUsd, 3);
  assert.equal(last.tokens, 300);
  assert.equal(last.errRuns, 1);
  assert.equal(s[0].runs, 1); // the run an hour earlier
  assert.equal(buildSeries([], now).length, 0);

  // a 10-day span coarsens to daily buckets (no run dropped)
  const DAY = 86_400_000;
  const wide = buildSeries([run({ firstTs: now - 10 * DAY, lastTs: now - 10 * DAY }), run({ firstTs: now, lastTs: now })], now);
  assert.ok(wide.length >= 10 && wide.length <= 12);
  assert.equal(wide.reduce((n, p) => n + p.runs, 0), 2);
});
