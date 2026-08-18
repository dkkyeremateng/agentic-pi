import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunMeta } from "../data/types.ts";
import { availableDateWins, withinDateWin, filterRuns, groupRunsByTime, isNoopRun, matchesRunSearch, statusOf, DATE_WINDOWS } from "./runUtils.ts";

const NOW = 1_000_000_000_000;

function run(ageMs: number): RunMeta {
  const lastTs = NOW - ageMs;
  return {
    runId: "r" + ageMs,
    firstTs: lastTs - 1000,
    lastTs,
    events: 1,
    agents: ["orchestrator"],
    costUsd: 0,
    errors: 0,
    startOffset: 0,
    endOffset: 0,
  };
}

test("filterRuns scopes by status facet and recency window", () => {
  const liveRun = { ...run(0), runId: "live" }; // <60s → live
  const passRun = { ...run(2 * DATE_WINDOWS["1d"]), runId: "pass", verdict: { status: "pass" } } as RunMeta;
  const failRun = { ...run(2 * DATE_WINDOWS["1d"]), runId: "fail", verdict: { status: "fail" } } as RunMeta;
  const all = [liveRun, passRun, failRun];

  assert.deepEqual(filterRuns(all, "all", "max", NOW).map((r) => r.runId), ["live", "pass", "fail"]);
  assert.deepEqual(filterRuns(all, "fail", "max", NOW).map((r) => r.runId), ["fail"]);
  // the 1-day window drops the 2-day-old pass/fail runs, keeping only the recent one
  assert.deepEqual(filterRuns(all, "all", "1d", NOW).map((r) => r.runId), ["live"]);
});

test("statusOf prefers an existing verdict over recency — a fresh-verdicted run isn't 'live'", () => {
  const fresh = run(0); // last event just now — inside the live window
  assert.equal(statusOf(fresh, NOW), "live"); // unverdicted → live
  assert.equal(statusOf({ ...fresh, verdict: { status: "pass" } } as RunMeta, NOW), "pass");
  assert.equal(statusOf({ ...fresh, verdict: { status: "fail" } } as RunMeta, NOW), "fail");
  // a non-terminal verdict (paused) doesn't mask liveness
  assert.equal(statusOf({ ...fresh, verdict: { status: "paused" } } as RunMeta, NOW), "live");
  // finished + unverdicted stays open
  assert.equal(statusOf(run(2 * DATE_WINDOWS["1d"]), NOW), "open");
});

test('filterRuns "active" facet keys off the open-session set, not recency/verdict', () => {
  const liveRun = { ...run(0), runId: "live" }; // recent, but its session has closed
  const idleOpen = { ...run(3 * DATE_WINDOWS["1d"]), runId: "idle", verdict: { status: "pass" } } as RunMeta; // old + auto-pass, but still open
  const all = [liveRun, idleOpen];
  const open = new Set(["idle"]); // only "idle" has a live pi session

  // openness wins regardless of age or verdict; "live" (closed) is excluded
  assert.deepEqual(filterRuns(all, "active", "max", NOW, "all", open).map((r) => r.runId), ["idle"]);
  // and the recency window does NOT gate the active facet (idle is 3 days old)
  assert.deepEqual(filterRuns(all, "active", "1d", NOW, "all", open).map((r) => r.runId), ["idle"]);
  // no live set → nothing is active
  assert.deepEqual(filterRuns(all, "active", "max", NOW).map((r) => r.runId), []);
});

test("withinDateWin caps by last activity; max keeps all", () => {
  const r = run(2 * DATE_WINDOWS["1d"]); // 2 days old
  assert.equal(withinDateWin(r, "1d", NOW), false);
  assert.equal(withinDateWin(r, "1w", NOW), true);
  assert.equal(withinDateWin(r, "max", NOW), true);
});

test("availableDateWins offers a window only when it's non-empty AND non-redundant", () => {
  // a run within 1d and runs older than 1d → only 1d qualifies (plus max)
  const recent = [run(0), run(1.5 * DATE_WINDOWS["1d"])];
  assert.deepEqual(availableDateWins(recent, NOW), ["1d", "max"]);

  // a run within 1d and one ~40 days old → all windows qualify
  const spread = [run(0), run(40 * DATE_WINDOWS["1d"])];
  assert.deepEqual(availableDateWins(spread, NOW), ["1d", "1w", "1m", "max"]);

  // all runs under a day → no window excludes anything → only max
  assert.deepEqual(availableDateWins([run(0)], NOW), ["max"]);
});

test("availableDateWins hides a window with no runs within it", () => {
  // every run is 1.5–3.5 days old: nothing falls within 1d, so 1d is hidden;
  // 1w/1m are redundant (no run older) → only max (the reported bug).
  const aged = [run(1.5 * DATE_WINDOWS["1d"]), run(3.5 * DATE_WINDOWS["1d"])];
  assert.deepEqual(availableDateWins(aged, NOW), ["max"]);
});

// startOfToday computed the same way the function does → timezone-independent
const DAY = 86_400_000;
const startOfToday = (() => {
  const d = new Date(NOW);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
})();
const at = (id: string, firstTs: number): RunMeta => ({ ...run(0), runId: id, firstTs, lastTs: firstTs + 1000 });

test("groupRunsByTime buckets by calendar recency in fixed order", () => {
  const runs = [
    at("today", startOfToday + 3 * 3600_000),
    at("yest", startOfToday - DAY + 3 * 3600_000),
    at("d5", startOfToday - 5 * DAY),
    at("d20", startOfToday - 20 * DAY),
    at("d100", startOfToday - 100 * DAY),
  ];
  const g = groupRunsByTime(runs, NOW);
  assert.deepEqual(g.map((x) => x.key), ["today", "yesterday", "7d", "30d", "older"]);
  assert.deepEqual(g.map((x) => x.runs.length), [1, 1, 1, 1, 1]);
});

test("groupRunsByTime preserves input order within a bucket and drops empty ones", () => {
  const runs = [at("t1", startOfToday + 5 * 3600_000), at("t2", startOfToday + 2 * 3600_000)];
  const g = groupRunsByTime(runs, NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0].key, "today");
  assert.deepEqual(g[0].runs.map((r) => r.runId), ["t1", "t2"]);
});

test("isNoopRun folds no-action finished runs (even auto-pass) but keeps live/acted/failed", () => {
  const old = 2 * DATE_WINDOWS["1d"]; // finished (not live)
  const noop = { ...run(old), toolCalls: 0, errors: 0, lastTs: NOW - old, firstTs: NOW - old - 5000 } as RunMeta;
  assert.equal(isNoopRun(noop, NOW), true);
  // auto-"pass" with no tools is still a no-op (verdict alone isn't signal)
  assert.equal(isNoopRun({ ...noop, verdict: { status: "pass" } } as RunMeta, NOW), true);
  // a live run is never a no-op
  assert.equal(isNoopRun({ ...noop, lastTs: NOW, firstTs: NOW - 5000 } as RunMeta, NOW), false);
  // acted, failed, paused, or errored → kept
  assert.equal(isNoopRun({ ...noop, toolCalls: 3 } as RunMeta, NOW), false);
  assert.equal(isNoopRun({ ...noop, verdict: { status: "fail" } } as RunMeta, NOW), false);
  assert.equal(isNoopRun({ ...noop, verdict: { status: "paused" } } as RunMeta, NOW), false);
  assert.equal(isNoopRun({ ...noop, errors: 1 } as RunMeta, NOW), false);
});

test("matchesRunSearch matches title/request/project/runId/agent, empty = all", () => {
  const r = { ...run(0), runId: "run-abc", request: "Add dark mode", cwd: "/proj/web", agents: ["scout"] } as RunMeta;
  assert.equal(matchesRunSearch(r, ""), true);
  assert.equal(matchesRunSearch(r, "dark"), true); // request → title
  assert.equal(matchesRunSearch(r, "web"), true); // project
  assert.equal(matchesRunSearch(r, "abc"), true); // runId
  assert.equal(matchesRunSearch(r, "scout"), true); // agent
  assert.equal(matchesRunSearch(r, "nope"), false);
});
