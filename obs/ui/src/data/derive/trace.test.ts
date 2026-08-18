import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrace, spanBar } from "./trace.ts";
import type { ObsEvent } from "../types.ts";

let seq = 0;
function ev(p: Partial<ObsEvent>): ObsEvent {
  return {
    v: 2,
    seq: seq++,
    ts: 0,
    sessionId: "orch",
    agent: "orchestrator",
    runId: "run1",
    type: "message",
    payload: {},
    ...p,
  };
}

test("buildTrace nests sub-agents and interleaves tool/llm spans", () => {
  const NOW = 10_000;
  const events: ObsEvent[] = [
    ev({ sessionId: "orch", agent: "orchestrator", type: "session_start", ts: 0 }),
    ev({ sessionId: "orch", agent: "orchestrator", type: "turn_end", ts: 1000, payload: { turnIndex: 0, model: "fable-5" } }),
    ev({ sessionId: "scout", agent: "scout", parent: "orchestrator", type: "session_start", ts: 1500 }),
    ev({ sessionId: "scout", agent: "scout", parent: "orchestrator", type: "tool_start", ts: 1600, payload: { toolCallId: "t1", tool: "grep" } }),
    ev({ sessionId: "scout", agent: "scout", parent: "orchestrator", type: "tool_end", ts: 1800, payload: { toolCallId: "t1" } }),
    ev({ sessionId: "scout", agent: "scout", parent: "orchestrator", type: "session_end", ts: 1900 }),
    ev({ sessionId: "orch", agent: "orchestrator", type: "session_end", ts: 2000 }),
  ];
  const m = buildTrace(events, "run1", NOW);
  const kinds = m.spans.map((s) => `${s.depth}:${s.kind}:${s.label}`);
  // orchestrator(0) → its llm turn(1), then scout agent(1) → grep tool(2)
  assert.equal(kinds[0], "0:agent:orchestrator");
  assert.equal(kinds[1], "1:llm:fable-5 · turn 0");
  assert.equal(kinds[2], "1:agent:scout");
  assert.equal(kinds[3], "2:tool:grep");
  assert.equal(m.runStart, 0);
  assert.equal(m.runEnd, 2000);
});

test("buildTrace marks tool errors and ignores verdict events", () => {
  const events: ObsEvent[] = [
    ev({ sessionId: "a", agent: "a", type: "tool_start", ts: 0, payload: { toolCallId: "x", tool: "bash" } }),
    ev({ sessionId: "a", agent: "a", type: "tool_end", ts: 500, payload: { toolCallId: "x", isError: true } }),
    ev({ sessionId: "v", agent: "a", type: "verdict", ts: 600, payload: { status: "fail" } }),
  ];
  const m = buildTrace(events, "run1", 1000);
  const tool = m.spans.find((s) => s.kind === "tool");
  assert.equal(tool?.status, "error");
  const agent = m.spans.find((s) => s.kind === "agent");
  assert.equal(agent?.status, "error"); // tool error bubbles to the agent
  // verdict made no span
  assert.equal(m.spans.filter((s) => s.id === "v").length, 0);
});

test("a finished sub-agent without session_end is done once the run moves past it", () => {
  const NOW = 2000; // recent: within the 60s window, so the old heuristic said "running"
  const events: ObsEvent[] = [
    ev({ sessionId: "orch", agent: "orchestrator", type: "session_start", ts: 0 }),
    ev({ sessionId: "scout", agent: "scout", parent: "orchestrator", type: "session_start", ts: 100 }),
    ev({ sessionId: "scout", agent: "scout", parent: "orchestrator", type: "turn_end", ts: 200, payload: { turnIndex: 0 } }),
    // scout never emits session_end, but the orchestrator keeps going after it…
    ev({ sessionId: "orch", agent: "orchestrator", type: "turn_end", ts: 900, payload: { turnIndex: 0 } }),
  ];
  const m = buildTrace(events, "run1", NOW);
  const scout = m.spans.find((s) => s.agent === "scout")!;
  const orch = m.spans.find((s) => s.agent === "orchestrator")!;
  assert.equal(scout.status, "done"); // run moved past scout ⇒ done, not "running"
  assert.equal(orch.status, "running"); // the trailing, still-active agent stays running
});

test("a turn_end never pairs with another session's open turn (s1 vs s12)", () => {
  const events: ObsEvent[] = [
    ev({ sessionId: "s12", agent: "b", type: "turn_start", ts: 0 }),
    // s1 has no open turn; a bare-sessionId prefix match would steal s12's
    ev({ sessionId: "s1", agent: "a", type: "turn_end", ts: 100, payload: { model: "m" } }),
    ev({ sessionId: "s12", agent: "b", type: "turn_end", ts: 200 }),
  ];
  const m = buildTrace(events, "run1", 1000);
  const llmA = m.spans.find((s) => s.kind === "llm" && s.agent === "a")!;
  const llmB = m.spans.find((s) => s.kind === "llm" && s.agent === "b")!;
  assert.equal(llmA.startTs, 100); // fell back to its own ts, not s12's start
  assert.equal(llmB.startTs, 0); // s12's turn kept its real start
  assert.equal(llmB.endTs, 200);
});

test("tool spans pair without a toolCallId (both halves key the same way)", () => {
  const events: ObsEvent[] = [
    ev({ sessionId: "a", agent: "a", type: "session_start", ts: 1000 }),
    // no toolCallId anywhere — a mismatched fallback default on one side would
    // leave this unpairable and collapse the span to zero duration
    ev({ sessionId: "a", agent: "a", type: "tool_start", ts: 2000, payload: { tool: "bash" } }),
    ev({ sessionId: "a", agent: "a", type: "tool_end", ts: 5000, payload: { tool: "bash" } }),
  ];
  const m = buildTrace(events, "run1", 9999);
  const tool = m.spans.find((s) => s.kind === "tool")!;
  assert.equal(tool.label, "bash");
  assert.equal(tool.startTs, 2000);
  assert.equal(tool.endTs, 5000);
});

test("id-less tool spans pair per tool name, and never across sessions", () => {
  const events: ObsEvent[] = [
    // two DIFFERENT tools in flight at once, neither carrying a toolCallId
    ev({ sessionId: "a", agent: "a", type: "tool_start", ts: 100, payload: { tool: "grep" } }),
    ev({ sessionId: "a", agent: "a", type: "tool_start", ts: 200, payload: { tool: "bash" } }),
    ev({ sessionId: "a", agent: "a", type: "tool_end", ts: 300, payload: { tool: "grep" } }),
    ev({ sessionId: "a", agent: "a", type: "tool_end", ts: 400, payload: { tool: "bash" } }),
    // a different session's end must not steal session a's open tools
    ev({ sessionId: "b", agent: "b", type: "tool_end", ts: 500, payload: { tool: "grep" } }),
  ];
  const m = buildTrace(events, "run1", 9999);
  const byAgent = (agent: string) => m.spans.filter((s) => s.kind === "tool" && s.agent === agent);
  const [grep, bash] = byAgent("a").sort((x, y) => x.startTs - y.startTs);
  assert.deepEqual([grep.label, grep.startTs, grep.endTs], ["grep", 100, 300]);
  assert.deepEqual([bash.label, bash.startTs, bash.endTs], ["bash", 200, 400]);
  // b's orphan end got no start to steal — it degrades to a point span of its own
  assert.deepEqual(byAgent("b").map((s) => [s.startTs, s.endTs]), [[500, 500]]);
});

test("spanBar clamps to the run window", () => {
  const events: ObsEvent[] = [
    ev({ sessionId: "a", agent: "a", type: "session_start", ts: 0 }),
    ev({ sessionId: "a", agent: "a", type: "session_end", ts: 1000 }),
  ];
  const m = buildTrace(events, "run1", 2000);
  const b = spanBar(m.spans[0], m);
  assert.equal(b.left, 0);
  assert.ok(b.width > 0 && b.width <= 1);
});
