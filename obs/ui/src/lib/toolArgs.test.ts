import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeToolArgs, summarizeToolResult } from "./toolArgs.ts";

test("summarizes bash from argsText JSON command", () => {
  const r = summarizeToolArgs({
    toolName: "bash",
    arg: "cd /x && playwright-cli -…",
    argsText: JSON.stringify({ command: "cd /x && npm test | tail -5" }),
    argsTruncated: false,
  });
  assert.equal(r.tool, "bash");
  assert.equal(r.text, "cd /x && npm test | tail -5");
});

test("surfaces the file path for read/edit", () => {
  assert.equal(summarizeToolArgs({ toolName: "read", args: { file_path: "utils/obs/obs-run-index.ts" } }).text, "utils/obs/obs-run-index.ts");
  assert.equal(
    summarizeToolArgs({ toolName: "edit", args: { file_path: "a.ts", old_string: "x", new_string: "y" } }).text,
    "a.ts",
  );
});

test("falls back to the flat arg preview, then collapses whitespace", () => {
  const r = summarizeToolArgs({ toolName: "bash", arg: "echo   hi\n  there" });
  assert.equal(r.text, "echo hi there");
});

test("uses url/pattern when present", () => {
  assert.equal(summarizeToolArgs({ toolName: "web_fetch", args: { url: "https://x.dev" } }).text, "https://x.dev");
  assert.equal(summarizeToolArgs({ tool: "grep", args: { pattern: "TODO" } }).text, "TODO");
});

test("summarizeToolResult extracts MCP content text (incl. JSON-string form)", () => {
  const obj = { content: [{ type: "text", text: "Update relevant DB Tables and services" }] };
  assert.equal(summarizeToolResult({ result: obj }), "Update relevant DB Tables and services");
  assert.equal(summarizeToolResult({ resultText: JSON.stringify(obj) }), "Update relevant DB Tables and services");
});

test("summarizeToolResult prefers result.content.text over a summary field", () => {
  const arr = { content: [{ type: "text", text: "the real result body" }] };
  assert.equal(summarizeToolResult({ summary: "short", result: arr }), "the real result body");
  // single content object (not wrapped in an array)
  assert.equal(summarizeToolResult({ result: { content: { type: "text", text: "single" } } }), "single");
});

test("summarizeToolResult prefers an explicit summary, then plain stdout", () => {
  assert.equal(summarizeToolResult({ summary: "446 pass · 0 fail", result: "ignored" }), "446 pass · 0 fail");
  assert.equal(summarizeToolResult({ stdout: "hello\nworld" }), "hello\nworld");
  assert.equal(summarizeToolResult({}), "");
});

test("summarizeToolResult caps long multi-line results", () => {
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const out = summarizeToolResult({ result: long });
  assert.ok(out.split("\n").length <= 9); // 8 lines + the "…" marker
  assert.ok(out.endsWith("…"));
});
