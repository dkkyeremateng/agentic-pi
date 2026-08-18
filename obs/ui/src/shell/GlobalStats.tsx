import { useMemo } from "react";
import { useLiveSessions, useRuns, useSummary } from "../data/queries";
import { useObs } from "../data/store";
import { collectAnalytics } from "../data/derive/analytics";
import { filterRuns } from "../runs/runUtils";
import { formatCost, formatTokens } from "../lib/format";

// Persistent cross-run telemetry strip in the app shell — glanceable on every
// segment. Reuses the already-cached runs list + live summary (no extra fetch).
export function GlobalStats() {
  const runsQ = useRuns();
  const sumQ = useSummary();
  const setSegment = useObs((s) => s.setSegment);
  const segment = useObs((s) => s.segment);
  const statusFilter = useObs((s) => s.runStatusFilter);
  const dateWin = useObs((s) => s.runDateWin);
  const projectFilter = useObs((s) => s.runProjectFilter);

  const runs = runsQ.data ?? [];
  const liveQ = useLiveSessions();
  const activeRunIds = useMemo(
    () => new Set((liveQ.data ?? []).map((s) => s.runId).filter((id): id is string => !!id)),
    [liveQ.data],
  );
  // On the Runs page the strip scopes to the inbox's active filter; elsewhere
  // (no filter UI visible) it reflects every run.
  const scoped = useMemo(
    () => (segment === "runs" ? filterRuns(runs, statusFilter, dateWin, Date.now(), projectFilter, activeRunIds) : runs),
    [runs, segment, statusFilter, dateWin, projectFilter, activeRunIds],
  );
  const a = useMemo(() => collectAnalytics(scoped), [scoped]);
  const live = (sumQ.data?.agents ?? []).filter((g) => g.active).length;

  // Hidden where it's noise: Analytics surfaces all of this already; Monitors and
  // Prompts are config/registry views where cross-run spend isn't the focus.
  if (segment === "analytics" || segment === "monitors" || segment === "prompts" || !runs.length)
    return null;

  const plural = (n: number) => (n === 1 ? "" : "s");
  const items: { k: string; v: string; cls?: string; title: string }[] = [
    { k: "runs", v: String(a.totalRuns), title: `${a.totalRuns} run${plural(a.totalRuns)} in view` },
    { k: "cost", v: formatCost(a.totalCost), title: "Total spend across these runs" },
    { k: "tokens", v: formatTokens(a.totalTokens), title: "Total tokens across these runs" },
    {
      // Denominator is SCORED runs, not every run — an unscored run is absent
      // from this figure entirely, so the tooltip has to name the base.
      k: "pass",
      v: a.scored ? `${Math.round(a.passRate * 100)}%` : "—",
      cls: a.scored && a.passRate < 1 ? "warn" : "ok",
      title: a.scored
        ? `${a.scored} of ${a.totalRuns} run${plural(a.totalRuns)} scored — ${Math.round(a.passRate * 100)}% of those passed their verdict`
        : "No runs scored yet",
    },
    {
      // Runs that hit ≥1 error, NOT a fail rate — an agent run routinely
      // recovers from a failed tool call and still passes, so this reads high
      // even when pass% is 100. Shown as a COUNT of runs, not a percentage:
      // "pass 100% · err 100.0%" side by side reads as a contradiction, and a
      // percentage of a single run is false precision anyway.
      k: "err runs",
      v: `${a.errRuns}/${a.totalRuns}`,
      cls: a.errRuns > 0 ? "warn" : undefined,
      title: `${a.errRuns} of ${a.totalRuns} run${plural(a.totalRuns)} hit at least one error (tool or provider). This is not a fail rate — a run can recover from an error and still pass its verdict.`,
    },
    { k: "live", v: String(live), cls: live > 0 ? "live" : undefined, title: `${live} agent${live === 1 ? "" : "s"} active right now` },
  ];

  return (
    <button className="gstats" onClick={() => setSegment("analytics")} title="Open analytics">
      <span className="gstat gtag">
        <i className="gdot" />
        telemetry
      </span>
      {items.map((it) => (
        <span className="gstat" key={it.k} title={it.title}>
          <i className="gk">{it.k}</i>
          <b className={`gv ${it.cls ?? ""}`}>{it.v}</b>
        </span>
      ))}
      <span className="ggo">analytics →</span>
    </button>
  );
}
