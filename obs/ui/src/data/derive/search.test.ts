import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, filterHits, facetBy, serverQuery } from "./search.ts";
import type { ObsEvent } from "../types.ts";

let seq = 0;
function ev(p: Partial<ObsEvent>): ObsEvent {
  return { v: 2, seq: seq++, ts: 0, sessionId: "s", agent: "implementer", type: "tool_end", payload: {}, ...p };
}

test("parseQuery splits prefixes from free text", () => {
  const p = parseQuery("tool:bash status:error npm test");
  assert.equal(p.tool, "bash");
  assert.equal(p.status, "error");
  assert.equal(p.text, "npm test");
});

test("parseQuery ignores unknown prefixes as free text", () => {
  const p = parseQuery("foo:bar baz");
  assert.equal(p.text, "foo:bar baz");
});

test("parseQuery drops a known prefix with an empty value (bare hint chip)", () => {
  const p = parseQuery("tool: npm test");
  assert.equal(p.tool, undefined);
  assert.equal(p.text, "npm test");
  assert.equal(parseQuery("status:").text, "");
});

test("parseQuery exposes the individual free-text terms (lowercased)", () => {
  assert.deepEqual(parseQuery("JQ Error tool:bash").terms, ["jq", "error"]);
  assert.deepEqual(parseQuery("tool:bash").terms, []); // prefix-only
});

test("serverQuery picks the most-selective (longest) term, or '' when prefix-only", () => {
  assert.equal(serverQuery(parseQuery("jq error")), "error"); // longer of the two
  assert.equal(serverQuery(parseQuery("bash")), "bash");
  assert.equal(serverQuery(parseQuery("tool:bash status:error")), ""); // no free text
});

test("filterHits ANDs every free-text term against the whole event", () => {
  const events = [
    ev({ agent: "orch", type: "message", payload: { text: "jq error while parsing" } }),
    ev({ agent: "orch", type: "message", payload: { text: "jq ran cleanly" } }), // has 'jq', not 'error'
    ev({ agent: "orch", type: "error", payload: { message: "network error" } }), // has 'error', not 'jq'
  ];
  // "jq error" isn't contiguous anywhere, but both words appear in the first event
  assert.equal(filterHits(events, parseQuery("jq error")).length, 1);
  assert.equal(filterHits(events, parseQuery("jq error"))[0].payload.text, "jq error while parsing");
  // a term can match a field OTHER than the one the server keyed on — 'orch' is
  // the agent, matched via the full-event haystack
  assert.equal(filterHits(events, parseQuery("orch error")).length, 2);
});

test("filterHits combines free-text terms with prefix filters", () => {
  const events = [
    ev({ agent: "orch", type: "tool_end", payload: { toolName: "bash", text: "deploy failed" } }),
    ev({ agent: "orch", type: "tool_end", payload: { toolName: "grep", text: "deploy failed" } }),
  ];
  assert.equal(filterHits(events, parseQuery("tool:bash deploy")).length, 1);
});

test("filterHits applies tool + status + agent filters", () => {
  const events = [
    ev({ agent: "implementer", payload: { toolName: "bash", isError: true } }),
    ev({ agent: "implementer", payload: { toolName: "bash", isError: false } }),
    ev({ agent: "reviewer", payload: { tool: "grep", isError: true } }), // legacy payload shape (old JSONL)
  ];
  assert.equal(filterHits(events, parseQuery("tool:bash")).length, 2);
  assert.equal(filterHits(events, parseQuery("tool:bash status:error")).length, 1);
  assert.equal(filterHits(events, parseQuery("agent:reviewer")).length, 1);
  assert.equal(filterHits(events, parseQuery("tool:grep")).length, 1); // legacy `tool` key still matches
});

test("facetBy counts and sorts descending", () => {
  const f = facetBy(
    [ev({ agent: "a" }), ev({ agent: "a" }), ev({ agent: "b" })],
    (e) => e.agent,
  );
  assert.deepEqual(f, [
    { key: "a", count: 2 },
    { key: "b", count: 1 },
  ]);
});
