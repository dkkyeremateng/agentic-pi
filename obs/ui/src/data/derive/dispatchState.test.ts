import { test } from "node:test";
import assert from "node:assert/strict";
import { runningDispatches } from "./dispatchState.ts";
import type { Lane } from "../store.ts";
import type { ObsEvent } from "../types.ts";

let seq = 0;
function ev(p: Partial<ObsEvent> & { type: ObsEvent["type"] }): ObsEvent {
  return { v: 1, seq: seq++, ts: seq, sessionId: "orch", agent: "orchestrator", runId: "run-1", payload: {}, ...p } as ObsEvent;
}
const lane = (events: ObsEvent[]): Lane => ({ key: "k", agent: "orchestrator", events, lastTs: 0 });

test("a dispatch_start with no end is reported as in flight", () => {
  seq = 0;
  const lanes = [lane([ev({ type: "dispatch_start", payload: { agent: "seeker", dispatchId: "d1", task: "pull NVDA/AMD figures", attempt: 1 } })])];
  const r = runningDispatches(lanes, "run-1");
  assert.equal(r.length, 1);
  assert.equal(r[0].agent, "seeker");
  assert.equal(r[0].task, "pull NVDA/AMD figures");
});

test("a matched dispatch_end clears the in-flight dispatch", () => {
  seq = 0;
  const lanes = [
    lane([
      ev({ type: "dispatch_start", payload: { agent: "seeker", dispatchId: "d1" } }),
      ev({ type: "dispatch_end", payload: { agent: "seeker", dispatchId: "d1", status: "done" } }),
    ]),
  ];
  assert.deepEqual(runningDispatches(lanes, "run-1"), []);
});

test("a retry keeps it in flight and bumps the attempt", () => {
  seq = 0;
  const lanes = [
    lane([
      ev({ type: "dispatch_start", payload: { agent: "seeker", dispatchId: "d1", attempt: 1 } }),
      ev({ type: "dispatch_retry", payload: { agent: "seeker", dispatchId: "d1", attempt: 2, reason: "empty" } }),
    ]),
  ];
  const r = runningDispatches(lanes, "run-1");
  assert.equal(r.length, 1);
  assert.equal(r[0].attempt, 2);
});

test("dispatches from other runs are ignored", () => {
  seq = 0;
  const lanes = [
    lane([
      ev({ type: "dispatch_start", runId: "run-other", payload: { agent: "scout", dispatchId: "x" } }),
      ev({ type: "dispatch_start", runId: "run-1", payload: { agent: "seeker", dispatchId: "d1" } }),
    ]),
  ];
  const r = runningDispatches(lanes, "run-1");
  assert.deepEqual(r.map((d) => d.agent), ["seeker"]);
});

test("two concurrent dispatches are both reported", () => {
  seq = 0;
  const lanes = [
    lane([
      ev({ type: "dispatch_start", payload: { agent: "seeker", dispatchId: "d1" } }),
      ev({ type: "dispatch_start", payload: { agent: "analyst", dispatchId: "d2" } }),
      ev({ type: "dispatch_end", payload: { agent: "seeker", dispatchId: "d1", status: "done" } }),
    ]),
  ];
  const r = runningDispatches(lanes, "run-1");
  assert.deepEqual(r.map((d) => d.agent), ["analyst"]);
});
