import { useEffect, useMemo } from "react";
import type { RunMeta } from "../data/types";
import { useObs } from "../data/store";
import { RunCard } from "./RunCard";
import { RunTimelineStrip } from "./RunTimelineStrip";
import { availableDateWins, filterRuns, groupRunsByTime, isNoopRun, matchesRunSearch, DATE_LABELS, type RunStatusFilter } from "./runUtils";
import { Icon } from "../lib/Icon";
import { projectOf } from "../lib/format";
import { Combo } from "../lib/Combo";

const FILTERS: { id: RunStatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "pass", label: "Pass" },
  { id: "fail", label: "Fail" },
];

export function RunsInbox({
  runs,
  loading,
  selectedId,
  onSelect,
  activeRunIds,
}: {
  runs: RunMeta[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  activeRunIds: ReadonlySet<string>;
}) {
  // Filters live in the store so the telemetry strip scopes to the same set.
  const filter = useObs((s) => s.runStatusFilter);
  const setFilter = useObs((s) => s.setRunStatusFilter);
  const dateWin = useObs((s) => s.runDateWin);
  const setDateWin = useObs((s) => s.setRunDateWin);
  const project = useObs((s) => s.runProjectFilter);
  const setProject = useObs((s) => s.setRunProjectFilter);
  const hideNoops = useObs((s) => s.runHideNoops);
  const setHideNoops = useObs((s) => s.setRunHideNoops);
  const search = useObs((s) => s.runSearch);
  const setSearch = useObs((s) => s.setRunSearch);

  // Recency windows worth offering for the current run set (+ "max").
  const dateWins = useMemo(() => availableDateWins(runs), [runs]);
  // If the active window stops being offered (its runs aged out), fall back to
  // "max" so we never sit on an empty, hidden selection.
  useEffect(() => {
    if (!dateWins.includes(dateWin)) setDateWin("max");
  }, [dateWins, dateWin, setDateWin]);
  const effectiveWin = dateWins.includes(dateWin) ? dateWin : "max";

  // Project filter — from the runs' cwd. Reset to "all" if the chosen project
  // is gone from the index.
  const projects = useMemo(
    () => [...new Set(runs.map((r) => projectOf(r.cwd)))].sort(),
    [runs],
  );
  useEffect(() => {
    if (project !== "all" && !projects.includes(project)) setProject("all");
  }, [projects, project, setProject]);
  const projectOptions = useMemo(
    () => [{ value: "all", label: "All projects" }, ...projects.map((p) => ({ value: p, label: p }))],
    [projects],
  );

  // status/date/project filter → text search → (optionally) fold no-op runs
  const matched = useMemo(
    () =>
      filterRuns(runs, filter, effectiveWin, Date.now(), project, activeRunIds)
        .filter((r) => matchesRunSearch(r, search))
        .sort((a, b) => b.firstTs - a.firstTs),
    [runs, filter, effectiveWin, project, search, activeRunIds],
  );
  const noopCount = useMemo(() => (hideNoops ? matched.filter((r) => isNoopRun(r)).length : 0), [matched, hideNoops]);
  const shown = useMemo(() => (hideNoops ? matched.filter((r) => !isNoopRun(r)) : matched), [matched, hideNoops]);
  const groups = useMemo(() => groupRunsByTime(shown), [shown]);

  // j / k move the run selection through the visible list (skipped while typing
  // in a field, or with a modifier held, so it never eats ⌘K or a search key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const flat = groups.flatMap((g) => g.runs);
      if (!flat.length) return;
      const idx = flat.findIndex((r) => r.runId === selectedId);
      const next = e.key === "j" ? flat[idx < 0 ? 0 : Math.min(flat.length - 1, idx + 1)] : flat[Math.max(0, (idx < 0 ? 0 : idx) - 1)];
      if (next) {
        e.preventDefault();
        onSelect(next.runId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, selectedId, onSelect]);

  return (
    <div className="pane">
      <div className="px ph">
        <h2>Runs</h2>
        <div className="ph-right">
          {dateWins.length > 1 && (
            <div className="fgroup dates" title="recency window">
              {dateWins.map((w) => (
                <button key={w} className={`fchip ${effectiveWin === w ? "on" : ""}`} onClick={() => setDateWin(w)}>
                  {DATE_LABELS[w]}
                </button>
              ))}
            </div>
          )}
          <span className="count">
            {loading ? "loading…" : shown.length === runs.length ? `${runs.length} indexed` : `${shown.length} of ${runs.length}`}
          </span>
        </div>
      </div>
      <RunTimelineStrip runs={runs} selectedId={selectedId} onSelect={onSelect} />
      {projects.length > 1 && (
        <div className="projsel">
          <Combo value={project} options={projectOptions} onChange={setProject} width="100%" ariaLabel="Filter runs by project" />
        </div>
      )}
      <div className="runsearch">
        <Icon name="search" size={13} />
        <input value={search} placeholder="Search runs…" onChange={(e) => setSearch(e.target.value)} />
        {search && (
          <button className="runsearch-x" title="Clear" onClick={() => setSearch("")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {/* status facet — its own row; recency window lives up in the header */}
      <div className="filterbar">
        <div className="fgroup">
          {FILTERS.map((f) => (
            <button key={f.id} className={`fchip ${filter === f.id ? "on" : ""}`} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id === "active" && activeRunIds.size > 0 && <span className="fchip-n">{activeRunIds.size}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="runs">
        {shown.length === 0 && !loading && (
          <div className="empty">
            {search ? (
              "No runs match your search."
            ) : filter === "active" ? (
              <>
                No open sessions — nothing is running right now.
                <button className="empty-act" onClick={() => setFilter("all")}>
                  Show all runs
                </button>
              </>
            ) : (
              `No ${filter === "all" ? "" : filter + " "}runs.`
            )}
          </div>
        )}
        {(noopCount > 0 || !hideNoops) && (
          <button className="noopbar" onClick={() => setHideNoops(!hideNoops)}>
            {hideNoops ? `Show ${noopCount} low-signal run${noopCount === 1 ? "" : "s"}` : "Hide low-signal runs"}
          </button>
        )}
        {groups.map((g) => (
          <div className="rungrp" key={g.key}>
            <div className="rungrp-hd">
              {g.label}
              <span className="rungrp-n">{g.runs.length}</span>
            </div>
            {g.runs.map((r) => (
              <RunCard key={r.runId} run={r} selected={r.runId === selectedId} active={activeRunIds.has(r.runId)} onSelect={() => onSelect(r.runId)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
