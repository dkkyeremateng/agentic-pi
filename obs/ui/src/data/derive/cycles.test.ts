import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCycles, cycleLabel } from "./cycles.ts";
import type { ObsEvent } from "../types.ts";

let seq = 0;
function ev(p: Partial<ObsEvent>): ObsEvent {
  return { v: 2, seq: seq++, ts: 0, sessionId: "s", agent: "orchestrator", type: "message", payload: {}, ...p };
}

test("groupCycles opens a setup cycle, then one per turn_start", () => {
  const cycles = groupCycles([
    ev({ type: "session_start", ts: 0 }),
    ev({ type: "turn_start", ts: 10, payload: { turnIndex: 0 } }),
    ev({ type: "message", ts: 11 }),
    ev({ type: "turn_end", ts: 20, payload: { turnIndex: 0 } }),
    ev({ type: "turn_start", ts: 30, payload: { turnIndex: 1 } }),
    ev({ type: "tool_start", ts: 31, payload: { tool: "bash" } }),
  ]);
  assert.equal(cycles.length, 3);
  assert.equal(cycleLabel(cycles[0]), "Setup");
  assert.equal(cycles[0].events.length, 1);
  assert.equal(cycleLabel(cycles[1]), "Turn 0");
  assert.equal(cycles[1].events.length, 3); // turn_start, message, turn_end
  assert.equal(cycleLabel(cycles[2]), "Turn 1");
  assert.equal(cycles[2].events.length, 2);
});

test("groupCycles handles a stream with no turns", () => {
  const cycles = groupCycles([ev({ type: "session_start", ts: 0 }), ev({ type: "message", ts: 1 })]);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].events.length, 2);
});
