// Live event streaming for one run, riding openStream (./stream) so it gets
// the §4.1 reconnect-after-CLOSED and §4.2 per-session seq dedupe behaviour
// for free. Merges pushed ObsEvents into the ["events", runId] query cache so
// the Trace / Events views update the instant an agent emits — no waiting on
// the poll. The poll stays as a self-healing fallback: it refetches the full
// run history, which is idempotent here, so a dropped SSE frame is reconciled
// within seconds.
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openStream } from "./stream";
import type { ObsEvent } from "./types";

/** Highest `seq` already held per sessionId. `seq` is monotonic per session
 *  (the §4.2 contract openStream relies on), so this is the whole dedupe key. */
export function seedHighWater(events: readonly ObsEvent[]): Map<string, number> {
  const hw = new Map<string, number>();
  for (const e of events) {
    const s = hw.get(e.sessionId);
    if (s === undefined || e.seq > s) hw.set(e.sessionId, e.seq);
  }
  return hw;
}

/** True when we already hold this event (or a later one from its session) —
 *  i.e. the server is replaying its ring buffer over a cache the initial poll
 *  already filled. */
export function isReplay(hw: ReadonlyMap<string, number>, ev: ObsEvent): boolean {
  const s = hw.get(ev.sessionId);
  return s !== undefined && ev.seq <= s;
}

export function useLiveEvents(runId: string | null) {
  const qc = useQueryClient();
  // Per-session high-water marks for what the cache already holds, plus the
  // array identity they were derived from. A bounded tail scan used to do this
  // job, but on connect the server replays its whole ring buffer: for a run
  // longer than the window, those old replays fall outside it and get appended
  // a second time (a 7.9k-event run cached 9k). Seq marks are exact and O(1).
  const hwRef = useRef<Map<string, number>>(new Map());
  const seededFromRef = useRef<readonly ObsEvent[] | null>(null);

  useEffect(() => {
    if (!runId || typeof EventSource === "undefined") return;
    hwRef.current = new Map();
    seededFromRef.current = null;

    // A verdict / turn_end changes the server-computed digest + run meta; refresh
    // them on a short throttle instead of on every single event.
    let derivedTimer: number | undefined;
    const refreshDerived = () => {
      if (derivedTimer != null) return;
      derivedTimer = window.setTimeout(() => {
        derivedTimer = undefined;
        qc.invalidateQueries({ queryKey: ["digest", runId] });
        qc.invalidateQueries({ queryKey: ["run", runId] });
      }, 1200);
    };

    const handle = openStream({
      runId,
      onEvent: (ev) => {
        if (ev.runId && ev.runId !== runId) return;

        // Re-seed only when someone else replaced the array — i.e. the poll
        // refetched server truth. Our own appends update the marks inline, so
        // the steady-state cost per streamed event stays O(1).
        const cur = qc.getQueryData<ObsEvent[]>(["events", runId]);
        if (cur !== seededFromRef.current) {
          hwRef.current = seedHighWater(cur ?? []);
          seededFromRef.current = cur ?? null;
        }
        if (isReplay(hwRef.current, ev)) return;
        hwRef.current.set(ev.sessionId, ev.seq);

        qc.setQueryData<ObsEvent[]>(["events", runId], (prev) => {
          const next = prev && prev.length ? [...prev, ev] : [ev];
          seededFromRef.current = next; // our own write — don't re-seed on it
          return next;
        });
        if (ev.type === "verdict" || ev.type === "turn_end" || ev.type === "session_end") refreshDerived();
      },
    });

    return () => {
      handle.close();
      clearTimeout(derivedTimer);
    };
  }, [runId, qc]);
}
