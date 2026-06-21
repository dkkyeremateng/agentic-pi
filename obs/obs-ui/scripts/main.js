// ── auto-scroll pause/resume (single view) ───────────────────────────────────
// #content is the scroll container (the app shell pins header/rail/statusbar).
function nearBottom() {
    const c = $("content");
    return c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
}
$("content").addEventListener("scroll", () => {
    if (view !== "single") return;
    if (nearBottom()) {
        autoscroll = true;
        $("resume").classList.remove("show");
    } else {
        autoscroll = false;
        $("resume").classList.add("show");
    }
});

// ── SSE ──────────────────────────────────────────────────────────────────────
// EventSource auto-reconnects on stream drops, but Chrome gives up PERMANENTLY
// when a retry hits connection-refused (a server restart longer than its retry
// interval) — so we recreate the source ourselves. Replays after reconnect are
// deduped per lane by seq (handle()).
let sseRetryTimer = null;
function connect() {
    const es = new EventSource(ObsAuth.streamUrl("/stream"));
    es.addEventListener("open", () => {
        $("conn").textContent = "live";
        $("conn").classList.add("up");
    });
    es.addEventListener("error", () => {
        $("conn").textContent = "reconnecting…";
        $("conn").classList.remove("up");
        if (es.readyState === EventSource.CLOSED && !sseRetryTimer) {
            sseRetryTimer = setTimeout(() => {
                sseRetryTimer = null;
                connect();
            }, 2000);
        }
    });
    es.addEventListener("obs", (e) => {
        try {
            handle(normalizeEvent(JSON.parse(e.data)));
        } catch {
            /* ignore */
        }
    });
}

// ── init ─────────────────────────────────────────────────────────────────────
$("v-swimlane").addEventListener("click", () => setView("swimlane"));
// Trace / Race / Single are tabs of the run-detail page (#runtabs)
for (const tb of document.querySelectorAll("#runtabs .runtab"))
    tb.addEventListener("click", () => setView(tb.dataset.view));
// (the trace run picker is a combobox now — wired in trace.js)
$("trace-scrub").addEventListener("input", (e) => {
    traceSetReplay(Number(e.target.value));
});
$("v-stats").addEventListener("click", () => setView("stats"));
// (the stats run picker is a combobox now — wired in stats.js)
$("v-compare").addEventListener("click", () => setView("compare"));
$("v-find").addEventListener("click", () => setView("find"));
$("find-go").addEventListener("click", runFind);
$("find-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFind();
});
// (A/B pickers are comboboxes now — wired in compare.js)
$("cmp-swap").addEventListener("click", () => {
    // swap what is actually rendered (the pins may be "" = defaults)
    const a = cmpCurrentA;
    cmpA = cmpCurrentB;
    cmpB = a;
    renderCompare();
    syncHash();
});

// ── trace export ──────────────────────────────────────────────────────────────
function downloadBlob(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 0);
}
$("trace-otlp").addEventListener("click", () => {
    if (!traceCurrentRun) return;
    // Server-side OTLP conversion (download triggered by Content-Disposition).
    const a = document.createElement("a");
    a.href =
        "/otel?run=" + encodeURIComponent(traceCurrentRun) + "&download=1";
    a.download = "otel-" + traceCurrentRun + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
});
$("trace-json").addEventListener("click", () => {
    if (!traceCurrentRun) return;
    // Raw events for this run, gathered client-side from the lanes — or from
    // the fetched archive when it holds more than the live buffer.
    let evs = [];
    for (const lane of lanes.values())
        for (const ev of lane.events)
            if (ev.runId === traceCurrentRun) evs.push(ev);
    const arch = archivedEvents.get(traceCurrentRun);
    if (arch && arch.length > evs.length) evs = arch.slice();
    evs.sort((x, y) => x.ts - y.ts);
    downloadBlob(
        "run-" + traceCurrentRun + ".jsonl",
        evs.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "application/x-ndjson",
    );
});
// Header project + run filters are comboboxes (uniform with Trace/Stats/Compare).
projfilterCombo = makeCombo({
    input: $("projfilter-q"),
    list: $("projfilter-list"),
    onPick: (v) => setProjectFilter(v),
});
runfilterCombo = makeCombo({
    input: $("runfilter-q"),
    list: $("runfilter-list"),
    onPick: (v) => {
        runFilter = v;
        runFilterAuto = false; // an explicit choice (incl. "all runs") pins it
        applyVisibility();
    },
});
datefilterCombo = makeCombo({
    input: $("datefilter-q"),
    list: $("datefilter-list"),
    onPick: (v) => setDateFilter(v),
});
$("search").addEventListener("input", (e) => {
    search = e.target.value.trim().toLowerCase();
    renderSingle();
});
$("f-regex").addEventListener("click", () => {
    searchRegex = !searchRegex;
    $("f-regex").classList.toggle("on", searchRegex);
    renderSingle();
});
$("f-errors").addEventListener("click", () => {
    errorsOnly = !errorsOnly;
    $("f-errors").classList.toggle("on", errorsOnly);
    renderSingle();
});
$("resume").addEventListener("click", () => {
    autoscroll = true;
    $("resume").classList.remove("show");
    $("content").scrollTop = $("content").scrollHeight;
});
$("insp-close").addEventListener("click", closeInspector);
$("insp-copy").addEventListener("click", () => {
    if (navigator.clipboard)
        navigator.clipboard.writeText($("insp-json").textContent);
    const b = $("insp-copy"); // icon button — flash green instead of relabeling
    b.classList.add("flash");
    setTimeout(() => b.classList.remove("flash"), 1000);
});
window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInspector();
});
// Clicking outside an expanded turn (not on a turn, agent card, inspector, or
// header) zooms out — collapses the expanded turn(s).
document.addEventListener("click", (e) => {
    if (view !== "race") return;
    if (
        e.target.closest(".race-turn") ||
        e.target.closest(".race-agent") ||
        e.target.closest("#inspector") ||
        e.target.closest("header")
    )
        return;
    let changed = false;
    for (const a of lanes.values()) {
        if (laneVisible(a) && a.activeTurn != null) {
            a.activeTurn = null;
            a.followLatest = false;
            changed = true;
        }
    }
    if (changed) renderRace();
});
buildChips();
// restore the project filter from a previous session — a saved value (including
// "" for an explicit "all projects") is an explicit choice, so it pins the auto
// default off; only a never-set filter auto-scopes to the active project.
try {
    const saved = localStorage.getItem("obs.projectFilter");
    if (saved !== null) {
        projectFilter = saved;
        projectFilterAuto = false;
    }
} catch {
    /* ignore — projectFilter stays "" with auto on */
}
// restore the recency window (defaults to "max" = all time)
try {
    const savedDate = localStorage.getItem("obs.dateFilter");
    if (savedDate === "max" || DATE_WINDOWS[savedDate]) dateFilter = savedDate;
} catch {
    /* ignore — dateFilter stays "max" */
}
if (projectFilter) maybeAddProject(projectFilter); // ensure the option exists
renderProjectFilter(); // paint the project combo (incl. its restored selection)
renderDateFilter(); // paint the date combo (incl. its restored selection)
updateRunFilter(); // show the run picker if a project was restored
applyHash(); // permalink state (view/project/pinned runs) — beats localStorage
window.addEventListener("hashchange", applyHash);
setInterval(renderHeader, 500);
connect();
loadRunArchive(); // run history beyond the live buffer (sink-file index)

