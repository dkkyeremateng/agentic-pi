import { test } from "node:test";
import assert from "node:assert/strict";
import { seedHighWater, isReplay } from "./live.ts";
import type { ObsEvent } from "./types.ts";

function ev(sessionId: string, seq: number): ObsEvent {
  return { v: 2, seq, ts: 1000 + seq, sessionId, agent: "implementer", type: "message", payload: {} };
}

test("high-water marks track the newest seq per session", () => {
  const hw = seedHighWater([ev("a", 0), ev("a", 5), ev("b", 2), ev("a", 3), ev("b", 9)]);
  assert.equal(hw.get("a"), 5); // not 3 — out-of-order arrivals never lower the mark
  assert.equal(hw.get("b"), 9);
  assert.equal(hw.size, 2);
  assert.deepEqual(seedHighWater([]), new Map());
});

test("a replayed event is recognised anywhere in the history, not just near the tail", () => {
  // regression: the old merge scanned only the last 512 cached events, so on a
  // longer run the server's ring-buffer replay re-appended everything older —
  // a 7,944-event run ended up caching 9,041.
  const history = Array.from({ length: 2000 }, (_, i) => ev("a", i));
  const hw = seedHighWater(history);
  assert.equal(isReplay(hw, ev("a", 0)), true); // oldest — far outside any tail window
  assert.equal(isReplay(hw, ev("a", 900)), true); // mid-history
  assert.equal(isReplay(hw, ev("a", 1999)), true); // the tail itself
});

test("genuinely new events pass through", () => {
  const hw = seedHighWater([ev("a", 7)]);
  assert.equal(isReplay(hw, ev("a", 8)), false); // next seq for a known session
  assert.equal(isReplay(hw, ev("b", 0)), false); // a session we've never seen
});

test("sessions are deduped independently — one session's seq can't mask another's", () => {
  const hw = seedHighWater([ev("a", 100), ev("b", 1)]);
  assert.equal(isReplay(hw, ev("b", 2)), false); // b:2 is new even though a is at 100
  assert.equal(isReplay(hw, ev("b", 1)), true);
});
