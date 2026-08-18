import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useObs } from "./store.ts";
import type { ChatMessage, ChatSession, ObsEvent } from "./types.ts";

function chat(id: string, createdTs: number, messages: ChatMessage[] = [], title = id): ChatSession {
  return { id, title, model: "", toolsEnabled: false, createdTs, messages };
}
function msg(ts: number, text = "m"): ChatMessage {
  return { id: `m${ts}`, role: "user", text, ts };
}
let seq = 0;
function ev(p: Partial<ObsEvent>): ObsEvent {
  return { v: 2, seq: seq++, ts: 1000, sessionId: "s1", agent: "implementer", type: "message", payload: {}, ...p };
}

beforeEach(() => {
  useObs.setState({ chats: [], selectedChatId: null, lanes: new Map(), eventCount: 0 });
});

// ── hydrateChats: merge, don't replace ──

test("hydrateChats unions server and local chats — a stale server copy can't wipe a local-only chat", () => {
  useObs.setState({ chats: [chat("local-only", 2000, [msg(2500)])] });
  useObs.getState().hydrateChats([chat("server-only", 1000, [msg(1500)])]);
  // union, sorted newest-activity first
  assert.deepEqual(useObs.getState().chats.map((c) => c.id), ["local-only", "server-only"]);
});

test("hydrateChats keeps the copy with the newer message on id collision", () => {
  useObs.setState({ chats: [chat("x", 1000, [msg(5000, "local edit")], "local")] });
  useObs.getState().hydrateChats([chat("x", 1000, [msg(2000, "old")], "server")]);
  const x = useObs.getState().chats.find((c) => c.id === "x");
  assert.equal(x?.title, "local");
  // the fresher local messages survive — this is the data-loss regression
  assert.deepEqual(x?.messages.map((m) => m.text), ["local edit"]);
});

test("hydrateChats prefers the server copy when local is older, and on an exact tie", () => {
  useObs.setState({ chats: [chat("x", 1000, [msg(2000)], "local")] });
  useObs.getState().hydrateChats([chat("x", 1000, [msg(5000)], "server")]);
  assert.equal(useObs.getState().chats.find((c) => c.id === "x")?.title, "server");

  useObs.setState({ chats: [chat("y", 1000, [msg(3000)], "local")] });
  useObs.getState().hydrateChats([chat("y", 1000, [msg(3000)], "server")]);
  assert.equal(useObs.getState().chats.find((c) => c.id === "y")?.title, "server");
});

test("hydrateChats resolves message-less chats by creation time", () => {
  useObs.setState({ chats: [chat("z", 9000, [], "local")] });
  useObs.getState().hydrateChats([chat("z", 4000, [], "server")]);
  assert.equal(useObs.getState().chats.find((c) => c.id === "z")?.title, "local");
});

test("hydrateChats keeps a still-valid chat selection and drops a dangling one", () => {
  useObs.setState({ chats: [chat("a", 1000)], selectedChatId: "a" });
  useObs.getState().hydrateChats([]);
  assert.equal(useObs.getState().selectedChatId, "a");
  useObs.setState({ selectedChatId: "ghost" });
  useObs.getState().hydrateChats([]);
  assert.equal(useObs.getState().selectedChatId, null);
});

// ── ingestMany: live-wall lane buffering ──

test("ingestMany counts every non-verdict event and keys lanes by session", () => {
  useObs.getState().ingestMany([
    ev({ sessionId: "s1", ts: 1 }),
    ev({ sessionId: "s1", ts: 2, type: "tool_start", payload: { toolName: "bash" } }),
    ev({ sessionId: "s2", ts: 3 }),
    ev({ sessionId: "user", ts: 4, type: "verdict", payload: { status: "pass" } }),
  ]);
  const st = useObs.getState();
  assert.equal(st.eventCount, 3); // the verdict is excluded from the count
  assert.deepEqual([...st.lanes.keys()].sort(), ["s1", "s2"]); // and spawns no "user" lane
  assert.equal(st.lanes.get("s1")?.events.length, 2);
  assert.equal(st.lanes.get("s1")?.lastTs, 2);
  // counts accumulate across batches
  useObs.getState().ingestMany([ev({ sessionId: "s2", ts: 5 })]);
  assert.equal(useObs.getState().eventCount, 4);
});

test("ingestMany caps a lane's buffered tail at 60, keeping the newest events", () => {
  const batch = Array.from({ length: 70 }, (_, i) => ev({ sessionId: "long", ts: i, seq: i }));
  useObs.getState().ingestMany(batch);
  const lane = useObs.getState().lanes.get("long");
  assert.equal(lane?.events.length, 60);
  assert.equal(lane?.events[0]?.ts, 10); // oldest 10 truncated away
  assert.equal(lane?.events[59]?.ts, 69);
  assert.equal(useObs.getState().eventCount, 70); // the count tracks ingested totals, not the capped tail
});

test("an all-verdict batch is a strict no-op — same state reference, no lane clone", () => {
  useObs.getState().ingestMany([ev({ sessionId: "s1", ts: 1 })]);
  const before = useObs.getState();
  before.ingestMany([
    ev({ sessionId: "user", type: "verdict", payload: { status: "pass" } }),
    ev({ sessionId: "user", type: "verdict", payload: { status: "fail" } }),
  ]);
  const after = useObs.getState();
  assert.equal(after, before); // no state churn → no spurious re-render
  assert.equal(after.lanes, before.lanes);
  assert.equal(after.eventCount, 1);
});
