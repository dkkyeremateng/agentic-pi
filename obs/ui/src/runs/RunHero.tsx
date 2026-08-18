import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunMeta } from "../data/types";
import { useObs, type RunTab } from "../data/store";
import { api } from "../data/client";
import { StatusChip } from "../lib/Chip";
import { Icon } from "../lib/Icon";
import { useNow } from "../lib/useNow";
import { onTablistKey } from "../lib/tablist";
import { formatCost, formatDuration, projectOf, relTime } from "../lib/format";
import { durationMs, isLive, runTitle, statusOf } from "./runUtils";

const TABS: RunTab[] = ["trace", "timeline", "events", "stats", "evals", "raw"];

function Kpi({ k, v }: { k: string; v: string }) {
  return (
    <span className="kpi">
      <span className="k">{k}</span>
      <br />
      <span className="v">{v}</span>
    </span>
  );
}

export function RunHero({ run }: { run: RunMeta }) {
  const runTab = useObs((s) => s.runTab);
  const setRunTab = useObs((s) => s.setRunTab);
  const setSegment = useObs((s) => s.setSegment);
  const requestExplain = useObs((s) => s.requestExplain);
  const datasets = useObs((s) => s.datasets);
  const toggleRunInDataset = useObs((s) => s.toggleRunInDataset);
  const createDataset = useObs((s) => s.createDataset);
  const qc = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [setOpen, setSetOpen] = useState(false);
  const [dsName, setDsName] = useState("");
  // tick so "active / ended", the live chip, and relTime stay current without
  // waiting on the next data refetch
  const now = useNow(30_000);
  const status = statusOf(run, now);
  const live = isLive(run, now);

  // download the run as one JSON bundle (meta + digest + full event stream),
  // pulling from cache when it's already loaded so an open run exports instantly.
  const onExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportErr(null);
    try {
      const [events, digest] = await Promise.all([
        qc.ensureQueryData({ queryKey: ["events", run.runId], queryFn: ({ signal }) => api.runEvents(run.runId, signal) }),
        qc
          .ensureQueryData({ queryKey: ["digest", run.runId], queryFn: ({ signal }) => api.digest(run.runId, signal) })
          .catch(() => null),
      ]);
      const blob = new Blob([JSON.stringify({ run, digest, events }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${run.runId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportErr((e as Error)?.message || "couldn't fetch the run's events");
    } finally {
      setExporting(false);
    }
  };

  // absolute run window — include the date, and the end date too when the run
  // spans more than one calendar day (e.g. crossed midnight)
  const start = new Date(run.firstTs);
  const end = new Date(run.lastTs);
  const dateOpts = { month: "short", day: "numeric" } as const;
  const sameDay = start.toDateString() === end.toDateString();
  const ranText = `${start.toLocaleDateString([], dateOpts)}, ${start.toLocaleTimeString()} → ${
    sameDay ? "" : `${end.toLocaleDateString([], dateOpts)}, `
  }${end.toLocaleTimeString()}`;

  return (
    <div className="hero">
      <div className="hrow">
        <span className="htitle">{runTitle(run)}</span>
        <StatusChip status={status} />
        <span className="hact">
          <span className="ds-add">
            <button className="btn" onClick={() => setSetOpen((v) => !v)} title="Add this run to a dataset">
              <Icon name="square" /> Add to set
            </button>
            {setOpen && (
              <div className="ds-pop" onMouseLeave={() => setSetOpen(false)}>
                <div className="ds-pop-h">Add to dataset</div>
                {datasets.length === 0 && <div className="ds-pop-empty">No sets yet — name one below.</div>}
                {datasets.map((d) => {
                  const inSet = d.runIds.includes(run.runId);
                  return (
                    <button
                      key={d.id}
                      className={`ds-pop-row ${inSet ? "on" : ""}`}
                      onClick={() => toggleRunInDataset(d.id, run.runId)}
                    >
                      <span className="ds-pop-ck">{inSet ? "✓" : ""}</span>
                      <span className="ds-pop-n">{d.name}</span>
                      <span className="ds-pop-c mono">{d.runIds.length}</span>
                    </button>
                  );
                })}
                <input
                  className="ds-pop-new"
                  value={dsName}
                  onChange={(e) => setDsName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && dsName.trim()) {
                      const id = createDataset(dsName.trim());
                      toggleRunInDataset(id, run.runId);
                      setDsName("");
                    }
                  }}
                  placeholder="New set + add this run…"
                  aria-label="Create dataset and add run"
                />
              </div>
            )}
          </span>
          <button className="btn" onClick={() => setSegment("analytics")} title="Compare runs in Analytics">
            <Icon name="cmp" /> Compare
          </button>
          <button className="btn" onClick={onExport} disabled={exporting} title="Download run as JSON">
            <Icon name="dl" /> {exporting ? "Exporting…" : "Export"}
          </button>
          {exportErr && (
            <span className="hexp-err" role="alert" title={exportErr}>
              export failed — {exportErr}
            </span>
          )}
          <button className="btn primary" onClick={() => requestExplain(run.runId)}>
            <Icon name="spark" /> Explain
          </button>
        </span>
      </div>
      <div className="hmeta">
        <span>
          project <b>{projectOf(run.cwd)}</b>
        </span>
        <span>
          {live ? "active" : "ended"} <b>{relTime(run.lastTs, now)}</b>
        </span>
        <span>
          run <b>{run.runId}</b>
        </span>
        <span>
          ran <b>{ranText}</b>
        </span>
      </div>
      <div className="kpis">
        <Kpi k="cost" v={formatCost(run.costUsd)} />
        <Kpi k="duration" v={formatDuration(durationMs(run))} />
        <Kpi k="events" v={run.events.toLocaleString()} />
        <Kpi k="agents" v={String(run.agents.length)} />
        <Kpi k="errors" v={String(run.errors)} />
      </div>
      <div className="tabs2" role="tablist" onKeyDown={(e) => onTablistKey(e, TABS, runTab, setRunTab)}>
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={runTab === t}
            tabIndex={runTab === t ? 0 : -1}
            className={`tab2 ${runTab === t ? "on" : ""}`}
            onClick={() => setRunTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
