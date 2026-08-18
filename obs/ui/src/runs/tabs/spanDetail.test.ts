import { test } from "node:test";
import assert from "node:assert/strict";
import { spanDetail, turnOutcomes } from "./spanDetail.ts";
import { buildTrace } from "../../data/derive/trace.ts";
import type { ObsEvent } from "../../data/types.ts";

let seq = 0;
function ev(p: Partial<ObsEvent>): ObsEvent {
  return { v: 2, seq: seq++, ts: 0, sessionId: "orch", agent: "orchestrator", runId: "r1", type: "message", payload: {}, ...p };
}

const events: ObsEvent[] = [
  ev({ sessionId: "orch", agent: "orchestrator", type: "session_start", ts: 0, payload: { model: "fable-5" } }),
  ev({ sessionId: "orch", agent: "orchestrator", type: "dispatch_start", ts: 5, payload: { agent: "implementer", task: "fix the validator" } }),
  ev({ sessionId: "impl", agent: "implementer", parent: "orchestrator", type: "session_start", ts: 10, payload: { model: "fable-5" } }),
  ev({ sessionId: "impl", agent: "implementer", parent: "orchestrator", type: "tool_start", ts: 12, payload: { toolCallId: "t1", tool: "bash", command: "npm test" } }),
  ev({ sessionId: "impl", agent: "implementer", parent: "orchestrator", type: "tool_end", ts: 18, payload: { toolCallId: "t1", isError: true, summary: "exit 1" } }),
  ev({ sessionId: "impl", agent: "implementer", parent: "orchestrator", type: "turn_end", ts: 20, payload: { turnIndex: 0, tokens: { total: 19500 }, costUsd: 0.44, contextPct: 61, stopReason: "end_turn" } }),
];

test("agent span detail derives dispatch-task input + turn output + chips", () => {
  const m = buildTrace(events, "r1", 30);
  const impl = m.spans.find((sp) => sp.kind === "agent" && sp.agent === "implementer")!;
  const d = spanDetail(impl, events);
  assert.equal(d.input?.role, "dispatch task");
  assert.equal(d.input?.text, "fix the validator");
  assert.ok(d.output?.role.startsWith("turn 0"));
  const tokens = d.chips.find((c) => c.k === "tokens");
  assert.equal(tokens?.v, "19.5k");
  const cost = d.chips.find((c) => c.k === "cost");
  assert.equal(cost?.v, "$0.4400");
  assert.equal(d.chips.find((c) => c.k === "ctx")?.v, "61%");
  // metadata + raw sub-tabs (v4 transplant)
  assert.equal(d.meta.find((m) => m.k === "parent")?.v, "orchestrator");
  assert.equal(d.meta.find((m) => m.k === "model")?.v, "fable-5");
  assert.ok(d.raw.length >= 1);
});

test("turnOutcomes marks a turn failed on tool error, error event, or abnormal stop", () => {
  let s = 0;
  const e = (p: Partial<ObsEvent>): ObsEvent => ({
    v: 2, seq: s++, ts: 0, sessionId: "impl", agent: "implementer", runId: "r1", type: "message", payload: {}, ...p,
  });
  const sess: ObsEvent[] = [
    // turn 0 — clean: a successful tool, normal stop → pass
    e({ type: "tool_start", ts: 1, payload: { toolCallId: "a" } }),
    e({ type: "tool_end", ts: 2, payload: { toolCallId: "a", isError: false } }),
    e({ type: "turn_end", ts: 3, payload: { turnIndex: 0, stopReason: "end_turn" } }),
    // turn 1 — a failing tool inside the window → fail
    e({ type: "tool_start", ts: 4, payload: { toolCallId: "b" } }),
    e({ type: "tool_end", ts: 5, payload: { toolCallId: "b", isError: true } }),
    e({ type: "turn_end", ts: 6, payload: { turnIndex: 1, stopReason: "end_turn" } }),
    // turn 2 — clean tools but abnormal stop reason → fail
    e({ type: "turn_end", ts: 7, payload: { turnIndex: 2, stopReason: "max_tokens" } }),
    // turn 3 — a bare error event in the window → fail
    e({ type: "error", ts: 8, payload: { message: "boom" } }),
    e({ type: "turn_end", ts: 9, payload: { turnIndex: 3, stopReason: "end_turn" } }),
  ];
  assert.deepEqual(turnOutcomes(sess), { passed: 1, failed: 3 });
  // order-independent: shuffle and re-check
  assert.deepEqual(turnOutcomes([...sess].reverse()), { passed: 1, failed: 3 });
});

test("agent span stats expose passed/failed turns + retry rate for the strip", () => {
  const m = buildTrace(events, "r1", 30);
  const impl = m.spans.find((sp) => sp.kind === "agent" && sp.agent === "implementer")!;
  const d = spanDetail(impl, events);
  // the implementer's only turn wraps a failing bash → 0 pass / 1 fail
  assert.ok(d.stats, "agent span carries a stats block");
  assert.equal(d.stats!.turnsTotal, 1);
  assert.equal(d.stats!.turnsPassed, 0);
  assert.equal(d.stats!.turnsFailed, 1);
  assert.equal(d.stats!.retryRate, 0); // no dispatch_retry events in the fixture
  // the agent's only turn IS the run's median turn → 0% delta
  assert.equal(d.stats!.costDeltaPct, 0);
});

test("tool span detail shows command input + error output", () => {
  const m = buildTrace(events, "r1", 30);
  const tool = m.spans.find((sp) => sp.kind === "tool")!;
  const d = spanDetail(tool, events);
  assert.equal(d.input?.text, "npm test");
  assert.equal(d.output?.role, "error");
  assert.equal(d.output?.text, "exit 1");
  assert.equal(d.chips.find((c) => c.k === "status")?.warn, true);
});
