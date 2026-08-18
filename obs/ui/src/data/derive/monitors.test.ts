import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunMeta } from "../types.ts";
import { ALERT_WINDOW_MS, evaluateMonitors, type Monitor } from "./monitors.ts";

// Alerts are scoped to recent activity, so these tests pin `now` instead of
// letting it default to Date.now() — the fixtures below are epoch-relative and
// would otherwise read as decades stale and be filtered out.
const NOW = 21 * 3_600_000; // comfortably inside ALERT_WINDOW_MS of every fixture

function run(p: Partial<RunMeta>): RunMeta {
  return {
    runId: "r",
    firstTs: 0,
    lastTs: 60_000,
    events: 1,
    agents: ["orchestrator"],
    costUsd: 0.1,
    tokens: 100,
    toolCalls: 5,
    errors: 0,
    startOffset: 0,
    endOffset: 0,
    ...p,
  };
}
const mon = (p: Partial<Monitor>): Monitor => ({ id: "m", name: "m", metric: "cost", threshold: 5, enabled: true, ...p });

test("cost monitor flags per-run breaches and marks ≥2× as crit", () => {
  const runs = [run({ runId: "a", costUsd: 1 }), run({ runId: "b", costUsd: 6 }), run({ runId: "c", costUsd: 12 })];
  const alerts = evaluateMonitors([mon({ metric: "cost", threshold: 5 })], runs, undefined, NOW);
  assert.equal(alerts.length, 2); // b and c
  const byRun = Object.fromEntries(alerts.map((a) => [a.runId, a]));
  assert.equal(byRun["b"].severity, "warn");
  assert.equal(byRun["c"].severity, "crit"); // 12 > 2×5
});

test("latency monitor uses activeMs, so an idle-tail run is not flagged as slow", () => {
  // 20h wall-clock but 2 min active; threshold 20 min → active-time run stays clean
  const idle = run({ runId: "idle", firstTs: 0, lastTs: 20 * 3_600_000, activeMs: 2 * 60_000 });
  const busy = run({ runId: "busy", firstTs: 0, lastTs: 60_000, activeMs: 40 * 60_000 });
  const alerts = evaluateMonitors([mon({ metric: "latency", threshold: 20 })], [idle, busy], undefined, NOW);
  assert.deepEqual(alerts.map((a) => a.runId), ["busy"]); // only the genuinely-long-working run
});

test("evalScore monitor flags runs scoring BELOW the threshold", () => {
  // a clean cheap fast run scores 100 (pass); an erroring expensive one scores low
  const good = run({ runId: "good" });
  const bad = run({ runId: "bad", errors: 5, costUsd: 50, lastTs: 60 * 60_000 });
  const alerts = evaluateMonitors([mon({ metric: "evalScore", threshold: 50 })], [good, bad], undefined, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].runId, "bad");
});

test("errorRate is an aggregate alert over the run set", () => {
  const runs = [run({ errors: 0 }), run({ errors: 0 }), run({ errors: 2 })]; // 33%
  const at20 = evaluateMonitors([mon({ metric: "errorRate", threshold: 20 })], runs, undefined, NOW);
  assert.equal(at20.length, 1);
  assert.equal(at20[0].scope, "aggregate");
  const at50 = evaluateMonitors([mon({ metric: "errorRate", threshold: 50 })], runs, undefined, NOW);
  assert.equal(at50.length, 0); // 33% < 50%
});

test("disabled monitors raise nothing; alerts sort newest-first", () => {
  const runs = [run({ runId: "old", costUsd: 9, lastTs: 1000 }), run({ runId: "new", costUsd: 9, lastTs: 9000 })];
  assert.equal(evaluateMonitors([mon({ enabled: false })], runs, undefined, NOW).length, 0);
  const alerts = evaluateMonitors([mon({ metric: "cost", threshold: 5 })], runs, undefined, NOW);
  assert.equal(alerts[0].runId, "new");
});

test("breaches age out of the alert window — a stale run stops alerting", () => {
  const m = [mon({ metric: "cost", threshold: 5 })];
  const fresh = run({ runId: "fresh", costUsd: 9, lastTs: NOW - 60_000 });
  const stale = run({ runId: "stale", costUsd: 9, lastTs: NOW - ALERT_WINDOW_MS - 60_000 });
  assert.deepEqual(
    evaluateMonitors(m, [fresh, stale], undefined, NOW).map((a) => a.runId),
    ["fresh"], // the stale breach is real but no longer actionable
  );
  // windowMs = 0 opts out of the scoping entirely (both breaches come back)
  assert.equal(evaluateMonitors(m, [fresh, stale], undefined, NOW, 0).length, 2);
});

test("the aggregate error rate is computed over the windowed runs only", () => {
  const m = [mon({ metric: "errorRate", threshold: 20 })];
  // in-window: 1 clean run (0%). Out of window: 2 erroring runs that would
  // otherwise drag the rate to 67% and raise a permanent alert.
  const runs = [
    run({ runId: "fresh", errors: 0, lastTs: NOW - 60_000 }),
    run({ runId: "old1", errors: 3, lastTs: NOW - ALERT_WINDOW_MS - 1 }),
    run({ runId: "old2", errors: 3, lastTs: NOW - ALERT_WINDOW_MS - 2 }),
  ];
  assert.equal(evaluateMonitors(m, runs, undefined, NOW).length, 0);
});
