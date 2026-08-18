// Which sub-agents the primary agent is currently blocked on. The orchestrator
// emits `dispatch_start`/`dispatch_retry`/`dispatch_end` (paired by dispatchId)
// around each sub-agent it runs; a start without a matching end means that
// dispatch is still in flight — i.e. the primary is waiting on that sub-agent.
import type { Lane } from "../store";
import type { ObsEvent } from "../types";

export interface RunningDispatch {
  agent: string; // the sub-agent being run
  task?: string; // its task summary, if captured
  sinceTs: number; // when the (latest attempt of the) dispatch started
  attempt?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** In-flight dispatches across a run's lanes, newest first. `runId` scopes it to
 *  the steered run; pass all lanes (the orchestrator's lane carries the events). */
export function runningDispatches(lanes: Iterable<Lane>, runId?: string): RunningDispatch[] {
  const open = new Map<string, RunningDispatch>(); // sessionId#dispatchId → running
  const evs: ObsEvent[] = [];
  for (const lane of lanes) {
    for (const e of lane.events) {
      if (runId && e.runId && e.runId !== runId) continue;
      if (e.type === "dispatch_start" || e.type === "dispatch_retry" || e.type === "dispatch_end") evs.push(e);
    }
  }
  // ts first: seq is per-session monotonic, so cross-session seq comparison is
  // meaningless — it only breaks ties within one session's clock resolution.
  evs.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  for (const e of evs) {
    const did = str(e.payload?.dispatchId) || str(e.payload?.agent);
    if (!did) continue;
    // dispatchIds are only unique within the emitting session
    const id = `${e.sessionId}#${did}`;
    if (e.type === "dispatch_end") {
      open.delete(id);
    } else {
      // start or retry → (re)mark as running with the freshest attempt/time
      open.set(id, {
        agent: str(e.payload?.agent) || e.agent,
        task: str(e.payload?.task) || undefined,
        sinceTs: e.ts,
        attempt: typeof e.payload?.attempt === "number" ? (e.payload.attempt as number) : undefined,
      });
    }
  }
  return [...open.values()].sort((a, b) => b.sinceTs - a.sinceTs);
}
