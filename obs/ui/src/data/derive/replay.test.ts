import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplay, totalsAt, stepFrom, buildWarp } from "./replay.ts";
import type { ObsEvent } from "../types.ts";
import type { Span } from "./trace.ts";

function ev(p: Partial<ObsEvent> & { ts: number; type: ObsEvent["type"] }): ObsEvent {
  return { v: 1, seq: 0, sessionId: "s", agent: "orchestrator", payload: {}, ...p } as ObsEvent;
}
function span(p: Partial<Span> & { startTs: number; endTs: number }): Span {
  return { id: "x", kind: "tool", label: "t", agent: "a", depth: 1, status: "done", ...p } as Span;
}

test("buildReplay tallies cost/tokens/tools/errors and emits markers", () => {
  const m = buildReplay(
    [
      ev({ ts: 10, type: "turn_start", payload: { turnIndex: 0 } }),
      ev({ ts: 20, type: "tool_start", payload: { tool: "Read" } }),
      ev({ ts: 30, type: "tool_end", payload: { tool: "Read", isError: true } }),
      ev({ ts: 40, type: "dispatch_start", payload: { agent: "scout" } }),
      ev({ ts: 50, type: "turn_end", payload: { costUsd: 0.5, tokens: { total: 1200 } } }),
    ],
    [],
  );
  assert.deepEqual(m.total, { cost: 0.5, tokens: 1200, tools: 1, errors: 1 });
  // one of each marker kind, in time order
  assert.deepEqual(
    m.markers.map((x) => x.kind),
    ["turn", "error", "dispatch"],
  );
  assert.equal(m.markers[0].label, "turn 0"); // turnIndex 0 must not render as "?"
});

test("totalsAt returns cumulative totals up to the playhead", () => {
  const m = buildReplay(
    [
      ev({ ts: 10, type: "tool_start" }),
      ev({ ts: 20, type: "turn_end", payload: { costUsd: 0.2, tokens: 100 } }), // legacy numeric tokens shape
      ev({ ts: 30, type: "tool_start" }),
    ],
    [],
  );
  assert.deepEqual(totalsAt(m.cum, 5), { cost: 0, tokens: 0, tools: 0, errors: 0 });
  assert.deepEqual(totalsAt(m.cum, 15), { cost: 0, tokens: 0, tools: 1, errors: 0 });
  assert.deepEqual(totalsAt(m.cum, 25), { cost: 0.2, tokens: 100, tools: 1, errors: 0 });
  assert.deepEqual(totalsAt(m.cum, 999), { cost: 0.2, tokens: 100, tools: 2, errors: 0 });
});

test("steps dedupe span boundaries; stepFrom walks them within bounds", () => {
  const m = buildReplay([], [span({ startTs: 100, endTs: 200 }), span({ startTs: 200, endTs: 300, kind: "llm" })]);
  assert.deepEqual(m.steps, [100, 200, 300]);
  assert.equal(stepFrom(m.steps, 100, 1, 0, 1000), 200);
  assert.equal(stepFrom(m.steps, 250, -1, 0, 1000), 200);
  assert.equal(stepFrom(m.steps, 300, 1, 0, 1000), null); // nothing further
  assert.equal(stepFrom(m.steps, 200, 1, 0, 150), null); // clamped by hi
});

test("buildWarp fit maps progress linearly over run-time", () => {
  const w = buildWarp("fit", [], 0, 1000);
  assert.equal(w.at(0), 0);
  assert.equal(w.at(0.5), 500);
  assert.equal(w.at(1), 1000);
  assert.equal(w.inv(250), 0.25);
});

test("buildWarp even gives equal wall-time per boundary, collapsing gaps", () => {
  // a big idle gap 100→900 then dense 900→910→1000; even pacing spends a third
  // of the wall time crossing the gap and two-thirds on the dense tail.
  const w = buildWarp("even", [900, 910], 100, 1000);
  // arr = [100, 900, 910, 1000], 3 equal segments
  assert.equal(w.at(0), 100);
  assert.equal(w.at(1 / 3), 900); // first third covers the whole idle gap
  assert.equal(w.at(2 / 3), 910);
  assert.equal(w.at(1), 1000);
  // inv is the inverse on the boundaries
  assert.ok(Math.abs(w.inv(900) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(w.inv(905) - (1 + 0.5) / 3) < 1e-9);
});
