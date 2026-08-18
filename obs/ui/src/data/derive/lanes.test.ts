import { test } from "node:test";
import assert from "node:assert/strict";
import { laneKey, isRoot, normalizeAgent } from "./lanes.ts";
import type { ObsEvent } from "../types.ts";

function ev(p: Partial<ObsEvent>): ObsEvent {
  return {
    v: 2,
    seq: 0,
    ts: 0,
    sessionId: "s1",
    agent: "orchestrator",
    type: "message",
    payload: {},
    ...p,
  };
}

test("laneKey groups by session", () => {
  assert.equal(laneKey(ev({ sessionId: "s1", seq: 1 })), laneKey(ev({ sessionId: "s1", seq: 2 })));
  assert.notEqual(laneKey(ev({ sessionId: "s1" })), laneKey(ev({ sessionId: "s2" })));
});

test("isRoot is true only without a parent", () => {
  assert.equal(isRoot(ev({ parent: undefined })), true);
  assert.equal(isRoot(ev({ parent: "orchestrator" })), false);
});

test("normalizeAgent falls back for unnamed sessions", () => {
  assert.equal(normalizeAgent(ev({ agent: "scout" })), "scout");
  assert.equal(normalizeAgent(ev({ agent: "", parent: undefined })), "root");
  assert.equal(normalizeAgent(ev({ agent: "", parent: "orchestrator" })), "agent");
});
