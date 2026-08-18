import { useEffect, useMemo, useState } from "react";
import { useObs, type RunTab } from "../data/store";
import { useMedia } from "../lib/useMedia";
import { useLiveSessions, useRun, useRuns } from "../data/queries";
import { useLiveEvents } from "../data/live";
import { RunsInbox } from "./RunsInbox";
import { RunHero } from "./RunHero";
import { DigestPane } from "./DigestPane";
import { TraceTab } from "./tabs/TraceTab";
import { EventsTab } from "./tabs/EventsTab";
import { TimelineTab } from "./tabs/TimelineTab";
import { RawTab } from "./tabs/RawTab";
import { StatsTab } from "./tabs/StatsTab";
import { EvalsTab } from "./tabs/EvalsTab";
import "./runs.css";

function RunTabBody({ runId }: { runId: string }) {
  const runTab = useObs((s) => s.runTab);
  switch (runTab) {
    case "trace":
      return <TraceTab runId={runId} />;
    case "timeline":
      // key by run so switching runs remounts and restores that run's saved
      // timeline state (zoom/position/filters) from the per-run cache
      return <TimelineTab key={runId} runId={runId} />;
    case "events":
      return <EventsTab runId={runId} />;
    case "raw":
      return <RawTab runId={runId} />;
    case "stats":
      return <StatsTab runId={runId} />;
    case "evals":
      return <EvalsTab runId={runId} />;
  }
}

const TAB_KEYS: RunTab[] = ["trace", "timeline", "events", "stats", "evals", "raw"];

export function RunsView() {
  const runsQ = useRuns();
  const selectedRunId = useObs((s) => s.selectedRunId);
  const selectRun = useObs((s) => s.selectRun);
  const setRunTab = useObs((s) => s.setRunTab);
  const runs = runsQ.data ?? [];

  // 1–6 jump to a run-detail tab (when a run is open and not typing) — pairs
  // with j/k run navigation in the inbox for a keyboard-driven flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !selectedRunId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= TAB_KEYS.length) {
        e.preventDefault();
        setRunTab(TAB_KEYS[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRunId, setRunTab]);

  // runs with an OPEN pi session right now (pid-alive + fresh heartbeat) — the
  // truth behind the "Active" filter. Polled every few seconds by the query.
  const liveQ = useLiveSessions();
  const activeRunIds = useMemo(
    () => new Set((liveQ.data ?? []).map((s) => s.runId).filter((id): id is string => !!id)),
    [liveQ.data],
  );

  // Mobile: master→detail instead of stacking all three panes. Tapping a run in
  // the inbox opens the detail; a back button returns to the list.
  const narrow = useMedia("(max-width: 900px)");
  const [mobileDetail, setMobileDetail] = useState(false);

  // auto-select the most recent run once data arrives and nothing is chosen
  useEffect(() => {
    if (!selectedRunId && runs.length) {
      const latest = [...runs].sort((a, b) => b.firstTs - a.firstTs)[0];
      selectRun(latest.runId);
    }
  }, [selectedRunId, runs, selectRun]);

  const runQ = useRun(selectedRunId);
  const selected = runQ.data ?? runs.find((r) => r.runId === selectedRunId) ?? null;

  // push live events for the open run straight into the cache (instant spans);
  // the per-query polling stays as a self-healing fallback.
  useLiveEvents(selectedRunId);

  const openRun = (id: string) => {
    selectRun(id);
    if (narrow) setMobileDetail(true);
  };

  const inbox = (
    <RunsInbox runs={runs} loading={runsQ.isLoading} selectedId={selectedRunId} onSelect={openRun} activeRunIds={activeRunIds} />
  );
  const detail = (
    <div className="center">
      {narrow && (
        <button className="mback" onClick={() => setMobileDetail(false)}>
          ‹ Runs
        </button>
      )}
      {selected ? (
        <>
          <RunHero run={selected} />
          <div className="body2">
            <RunTabBody runId={selected.runId} />
          </div>
          {narrow && <DigestPane runId={selectedRunId} />}
        </>
      ) : (
        <div className="center-empty">
          {runsQ.isLoading ? "Loading runs…" : "No run selected."}
        </div>
      )}
    </div>
  );

  // Mobile: one pane at a time (list ⇄ detail).
  if (narrow) {
    return <div className="cols mobile">{mobileDetail && selected ? detail : inbox}</div>;
  }

  // Desktop: the three panes side by side.
  return (
    <div className="cols">
      {inbox}
      {detail}
      <DigestPane runId={selectedRunId} />
    </div>
  );
}
