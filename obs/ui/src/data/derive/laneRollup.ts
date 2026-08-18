// Per-lane rollup — port of obs-server-core applyRollup, computed client-side
// from a lane's buffered events for the Live wall cards.
import type { ObsEvent } from "../types";

export interface LaneRollup {
  agent: string;
  model?: string;
  events: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  tokens: number;
  costUsd: number;
  lastType: string;
  firstTs: number;
  lastTs: number;
  active: boolean;
  ended: boolean;
  ctxPct: number | null;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function laneRollup(events: ObsEvent[]): LaneRollup {
  const r: LaneRollup = {
    agent: events[0]?.agent ?? "agent",
    events: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    errors: 0,
    tokens: 0,
    costUsd: 0,
    lastType: "",
    firstTs: events[0]?.ts ?? 0,
    lastTs: 0,
    active: false,
    ended: false,
    ctxPct: null,
  };
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    r.events++;
    r.lastType = ev.type;
    r.lastTs = Math.max(r.lastTs, ev.ts);
    r.firstTs = Math.min(r.firstTs, ev.ts);
    // lanes cap their buffered event tail, so session_start / tool_start can
    // scroll out of the window on turn-heavy sessions — treat ANY event other
    // than session_end as activity evidence (non-empty tail without a
    // session_end ⇒ active).
    if (ev.type === "session_end") {
      r.active = false;
      r.ended = true;
    } else {
      r.active = true;
    }
    switch (ev.type) {
      case "session_start":
        if (typeof p.model === "string") r.model = p.model;
        break;
      case "turn_end": {
        r.turns++;
        r.tokens += num((p.tokens as { total?: number })?.total);
        r.costUsd += num(p.costUsd);
        const ctx = num(p.contextPct) || num((p.context as { pct?: number })?.pct) || num(p.maxContextPct);
        if (ctx) r.ctxPct = ctx;
        break;
      }
      case "tool_start":
        r.toolCalls++;
        break;
      case "tool_end":
        if (p.isError) r.toolErrors++;
        break;
      case "error":
        r.errors++;
        break;
    }
  }
  return r;
}

/** §4 stall heuristic: an active lane silent longer than the threshold. */
export function laneStalledMs(r: LaneRollup, now = Date.now()): number {
  if (!r.active || r.ended) return 0;
  const idle = now - r.lastTs;
  return idle > 90_000 ? idle : 0;
}
