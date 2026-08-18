import { test } from "node:test";
import assert from "node:assert/strict";
import { eventMeta } from "./eventMeta.ts";
import type { ObsEvent } from "../data/types.ts";

let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}): ObsEvent {
  return { v: 2, seq: seq++, ts: 1000, sessionId: "s", agent: "implementer", type, payload };
}

test("turn_end renders sub-cent cost with precision — never a lying $0.00", () => {
  const m = eventMeta(ev("turn_end", { turnIndex: 2, tokens: { total: 19500 }, costUsd: 0.004 }));
  assert.equal(m.badge, "turn 2");
  assert.equal(m.badgeClass, "turn");
  assert.equal(m.text, "end_turn · 19.5k tok · $0.0040");
  // regression: costUsd.toFixed(2) rendered "$0.00" for cheap turns
  assert.ok(!/\$0\.00\b/.test(m.text));
  // dollar-scale costs stay at cent precision
  const big = eventMeta(ev("turn_end", { costUsd: 1.5, stopReason: "max_tokens" }));
  assert.equal(big.text, "max_tokens · $1.50");
});

test("turn_end tolerates all three historical token shapes", () => {
  for (const payload of [
    { tokens: { total: 1200 } }, // current: object with per-kind breakdown
    { tokens: 1200 }, // legacy: plain number
    { totalTokens: 1200 }, // older still
  ]) {
    assert.equal(eventMeta(ev("turn_end", payload)).text, "end_turn · 1.2k tok", JSON.stringify(payload));
  }
});

test("turn badges keep a 0-based turnIndex of 0 — falsy but real", () => {
  assert.equal(eventMeta(ev("turn_start", { turnIndex: 0 })).badge, "turn 0");
  assert.equal(eventMeta(ev("turn_end", { turnIndex: 0 })).badge, "turn 0");
  assert.equal(eventMeta(ev("turn_end", {})).badge, "turn ?"); // missing index degrades, not crashes
});

test("tool_start surfaces the tool name and its salient argument", () => {
  const m = eventMeta(ev("tool_start", { toolName: "bash", args: { command: "ls -la" } }));
  assert.equal(m.emoji, "🔧");
  assert.equal(m.badge, "bash");
  assert.equal(m.badgeClass, "tool");
  assert.equal(m.text, "ls -la");
});

test("tool_end success rows carry the result summary and duration", () => {
  const m = eventMeta(ev("tool_end", { toolName: "read", result: "42 lines", durationMs: 1500 }));
  assert.equal(m.emoji, "📦");
  assert.equal(m.badge, "read");
  assert.equal(m.badgeClass, "rs");
  assert.equal(m.text, "42 lines (1.5s)");
});

test("tool_end failures map to the error row under either flag shape", () => {
  for (const flags of [{ isError: true }, { ok: false }]) {
    const m = eventMeta(ev("tool_end", { toolName: "bash", ...flags }));
    const label = JSON.stringify(flags);
    assert.equal(m.emoji, "❌", label);
    assert.equal(m.badge, "error", label);
    assert.equal(m.badgeClass, "err", label);
    assert.equal(m.text, "failed", label); // no result summary → explicit "failed"
  }
});

test("session rows: start shows the model, end is terminal", () => {
  const start = eventMeta(ev("session_start", { model: "fable-5" }));
  assert.equal(start.emoji, "▶️");
  assert.equal(start.badgeClass, "say");
  assert.equal(start.text, "session start · fable-5");
  const end = eventMeta(ev("session_end"));
  assert.equal(end.emoji, "🏁");
  assert.equal(end.badge, "end");
  assert.equal(end.badgeClass, "dim");
  assert.equal(end.text, "session end");
});

test("message text falls back across the collector's field variants", () => {
  assert.equal(eventMeta(ev("message", { text: "hello" })).text, "hello");
  assert.equal(eventMeta(ev("message", { content: "from content" })).text, "from content");
  assert.equal(eventMeta(ev("message", {})).text, "message");
});

test("verdict rows map status to pass/fail visuals", () => {
  const fail = eventMeta(ev("verdict", { status: "fail", note: "flaky" }));
  assert.equal(fail.emoji, "❌");
  assert.equal(fail.badge, "fail");
  assert.equal(fail.badgeClass, "err");
  assert.equal(fail.text, "flaky");
  const pass = eventMeta(ev("verdict", { status: "pass" }));
  assert.equal(pass.emoji, "✅");
  assert.equal(pass.badgeClass, "rs");
});

test("unknown event types degrade to a dim row named by their type", () => {
  const m = eventMeta(ev("custom_probe", { summary: "something odd" }));
  assert.equal(m.emoji, "•");
  assert.equal(m.badge, "custom_probe");
  assert.equal(m.badgeClass, "dim");
  assert.equal(m.text, "something odd");
});
