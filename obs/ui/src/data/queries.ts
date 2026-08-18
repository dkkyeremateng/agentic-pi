// React Query hooks over the typed client.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ObsEvent, RunDigest, RunMeta, VerdictStatus } from "./types";

const LIVE_MS = 3_000; // poll cadence while a run is active
const QUIET_MS = 90_000; // a run silent this long is treated as finished

// Poll while the run still looks active (its latest event is recent), then stop
// so finished runs aren't re-fetched forever. `lastTs` is the run's newest event.
function livePoll(lastTs: number | undefined): number | false {
  if (lastTs == null) return LIVE_MS; // nothing loaded yet — keep checking
  return Date.now() - lastTs < QUIET_MS ? LIVE_MS : false;
}

// A finished run that never spent anything (no cost, tokens, or tool calls) is
// noise — a trivial ping or an aborted no-op. Hide it once it's gone quiet, but
// keep live runs (which legitimately read all-zero before their first turn).
function isEmptyFinished(r: RunMeta, now = Date.now()): boolean {
  const empty = r.costUsd === 0 && (r.tokens ?? 0) === 0 && (r.toolCalls ?? 0) === 0;
  return empty && now - r.lastTs > QUIET_MS;
}

// Stable reference so TanStack memoizes the result: an inline select would run
// every render and hand back a fresh array, breaking every downstream useMemo
// (analytics, inbox sort, global stats) that keys on the runs list identity.
const selectVisibleRuns = (rows: RunMeta[]) => rows.filter((r) => !isEmptyFinished(r));

export function useRuns(params: { project?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["runs", params],
    queryFn: ({ signal }) => api.runs({ limit: 200, ...params }, signal),
    // runs list refreshes periodically so a freshly-finished run shows up
    refetchInterval: 8_000,
    // drop finished empty runs from the dashboard (live runs stay)
    select: selectVisibleRuns,
  });
}

export function useSummary() {
  return useQuery({
    queryKey: ["summary"],
    queryFn: ({ signal }) => api.summary(signal),
    refetchInterval: 5_000,
  });
}

// Agents alive right now with a control channel — the attachable set. Polled so
// the chat attach picker reflects sessions coming and going in near real time.
export function useLiveSessions(enabled = true) {
  return useQuery({
    queryKey: ["live-sessions"],
    queryFn: ({ signal }) => api.liveSessions(signal),
    refetchInterval: 4_000,
    enabled,
  });
}

// Cross-run prompt/config registry. Scans the whole sink server-side, so it's
// heavier than /runs — refresh occasionally rather than polling hard.
export function usePrompts() {
  return useQuery({
    queryKey: ["prompts"],
    queryFn: ({ signal }) => api.prompts(signal),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

export function useRun(id: string | null) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: ({ signal }) => api.run(id!, signal),
    enabled: !!id,
    refetchInterval: (q) => livePoll((q.state.data as RunMeta | undefined)?.lastTs),
  });
}

export function useRunEvents(id: string | null) {
  return useQuery({
    queryKey: ["events", id],
    queryFn: ({ signal }) => api.runEvents(id!, signal),
    enabled: !!id,
    // live: while the agents are running, keep pulling new spans/events in.
    refetchInterval: (q) => {
      const evs = q.state.data as ObsEvent[] | undefined;
      const lastTs = evs?.length ? evs.reduce((m, e) => (e.ts > m ? e.ts : m), 0) : undefined;
      return livePoll(lastTs);
    },
  });
}

export function useDigest(id: string | null) {
  return useQuery({
    queryKey: ["digest", id],
    queryFn: ({ signal }) => api.digest(id!, signal),
    enabled: !!id,
    refetchInterval: (q) => livePoll((q.state.data as RunDigest | undefined)?.endTs),
  });
}

/** Lazy: only fires once the user clicks Explain (enabled gate). Cached so a
 *  re-open doesn't re-spend. */
export function useExplain(id: string | null, requested: boolean) {
  return useQuery({
    queryKey: ["explain", id],
    queryFn: ({ signal }) => api.explain(id!, signal),
    enabled: !!id && requested,
    staleTime: Infinity,
    retry: false,
  });
}

/** Lazy LLM-as-judge: only fires once the user clicks Run AI judge. Cached so a
 *  re-open doesn't re-spend. */
export function useJudge(id: string | null, requested: boolean) {
  return useQuery({
    queryKey: ["judge", id],
    queryFn: ({ signal }) => api.judge(id!, signal),
    enabled: !!id && requested,
    staleTime: Infinity,
    retry: false,
  });
}

/** Lazy one-sentence summary of a text chunk (an I/O block). Keyed by the text
 *  so toggling raw↔AI reuses the cached result; only fires when requested. */
export function useSummarize(text: string, kind: string, requested: boolean) {
  return useQuery({
    queryKey: ["summarize", kind, text],
    queryFn: ({ signal }) => api.summarize(text, kind, signal),
    enabled: requested && !!text.trim(),
    staleTime: Infinity,
    retry: false,
  });
}

export function useVerdict(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    // `agent` scopes the verdict to one agent's run instead of the whole run
    mutationFn: ({ status, note, agent }: { status: VerdictStatus; note?: string; agent?: string }) =>
      api.setVerdict(id!, status, note, agent),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run", id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["digest", id] });
    },
  });
}
