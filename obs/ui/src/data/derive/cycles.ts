// §4 turn-cycle banding — groups the event stream into turn cycles for the
// Events tab's alternating bands. A new cycle opens on each turn_start; events
// before the first turn form a "setup" cycle.
import type { ObsEvent } from "../types";

export interface Cycle {
  index: number;
  agent: string;
  turn: number | null;
  startTs: number;
  events: ObsEvent[];
}

export function groupCycles(events: ObsEvent[]): Cycle[] {
  const evs = [...events].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const cycles: Cycle[] = [];
  let cur: Cycle | null = null;

  const open = (agent: string, turn: number | null, ts: number) => {
    cur = { index: cycles.length, agent, turn, startTs: ts, events: [] };
    cycles.push(cur);
  };

  for (const ev of evs) {
    if (ev.type === "turn_start") {
      const turn = typeof ev.payload?.turnIndex === "number" ? (ev.payload.turnIndex as number) : null;
      open(ev.agent, turn, ev.ts);
    } else if (!cur) {
      open(ev.agent, null, ev.ts); // setup cycle before any turn
    }
    cur!.events.push(ev);
  }
  return cycles;
}

export function cycleLabel(c: Cycle): string {
  if (c.turn == null) return c.index === 0 ? "Setup" : "Activity";
  return `Turn ${c.turn}`;
}
