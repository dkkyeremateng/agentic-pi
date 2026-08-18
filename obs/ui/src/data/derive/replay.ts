// Replay model for the Timeline tab — turns the raw event stream into the
// things a scrubbable replay needs: clickable markers (errors / dispatches /
// turns), snap-to-event step boundaries, and a cumulative running tally so the
// "now" readout can show cost / tokens / tools / errors up to the playhead.
import type { ObsEvent } from "../types";
import type { Span } from "./trace";

export type MarkerKind = "error" | "dispatch" | "turn";

export interface Marker {
  ts: number;
  kind: MarkerKind;
  label: string;
}

export interface Tally {
  cost: number;
  tokens: number;
  tools: number;
  errors: number;
}

// one cumulative snapshot per event ts, sorted ascending — totalsAt() binary
// searches this for the last point at or before the playhead.
interface CumPoint extends Tally {
  ts: number;
}

export interface ReplayModel {
  markers: Marker[];
  steps: number[]; // sorted unique span boundaries to step between
  cum: CumPoint[];
  total: Tally; // grand totals (denominator for the readout)
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
// turn_end `tokens` is an object ({input,output,…,total}) on current servers,
// a bare number on legacy JSONL (see laneRollup.ts).
function tokenTotal(v: unknown): number {
  if (v && typeof v === "object" && "total" in v) return num(v.total);
  return num(v);
}
const isErr = (ev: ObsEvent) =>
  ev.type === "error" || (ev.type === "tool_end" && (ev.payload?.isError === true || ev.payload?.ok === false));

export function buildReplay(events: ObsEvent[], spans: Span[]): ReplayModel {
  const evs = [...events].sort((a, b) => a.ts - b.ts);

  const markers: Marker[] = [];
  const cum: CumPoint[] = [];
  const t: Tally = { cost: 0, tokens: 0, tools: 0, errors: 0 };

  for (const ev of evs) {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case "turn_end":
        t.cost += num(p.costUsd);
        t.tokens += tokenTotal(p.tokens) || num(p.totalTokens);
        break;
      case "tool_start":
        t.tools += 1;
        break;
      case "turn_start":
        markers.push({ ts: ev.ts, kind: "turn", label: `turn ${typeof p.turnIndex === "number" ? p.turnIndex : "?"}` });
        break;
      case "dispatch_start":
        markers.push({ ts: ev.ts, kind: "dispatch", label: `→ ${str(p.agent) || "agent"}` });
        break;
    }
    if (isErr(ev)) {
      t.errors += 1;
      markers.push({ ts: ev.ts, kind: "error", label: str(p.message) || str(p.tool) || "error" });
    }
    cum.push({ ts: ev.ts, ...t });
  }

  // step boundaries: every non-agent span start/end, deduped + sorted
  const set = new Set<number>();
  for (const s of spans) {
    if (s.kind === "agent") continue;
    set.add(s.startTs);
    set.add(s.endTs);
  }
  const steps = [...set].sort((a, b) => a - b);

  return { markers, steps, cum, total: { ...t } };
}

// cumulative totals at (or before) the playhead — binary search the snapshots.
export function totalsAt(cum: CumPoint[], ts: number): Tally {
  if (!cum.length || ts < cum[0].ts) return { cost: 0, tokens: 0, tools: 0, errors: 0 };
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid].ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  const c = cum[lo];
  return { cost: c.cost, tokens: c.tokens, tools: c.tools, errors: c.errors };
}

// ── pacing ──
// "fit": playhead advances linearly over real run-time (idle gaps shown to
// scale). "even": equal wall-time between consecutive event boundaries, so dead
// air is collapsed and dense bursts get room. A Warp maps a wall-clock progress
// fraction f∈[0,1] → a run timestamp, and back (inv) so replay can resume from
// an arbitrary playhead position.
export type Pace = "fit" | "even";

export interface Warp {
  at: (f: number) => number; // progress fraction → run ts
  inv: (ts: number) => number; // run ts → progress fraction
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export function buildWarp(pace: Pace, steps: number[], start: number, end: number): Warp {
  if (pace === "fit" || end <= start) {
    const span = Math.max(1, end - start);
    return {
      at: (f) => start + clamp01(f) * (end - start),
      inv: (ts) => clamp01((ts - start) / span),
    };
  }
  // even: anchor array of boundaries inside (start, end), padded with the ends
  const inner = steps.filter((s) => s > start && s < end);
  const arr = [start, ...inner, end];
  const n = arr.length - 1; // number of equal-time segments
  return {
    at: (f) => {
      const pos = clamp01(f) * n;
      const i = Math.min(n - 1, Math.floor(pos));
      return lerp(arr[i], arr[i + 1], pos - i);
    },
    inv: (ts) => {
      if (ts <= start) return 0;
      if (ts >= end) return 1;
      let i = 0;
      while (i < n && arr[i + 1] < ts) i++;
      const seg = arr[i + 1] - arr[i] || 1;
      return (i + (ts - arr[i]) / seg) / n;
    },
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// nearest step strictly before / after `ts`, clamped to [lo, hi]. Returns null
// when there's nothing further in that direction.
export function stepFrom(steps: number[], ts: number, dir: 1 | -1, lo: number, hi: number): number | null {
  if (dir > 0) {
    for (const s of steps) if (s > ts + 0.5 && s <= hi) return s;
    return null;
  }
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i] < ts - 0.5 && steps[i] >= lo) return steps[i];
  return null;
}
