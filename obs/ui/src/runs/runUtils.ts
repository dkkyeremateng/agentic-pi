import type { RunMeta } from "../data/types";
import { projectOf, runStatus, type RunStatus } from "../lib/format";

export const LIVE_WINDOW_MS = 60_000;

export function isLive(run: RunMeta, now = Date.now()): boolean {
  return now - run.lastTs < LIVE_WINDOW_MS;
}

export function statusOf(run: RunMeta, now = Date.now()): RunStatus {
  return runStatus(run.verdict?.status, isLive(run, now));
}

// What a run is called: its session name, else the root's first request, else
// the project (the last makes a list of same-project runs indistinguishable).
export function runTitle(run: RunMeta): string {
  return run.name?.trim() || run.request?.trim() || projectOf(run.cwd);
}

// The project a run belongs to — shown as a secondary tag now that the title is
// the request rather than the project name.
export function runProject(run: RunMeta): string {
  return projectOf(run.cwd);
}

export function durationMs(run: RunMeta): number {
  return Math.max(0, run.lastTs - run.firstTs);
}

// ── noise / search ───────────────────────────────────────────────────────────
// A "no-op" run took no notable action: it's finished, ran no tools, hit no
// errors, and wasn't a fail/paused outcome — a throwaway conversational session.
// (Verdict presence alone isn't a signal: auto-verdict marks nearly every ended
// run "pass", so tool usage is what separates real work from chat.) Semantic, no
// cost/time thresholds. Hidden by default but toggleable; live runs and anything
// that acted, failed, or was paused are always kept.
export function isNoopRun(run: RunMeta, now = Date.now()): boolean {
  if (isLive(run, now)) return false;
  if (run.errors > 0) return false;
  const v = run.verdict?.status;
  if (v === "fail" || v === "paused") return false;
  return (run.toolCalls ?? 0) === 0;
}

// Substring match over the fields a person would search a run by.
export function matchesRunSearch(run: RunMeta, query: string): boolean {
  const s = query.trim().toLowerCase();
  if (!s) return true;
  return (
    runTitle(run).toLowerCase().includes(s) ||
    runProject(run).toLowerCase().includes(s) ||
    run.runId.toLowerCase().includes(s) ||
    (run.request ?? "").toLowerCase().includes(s) ||
    run.agents.some((a) => a.toLowerCase().includes(s))
  );
}

// ── time-bucket grouping (inbox headers) ─────────────────────────────────────
// Group a (newest-first) run list into calendar buckets so a long same-project
// list scans by recency. Order is fixed; empty buckets are dropped; each run
// keeps its incoming order within its bucket.
export interface RunGroup {
  key: string;
  label: string;
  runs: RunMeta[];
}
export function groupRunsByTime(runs: RunMeta[], now = Date.now()): RunGroup[] {
  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const DAY = 86_400_000;
  // descending `min` so the first match is the tightest bucket
  const defs = [
    { key: "today", label: "Today", min: startOfToday },
    { key: "yesterday", label: "Yesterday", min: startOfToday - DAY },
    { key: "7d", label: "Previous 7 days", min: startOfToday - 7 * DAY },
    { key: "30d", label: "Previous 30 days", min: startOfToday - 30 * DAY },
    { key: "older", label: "Older", min: -Infinity },
  ];
  const out: RunGroup[] = defs.map((x) => ({ key: x.key, label: x.label, runs: [] }));
  for (const r of runs) {
    const i = defs.findIndex((x) => r.firstTs >= x.min);
    out[i].runs.push(r);
  }
  return out.filter((g) => g.runs.length > 0);
}

// ── recency (date) filter ────────────────────────────────────────────────────
// Caps the run list to those whose last activity is within a window. "max" = all.
export type DateWin = "1d" | "1w" | "1m" | "max";
export const DATE_WINDOWS: Record<Exclude<DateWin, "max">, number> = {
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1m": 2_592_000_000,
};
export const DATE_LABELS: Record<DateWin, string> = {
  "1d": "1 day",
  "1w": "1 week",
  "1m": "1 month",
  max: "max",
};

export function withinDateWin(run: RunMeta, win: DateWin, now = Date.now()): boolean {
  if (win === "max") return true;
  return now - run.lastTs <= DATE_WINDOWS[win];
}

// The runs inbox filters: a status facet + the recency window. Shared so the
// list and the telemetry strip scope to the same set. "active" = the run still
// has an OPEN pi session (its process is alive and heartbeating) — sourced from
// the live-sessions registry via `activeRunIds`, not from recent activity, so an
// idle-but-open session still counts and a finished one drops out immediately.
// (The "live" RunStatus — events within LIVE_WINDOW_MS — still drives card
// badges; it's just no longer a separate inbox facet now "active" is precise.)
export type RunStatusFilter = "all" | "active" | "pass" | "fail";

export function filterRuns(
  runs: RunMeta[],
  status: RunStatusFilter,
  win: DateWin,
  now = Date.now(),
  project = "all",
  activeRunIds?: ReadonlySet<string>,
): RunMeta[] {
  return runs.filter((r) => {
    if (project !== "all" && projectOf(r.cwd) !== project) return false;
    // openness is independent of recency — an open session shows regardless of
    // how long it's been idle, so the date window doesn't gate the active facet.
    if (status === "active") return !!activeRunIds?.has(r.runId);
    if (!withinDateWin(r, win, now)) return false;
    if (status === "all") return true;
    return statusOf(r, now) === status;
  });
}

// Which windows are worth offering. A window appears only when it's both
// non-empty and non-redundant: at least one run falls WITHIN it (so selecting it
// isn't empty) AND at least one run is OLDER than it (so it excludes something —
// otherwise it's identical to "max"). "max" always appears.
export function availableDateWins(runs: RunMeta[], now = Date.now()): DateWin[] {
  const ages = runs.map((r) => now - r.lastTs);
  const wins = (["1d", "1w", "1m"] as const).filter(
    (w) =>
      ages.some((a) => a <= DATE_WINDOWS[w]) &&
      ages.some((a) => a > DATE_WINDOWS[w]),
  );
  return [...wins, "max"];
}
