import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentInstances,
  scopeOptions,
  resolveScope,
  inScope,
  encodeScope,
  decodeScope,
  shortSession,
} from "./agentScope.ts";
import type { ObsEvent } from "../data/types.ts";

let seq = 0;
function ev(agent: string, sessionId: string, ts = ++seq): ObsEvent {
  return { v: 2, seq: seq++, ts, sessionId, agent, type: "message", payload: {} };
}

test("instances are keyed by session, so one role dispatched N times yields N", () => {
  const rows = agentInstances([
    ev("impl", "s-a", 10),
    ev("impl", "s-b", 20),
    ev("impl", "s-a", 30),
    ev("planner", "s-c", 40),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.agent, r.sessionId, r.count]),
    [
      ["impl", "s-a", 2],
      ["impl", "s-b", 1],
      ["planner", "s-c", 1],
    ],
  );
  // dispatch order, not alphabetical — "#1" must mean the one that ran first
  assert.deepEqual(rows.map((r) => r.firstTs), [10, 20, 40]);
});

test("only a role that actually ran more than once is broken out into instances", () => {
  const opts = scopeOptions(
    agentInstances([ev("impl", "s-a", 10), ev("impl", "s-b", 20), ev("planner", "s-c", 30)]),
  );
  assert.deepEqual(
    opts.map((o) => [o.agent, o.sessionId, o.label]),
    [
      ["impl", "", "impl · all 2"], // the role, covering both
      ["impl", "s-a", "impl #1 · a"], // …and each instance under it
      ["impl", "s-b", "impl #2 · b"],
      ["planner", "", "planner"], // single instance stays one plain line
    ],
  );
});

test("a role's aggregate count sums its instances", () => {
  const opts = scopeOptions(agentInstances([ev("impl", "s-a"), ev("impl", "s-a"), ev("impl", "s-b")]));
  assert.equal(opts[0].count, 3); // impl · all 2
  assert.equal(opts[1].count, 2);
  assert.equal(opts[2].count, 1);
});

test("a pick degrades outward instead of blanking the tab", () => {
  const opts = scopeOptions(agentInstances([ev("impl", "s-a"), ev("impl", "s-b"), ev("planner", "s-c")]));
  assert.equal(resolveScope({ agent: "", sessionId: "" }, opts), null); // all agents
  assert.equal(resolveScope({ agent: "impl", sessionId: "s-b" }, opts)?.sessionId, "s-b"); // exact instance
  // a session this tab can't offer (Stats reads the digest, which has no
  // per-instance split) falls back to the ROLE rather than to nothing
  assert.equal(resolveScope({ agent: "impl", sessionId: "s-zzz" }, opts)?.sessionId, "");
  assert.equal(resolveScope({ agent: "impl", sessionId: "s-zzz" }, opts)?.agent, "impl");
  // a role from another run degrades all the way to "all"
  assert.equal(resolveScope({ agent: "ghost", sessionId: "" }, opts), null);
});

test("inScope matches on the session when one is pinned, else on the role", () => {
  const rows = [ev("impl", "s-a"), ev("impl", "s-b"), ev("planner", "s-c")];
  const opts = scopeOptions(agentInstances(rows));
  const role = opts.find((o) => o.agent === "impl" && !o.sessionId)!;
  const inst = opts.find((o) => o.sessionId === "s-b")!;
  assert.equal(inScope(rows, role).length, 2); // both impl instances
  assert.deepEqual(inScope(rows, inst).map((r) => r.sessionId), ["s-b"]); // just that one
  assert.equal(inScope(rows, null), rows); // same reference — unscoped costs nothing
});

test("inScope works on spans too — they carry the session that owns them", () => {
  const spans = [
    { id: "1", agent: "impl", sessionId: "s-a" },
    { id: "2", agent: "impl", sessionId: "s-b" },
  ];
  const opts = scopeOptions(agentInstances([ev("impl", "s-a"), ev("impl", "s-b")]));
  assert.deepEqual(inScope(spans, opts.find((o) => o.sessionId === "s-b")!), [
    { id: "2", agent: "impl", sessionId: "s-b" },
  ]);
});

test("scope keys round-trip, including agent names containing spaces", () => {
  for (const [agent, session] of [
    ["impl", ""],
    ["impl", "s-a"],
    ["phase implementer", "sess-1"],
  ]) {
    assert.deepEqual(decodeScope(encodeScope(agent, session)), { agent, sessionId: session });
  }
});

test("shortSession keeps the tail that distinguishes two instances", () => {
  assert.equal(shortSession("implementer-mskisf25-rts1s"), "rts1s");
  assert.equal(shortSession("plain"), "plain");
});
