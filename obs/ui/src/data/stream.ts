// EventSource wrapper carrying the §4.1–4.3 streaming contracts — the three
// failure modes a bare EventSource gets wrong against this server:
//   §4.1  reconnect even after the browser permanently CLOSES the source
//         (server restart → connection refused → EventSource gives up).
//   §4.2  per-session monotonic `seq` high-water dedupe — a reconnect replays
//         the server's ring buffer, so drop anything we've already seen.
//   §4.3  normalizeEvent: root agents (no parent) anchor a lane.
import type { ObsEvent } from "./types";
import { withToken } from "./auth";
import { apiUrl } from "./config";

// reconnect backoff: start at 2s, double to a 30s cap, reset on a healthy open.
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30_000;
// bound the per-session seq map — evict least-recently-updated sessions beyond this.
const MAX_SEQ_SESSIONS = 1000;

export interface StreamHandle {
  close: () => void;
}

export interface StreamOpts {
  /** filter to a single run (maps to /api/stream?run=) */
  runId?: string;
  onEvent: (ev: ObsEvent) => void;
  onStatus?: (s: "open" | "closed" | "retrying") => void;
}

export function openStream({ runId, onEvent, onStatus }: StreamOpts): StreamHandle {
  // high-water mark per sessionId; events with seq <= mark are replays.
  const maxSeq = new Map<string, number>();
  let es: EventSource | null = null;
  // window.setTimeout pins the DOM overload (returns number) even when Node
  // typings are visible to the compiler.
  let retryTimer: number | undefined;
  let retryMs = RETRY_BASE_MS;
  let disposed = false;

  const url = withToken(apiUrl(`/stream${runId ? `?run=${encodeURIComponent(runId)}` : ""}`));

  function connect() {
    if (disposed) return;
    es = new EventSource(url);

    es.onopen = () => {
      retryMs = RETRY_BASE_MS; // healthy again — restart the backoff ladder
      onStatus?.("open");
    };

    // obs-server emits NAMED events (`event: obs`), so onmessage (which only
    // fires for the default unnamed event) never sees them — listen on "obs".
    const handle = (e: MessageEvent) => {
      let ev: ObsEvent;
      try {
        ev = JSON.parse(e.data) as ObsEvent;
      } catch {
        return;
      }
      const seen = maxSeq.get(ev.sessionId) ?? -1;
      if (ev.seq <= seen) return; // §4.2 replay — already counted
      // delete-then-set keeps the Map ordered by last update, so the size cap
      // evicts the sessions that have been silent the longest.
      maxSeq.delete(ev.sessionId);
      maxSeq.set(ev.sessionId, ev.seq);
      for (const key of maxSeq.keys()) {
        if (maxSeq.size <= MAX_SEQ_SESSIONS) break;
        maxSeq.delete(key);
      }
      onEvent(ev);
    };
    es.addEventListener("obs", handle as EventListener);
    es.onmessage = handle; // tolerate unnamed frames too

    es.onerror = () => {
      // §4.1: when the source is fully CLOSED, the browser won't retry on its
      // own. Tear down and reconnect with jittered exponential backoff until
      // disposed (2s doubling to a 30s cap; a successful open resets to 2s).
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        onStatus?.("retrying");
        if (!retryTimer && !disposed) {
          // full jitter across 50–100% of the current step, so a fleet of tabs
          // doesn't reconnect in lockstep after a server restart.
          const delay = retryMs / 2 + Math.random() * (retryMs / 2);
          retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            connect();
          }, delay);
        }
      }
    };
  }

  connect();

  return {
    close() {
      disposed = true;
      clearTimeout(retryTimer);
      es?.close();
      es = null;
      onStatus?.("closed");
    },
  };
}
