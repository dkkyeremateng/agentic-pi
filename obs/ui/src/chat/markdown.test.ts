import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.ts";

test("headings render at the right level", () => {
  assert.match(renderMarkdown("# TCP Congestion Control"), /<h1 class="md-h md-h1">TCP Congestion Control<\/h1>/);
  assert.match(renderMarkdown("### Sub"), /<h3 [^>]*>Sub<\/h3>/);
});

test("bold, italic, and inline code", () => {
  assert.match(renderMarkdown("a **congestion window** (`cwnd`)"), /<strong>congestion window<\/strong> \(<code class="md-code">cwnd<\/code>\)/);
  assert.match(renderMarkdown("grows *linear* now"), /<em>linear<\/em>/);
});

test("ordered list groups consecutive items", () => {
  const html = renderMarkdown("1. **Slow Start** — small\n2. Congestion Avoidance");
  assert.match(html, /<ol><li><strong>Slow Start<\/strong> — small<\/li><li>Congestion Avoidance<\/li><\/ol>/);
});

test("unordered list", () => {
  assert.match(renderMarkdown("- one\n- two"), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("fenced code block is preserved verbatim and escaped, not reformatted", () => {
  const html = renderMarkdown("```js\nif (a < b) **x**\n```");
  assert.match(html, /<pre class="md-pre"><code>if \(a &lt; b\) \*\*x\*\*<\/code><\/pre>/);
});

test("HTML is escaped (XSS-safe)", () => {
  const html = renderMarkdown("hi <img src=x onerror=alert(1)> there");
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
});

test("only safe link schemes become anchors", () => {
  assert.match(renderMarkdown("[ok](https://x.com)"), /<a href="https:\/\/x\.com" target="_blank"[^>]*>ok<\/a>/);
  // javascript: is left as literal text, not an anchor
  const bad = renderMarkdown("[no](javascript:alert(1))");
  assert.ok(!bad.includes("<a "));
});

test("GFM pipe tables render as a table", () => {
  const html = renderMarkdown("| Name | Cost |\n| --- | --- |\n| scout | $0.04 |\n| impl | $0.12 |");
  assert.match(html, /<table class="md-table"><thead><tr><th>Name<\/th><th>Cost<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>scout<\/td><td>\$0\.04<\/td><\/tr><tr><td>impl<\/td><td>\$0\.12<\/td><\/tr><\/tbody>/);
});

test("task lists render checkboxes (checked/unchecked)", () => {
  const html = renderMarkdown("- [x] done item\n- [ ] todo item");
  assert.match(html, /<li class="md-task"><span class="md-check on">✓<\/span>done item<\/li>/);
  assert.match(html, /<li class="md-task"><span class="md-check">[^<]*<\/span>todo item<\/li>/);
});

test("a pipe in a normal paragraph is not a table", () => {
  const html = renderMarkdown("use a | b in the shell");
  assert.match(html, /<p>use a \| b in the shell<\/p>/);
});

test("paragraphs split on blank lines; soft breaks become <br>", () => {
  const html = renderMarkdown("line one\nline two\n\nsecond para");
  assert.match(html, /<p>line one<br>line two<\/p>/);
  assert.match(html, /<p>second para<\/p>/);
});

test("emphasis after a link never rewrites the generated anchor HTML", () => {
  const html = renderMarkdown("[a](/x) some_snake_case");
  assert.match(html, /<a href="\/x" target="_blank" rel="noopener noreferrer">a<\/a>/);
  assert.ok(!html.includes("<em>"));
  assert.ok(html.includes("some_snake_case"));
});

test("scheme-relative //host urls are not linkified; plain paths still are", () => {
  const bad = renderMarkdown("[e](//evil.example)");
  assert.ok(!bad.includes("<a "));
  assert.match(bad, /\[e\]\(\/\/evil\.example\)/);
  assert.match(renderMarkdown("[p](/path)"), /<a href="\/path"/);
});

test("a bare --- after a pipe line is an HR, not a table separator", () => {
  const html = renderMarkdown("use a | b\n---\nafter");
  assert.ok(!html.includes("<table"));
  assert.match(html, /<p>use a \| b<\/p><hr class="md-hr"><p>after<\/p>/);
});

test("mid-line triple backticks stay literal — no unrestorable block token", () => {
  const html = renderMarkdown("see ```js\ncode()\n``` for details");
  assert.ok(!html.includes("\u0000"));
  assert.ok(!html.includes("md-pre"));
  assert.ok(html.includes("code()"));
});
