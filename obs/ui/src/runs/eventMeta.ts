// Maps an ObsEvent to the emoji, badge, and one-line description a feed row
// renders — the single place event presentation is decided, so the Live wall,
// the Events tab, and Search all label the same event identically.
import type { ObsEvent } from "../data/types";
import { summarizeToolArgs, summarizeToolResult } from "../lib/toolArgs";
import { formatCostPrecise, formatTokens } from "../lib/format";

export type BadgeClass = "tool" | "rs" | "err" | "turn" | "say" | "dim";

export interface EventMeta {
  emoji: string; // event-type glyph
  badge: string;
  badgeClass: BadgeClass;
  text: string;
}

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function n(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// An emoji glyph per event type — a quick visual anchor for the Events feed.
export function eventEmoji(ev: ObsEvent): string {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "session_start":
      return "▶️";
    case "session_end":
      return "🏁";
    case "turn_start":
      return "💭";
    case "turn_end":
      return "✅";
    case "tool_start":
      return "🔧";
    case "tool_end":
      return p.isError === true || p.ok === false ? "❌" : "📦";
    case "dispatch_start":
      return "📤";
    case "dispatch_retry":
      return "🔄";
    case "dispatch_end":
      return "📥";
    case "message":
      return "💬";
    case "error":
      return "🛑";
    case "compaction":
      return "🗜️";
    case "model_change":
      return "🔀";
    case "verdict":
      return s(p.status) === "fail" ? "❌" : s(p.status) === "pass" ? "✅" : "🏷️";
    default:
      return "•";
  }
}

export function eventMeta(ev: ObsEvent): EventMeta {
  return { ...baseMeta(ev), emoji: eventEmoji(ev) };
}

function baseMeta(ev: ObsEvent): Omit<EventMeta, "emoji"> {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "session_start":
      return { badge: "start", badgeClass: "say", text: `session start · ${s(p.model) || "model"}` };
    case "session_end":
      return { badge: "end", badgeClass: "dim", text: "session end" };
    case "turn_start":
      return { badge: `turn ${n(p.turnIndex) ?? "?"}`, badgeClass: "turn", text: "thinking…" };
    case "turn_end": {
      // turn_end `tokens` is an object ({input,output,…,total}); older events
      // carried a plain number (or totalTokens)
      const tokens = p.tokens as unknown;
      const tok =
        n(tokens) ?? (tokens && typeof tokens === "object" ? n((tokens as Record<string, unknown>).total) : undefined) ?? n(p.totalTokens);
      const cost = n(p.costUsd);
      const bits = [s(p.stopReason) || "end_turn"];
      if (tok) bits.push(`${formatTokens(tok)} tok`);
      if (cost) bits.push(formatCostPrecise(cost));
      return { badge: `turn ${n(p.turnIndex) ?? "?"}`, badgeClass: "turn", text: bits.join(" · ") };
    }
    case "tool_start": {
      const { tool, text } = summarizeToolArgs(p);
      return { badge: tool, badgeClass: "tool", text };
    }
    case "tool_end": {
      const err = p.isError === true || p.ok === false;
      const tool = s(p.tool) || s(p.name) || s(p.toolName) || "tool";
      const ms = n(p.ms) ?? n(p.durationMs);
      const tail = ms ? ` (${(ms / 1000).toFixed(1)}s)` : "";
      const summary = summarizeToolResult(p).split("\n")[0]; // first line for the feed
      return err
        ? { badge: "error", badgeClass: "err", text: `${summary || "failed"}${tail}` }
        : { badge: tool, badgeClass: "rs", text: `${summary || "ok"}${tail}` };
    }
    case "dispatch_start":
      return { badge: "dispatch", badgeClass: "turn", text: `${s(p.agent) || "agent"} ← ${s(p.task) || "task"}` };
    case "dispatch_retry":
      return { badge: "retry", badgeClass: "err", text: `${s(p.agent) || "agent"} re-dispatched${s(p.reason) ? ` (${s(p.reason)})` : ""}` };
    case "dispatch_end":
      return { badge: "dispatch", badgeClass: "dim", text: `${s(p.agent) || "agent"} ${s(p.status) || "done"}` };
    case "message":
      return { badge: "say", badgeClass: "say", text: s(p.text) || s(p.content) || s(p.summary) || "message" };
    case "error":
      return { badge: "error", badgeClass: "err", text: s(p.message) || s(p.status) || "error" };
    case "compaction":
      return { badge: "compact", badgeClass: "dim", text: "context compacted" };
    case "model_change":
      return { badge: "model", badgeClass: "dim", text: s(p.model) || "model change" };
    case "verdict":
      return { badge: s(p.status) || "verdict", badgeClass: s(p.status) === "fail" ? "err" : "rs", text: s(p.note) || s(p.outcome) || "" };
    default:
      return { badge: ev.type, badgeClass: "dim", text: s(p.summary) || "" };
  }
}
