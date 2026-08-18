import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightJson, markTerm } from "./rawHighlight.ts";

test("highlightJson colours keys, strings, numbers, booleans, and null", () => {
  const html = highlightJson({ seq: 184, ok: false, tool: "bash", parent: null });
  assert.match(html, /<span class="j-key">"seq"<\/span>: <span class="j-num">184<\/span>/);
  assert.match(html, /<span class="j-key">"ok"<\/span>: <span class="j-bool">false<\/span>/);
  assert.match(html, /<span class="j-str">"bash"<\/span>/);
  assert.match(html, /<span class="j-null">null<\/span>/);
});

test("highlightJson escapes HTML and leaves string contents untokenised", () => {
  const html = highlightJson({ msg: "1 < 2 & ok", ts: "2026-06-13T14:02:11.204Z" });
  assert.match(html, /1 &lt; 2 &amp; ok/);
  // digits inside the timestamp string must not become number spans
  assert.match(html, /<span class="j-str">"2026-06-13T14:02:11\.204Z"<\/span>/);
});

test("highlightJson pretty-prints (multi-line, indented)", () => {
  const html = highlightJson({ a: 1, b: 2 });
  assert.ok(html.includes("\n  "), "expected 2-space indentation");
});

test("markTerm highlights matches in text but never inside tags", () => {
  const html = highlightJson({ tool: "bash", note: "span of work" });
  // "span" appears in the value text — gets marked
  const marked = markTerm(html, "span");
  assert.match(marked, /<mark>span<\/mark> of work/);
  // ...but the <span> tags the highlighter emits are untouched
  assert.ok(!/<mark>span<\/mark> class/.test(marked), "must not mark tag names");
  assert.match(marked, /<span class="j-key">/);
});

test("markTerm is case-insensitive and a no-op for an empty term", () => {
  const html = highlightJson({ tool: "Bash" });
  assert.match(markTerm(html, "bash"), /<mark>Bash<\/mark>/);
  assert.equal(markTerm(html, "   "), html);
});
