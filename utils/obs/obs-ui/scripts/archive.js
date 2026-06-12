// ── run archive (history beyond the live buffer) ─────────────────────────────
// The server keeps only a bounded ring of recent events, but it indexes the
// whole sink file by runId (/runs) and serves any run's events on demand
// (/events?run=<id>). These caches let the Trace and Stats views show runs
// that scrolled out of (or predate) the live SSE stream.

const archiveRuns = new Map(); // runId -> /runs summary
const archivedEvents = new Map(); // runId -> events[] (fetched on demand)
const archiveFetching = new Set(); // runIds with an in-flight fetch
const ARCHIVED_RUNS_MAX = 8; // fetched-run cache size (evict oldest)

function archiveRerender() {
    if (view === "trace") renderTrace();
    if (view === "stats") renderStats();
    if (view === "compare") renderCompare();
}

// Refresh the run list. Cheap (summaries only) — called on init and whenever
// the trace/stats views open.
function loadRunArchive() {
    fetch("/runs")
        .then((r) => r.json())
        .then((list) => {
            if (!Array.isArray(list)) return;
            for (const s of list) {
                archiveRuns.set(s.runId, s);
                if (s.verdict) recordVerdict(s.runId, s.verdict);
            }
            archiveRerender();
        })
        .catch(() => {
            /* server may predate /runs — archive simply stays empty */
        });
}

// Fetch one run's full event history (idempotent; re-renders on arrival).
function fetchArchivedRun(runId) {
    if (archivedEvents.has(runId) || archiveFetching.has(runId)) return;
    archiveFetching.add(runId);
    fetch("/events?run=" + encodeURIComponent(runId))
        .then((r) => r.json())
        .then((evs) => {
            const list = (Array.isArray(evs) ? evs : []).map(normalizeEvent);
            for (const ev of list)
                if (ev.type === "verdict")
                    recordVerdict(ev.runId, { ...(ev.payload || {}), ts: ev.ts });
            archivedEvents.set(runId, list);
            while (archivedEvents.size > ARCHIVED_RUNS_MAX) {
                archivedEvents.delete(archivedEvents.keys().next().value);
            }
            archiveRerender();
        })
        .catch(() => {
            /* leave unfetched; a later selection retries */
        })
        .finally(() => archiveFetching.delete(runId));
}

// Does the archive know more of this run than the lanes hold? (The ring /
// prime-tail can hold just a run's tail while the sink has all of it.)
function archiveHasMore(r) {
    const s = archiveRuns.get(r.id);
    return !!s && s.events > (r.count || 0);
}
