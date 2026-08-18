import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunMeta } from "../types.ts";
import { evaluateRun, overallScore, evalSummary, evalTrends, DEFAULT_EVAL_CONFIG } from "./evals.ts";

function run(p: Partial<RunMeta>): RunMeta {
  return {
    runId: "r",
    firstTs: 0,
    lastTs: 60_000, // 1 min
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

const byId = (rs: ReturnType<typeof evaluateRun>) => Object.fromEntries(rs.map((r) => [r.id, r]));

test("a clean, cheap, fast run passes every evaluator", () => {
  const rs = byId(evaluateRun(run({})));
  for (const id of ["error-free", "cost-budget", "latency", "tool-efficiency"]) {
    assert.equal(rs[id].level, "pass", `${id} should pass`);
    assert.equal(rs[id].score, 1);
  }
  assert.equal(overallScore(evaluateRun(run({}))).level, "pass");
});

test("errors fail the error-free check and degrade per error", () => {
  assert.equal(byId(evaluateRun(run({ errors: 1 }))) ["error-free"].level, "warn"); // ~0.66
  assert.equal(byId(evaluateRun(run({ errors: 3 }))) ["error-free"].level, "fail"); // ~0
  assert.equal(byId(evaluateRun(run({ errors: 0 }))) ["error-free"].value, "0 errors");
});

test("cost over budget warns at 1.5×, fails at ≥2×", () => {
  const cfg = DEFAULT_EVAL_CONFIG; // budget $1.00
  assert.equal(byId(evaluateRun(run({ costUsd: 1.5 }), cfg))["cost-budget"].level, "warn");
  assert.equal(byId(evaluateRun(run({ costUsd: 2.5 }), cfg))["cost-budget"].level, "fail");
});

test("latency budget: long runs degrade", () => {
  const cfg = DEFAULT_EVAL_CONFIG; // 10 min
  assert.equal(byId(evaluateRun(run({ firstTs: 0, lastTs: 9 * 60_000 }), cfg))["latency"].level, "pass");
  assert.equal(byId(evaluateRun(run({ firstTs: 0, lastTs: 20 * 60_000 }), cfg))["latency"].level, "fail");
});

test("latency uses activeMs when present, not wall-clock (idle-tail run passes)", () => {
  const cfg = DEFAULT_EVAL_CONFIG; // 10 min
  // 20h wall-clock but only 2 min of active work → passes on active time
  const lat = byId(evaluateRun(run({ firstTs: 0, lastTs: 20 * 3_600_000, activeMs: 2 * 60_000 }), cfg))["latency"];
  assert.equal(lat.level, "pass");
  assert.equal(lat.value, "2m");
  // activeMs === 0 (no leaf work recorded) must still be honored, not fall back to wall-clock
  assert.equal(byId(evaluateRun(run({ firstTs: 0, lastTs: 20 * 3_600_000, activeMs: 0 }), cfg))["latency"].level, "pass");
});

test("evalTrends keeps the chronological score sequence per evaluator", () => {
  const runs = [run({ errors: 0 }), run({ errors: 5 }), run({ errors: 0 })];
  const rows = Object.fromEntries(evalTrends(runs).map((r) => [r.id, r]));
  assert.equal(rows["error-free"].scores.length, 3);
  assert.equal(rows["error-free"].scores[0], 1); // clean
  assert.ok(rows["error-free"].scores[1] < 0.5); // 5 errors
  assert.equal(rows["error-free"].scores[2], 1); // clean again
  assert.ok(Math.abs(rows["error-free"].passRate - 2 / 3) < 1e-9);
});

test("evalConfig changes the scores (tighter budget fails more)", () => {
  const r = run({ costUsd: 0.8 });
  assert.equal(evaluateRun(r, DEFAULT_EVAL_CONFIG).find((x) => x.id === "cost-budget")!.level, "pass");
  assert.equal(evaluateRun(r, { ...DEFAULT_EVAL_CONFIG, costBudgetUsd: 0.4 }).find((x) => x.id === "cost-budget")!.level, "fail");
});

test("evalSummary rolls up per-evaluator pass-rate across runs", () => {
  const runs = [run({ errors: 0 }), run({ errors: 0 }), run({ errors: 5 })]; // 2/3 error-free
  const rows = Object.fromEntries(evalSummary(runs).map((r) => [r.id, r]));
  assert.equal(rows["error-free"].runs, 3);
  assert.ok(Math.abs(rows["error-free"].passRate - 2 / 3) < 1e-9);
  assert.equal(rows["cost-budget"].passRate, 1); // all within budget
});
