import { test } from "node:test";
import assert from "node:assert/strict";
import { laneRollup, laneStalledMs } from "./laneRollup.ts";
import type { ObsEvent } from "../types.ts";

let seq = 0;
function ev(p: Partial<ObsEvent>): ObsEvent {
  return { v: 2, seq: seq++, ts: 0, sessionId: "s", agent: "implementer", type: "message", payload: {}, ...p };
}

test("laneRollup sums turns, tokens, cost, tools and tracks active", () => {
  const r = laneRollup([
    ev({ type: "session_start", ts: 0, payload: { model: "fable-5" } }),
    ev({ type: "tool_start", ts: 1, payload: { tool: "bash" } }),
    ev({ type: "tool_end", ts: 2, payload: { isError: true } }),
    ev({ type: "turn_end", ts: 3, payload: { tokens: { total: 1200 }, costUsd: 0.05, contextPct: 61 } }),
  ]);
  assert.equal(r.model, "fable-5");
  assert.equal(r.turns, 1);
  assert.equal(r.tokens, 1200);
  assert.equal(r.costUsd, 0.05);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.toolErrors, 1);
  assert.equal(r.ctxPct, 61);
  assert.equal(r.active, true);
  assert.equal(r.ended, false);
});

test("laneRollup marks ended on session_end", () => {
  const r = laneRollup([ev({ type: "session_start", ts: 0 }), ev({ type: "session_end", ts: 5 })]);
  assert.equal(r.active, false);
  assert.equal(r.ended, true);
});

test("laneStalledMs flags only active idle lanes past the threshold", () => {
  const active = laneRollup([ev({ type: "tool_start", ts: 0 })]);
  assert.ok(laneStalledMs(active, 200_000) > 0);
  assert.equal(laneStalledMs(active, 10_000), 0); // not idle long enough
  const ended = laneRollup([ev({ type: "session_start", ts: 0 }), ev({ type: "session_end", ts: 1 })]);
  assert.equal(laneStalledMs(ended, 999_999), 0); // ended lanes never stall
});

test("a truncated tail (session_start scrolled out of the 60-event window) still reports active", () => {
  // lanes cap their buffered tail, so on turn-heavy sessions the session_start
  // is truncated away — turn/message activity alone must keep the lane live.
  const tail: ObsEvent[] = [];
  for (let i = 0; i < 30; i++) {
    tail.push(ev({ type: "turn_start", ts: 1000 + i * 2, payload: { turnIndex: i } }));
    tail.push(ev({ type: "message", ts: 1001 + i * 2 }));
  }
  const r = laneRollup(tail);
  assert.equal(r.active, true);
  assert.equal(r.ended, false);
});

test("session_end closing a truncated tail still marks the lane ended, not active", () => {
  const r = laneRollup([
    ev({ type: "message", ts: 1 }),
    ev({ type: "turn_end", ts: 2, payload: { tokens: { total: 100 }, costUsd: 0.01 } }),
    ev({ type: "session_end", ts: 3 }),
  ]);
  assert.equal(r.ended, true);
  assert.equal(r.active, false);
});

test("stall detection covers truncated-tail active lanes, with a strict 90s threshold", () => {
  // an open tool and no session_start — exactly the tail shape the cap produces
  const r = laneRollup([
    ev({ type: "turn_start", ts: 100_000 }),
    ev({ type: "tool_start", ts: 105_000, payload: { toolName: "bash" } }),
  ]);
  assert.equal(r.active, true);
  assert.equal(laneStalledMs(r, 105_000 + 90_000), 0); // exactly at the threshold — not stalled yet
  assert.equal(laneStalledMs(r, 105_000 + 90_001), 90_001); // past it — returns the idle duration, not a flag
});

test("an empty tail is neither active nor ended", () => {
  const r = laneRollup([]);
  assert.equal(r.active, false);
  assert.equal(r.ended, false);
  assert.equal(r.events, 0);
});
