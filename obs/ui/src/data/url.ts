// Two-way sync between the store and location.hash, so every view is
// linkable and back/forward works (the §6.1 "full URL state" requirement).
// User-driven store changes assign location.hash (pushing a history entry);
// replaceState is reserved for canonicalizing the current entry (initial load
// and hashchange-originated applies), so back/forward never loops.
// Shape:  #/<segment>[/<runId>[/<tab>]]   e.g.  #/runs/run-abc/trace
import { useEffect } from "react";
import { useObs, type RunTab, type Segment } from "./store";

const SEGMENTS: Segment[] = ["runs", "live", "analytics", "datasets", "monitors", "prompts", "chat", "search"];
const TABS: RunTab[] = ["trace", "timeline", "events", "stats", "evals", "raw"];

interface UrlState {
  segment: Segment;
  selectedRunId: string | null;
  runTab: RunTab;
}

function parse(): UrlState {
  const raw = location.hash.replace(/^#\/?/, "");
  const [seg, run, tab] = raw.split("/").map((s) => decodeURIComponent(s || ""));
  return {
    segment: (SEGMENTS as string[]).includes(seg) ? (seg as Segment) : "runs",
    selectedRunId: run || null,
    runTab: (TABS as string[]).includes(tab) ? (tab as RunTab) : "trace",
  };
}

function serialize(s: UrlState): string {
  let h = `#/${s.segment}`;
  if (s.segment === "runs" && s.selectedRunId) {
    h += `/${encodeURIComponent(s.selectedRunId)}/${s.runTab}`;
  }
  return h;
}

// True while apply() is pushing a parsed hash into the store. zustand v5
// notifies subscribers synchronously inside set(), so the store→hash
// subscription below runs before apply() clears the flag — those writes must
// not create history entries (they'd double every back/forward step).
let applyingHash = false;

export function useUrlSync() {
  // hash → store (initial + back/forward)
  useEffect(() => {
    const apply = () => {
      const parsed = parse();
      const st = useObs.getState();
      applyingHash = true;
      try {
        if (st.segment !== parsed.segment) st.setSegment(parsed.segment);
        if (st.selectedRunId !== parsed.selectedRunId) st.selectRun(parsed.selectedRunId);
        if (st.runTab !== parsed.runTab) st.setRunTab(parsed.runTab);
      } finally {
        applyingHash = false;
      }
      // canonicalize in place (e.g. "" → #/runs) without a new entry
      const canonical = serialize(parsed);
      if (location.hash !== canonical) history.replaceState(null, "", canonical);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // store → hash
  useEffect(() => {
    return useObs.subscribe((st) => {
      const next = serialize({
        segment: st.segment,
        selectedRunId: st.selectedRunId,
        runTab: st.runTab,
      });
      if (location.hash === next) return;
      if (applyingHash) history.replaceState(null, "", next);
      else location.hash = next; // user-driven → real history entry
    });
  }, []);
}
