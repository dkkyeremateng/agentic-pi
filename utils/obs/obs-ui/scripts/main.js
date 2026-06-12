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
function connect() {
    const es = new EventSource("/stream");
    es.addEventListener("open", () => {
        $("conn").textContent = "live";
        $("conn").classList.add("up");
    });
    es.addEventListener("error", () => {
        $("conn").textContent = "reconnecting…";
        $("conn").classList.remove("up");
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
$("v-single").addEventListener("click", () => setView("single"));
$("v-race").addEventListener("click", () => setView("race"));
$("v-trace").addEventListener("click", () => setView("trace"));
$("trace-run").addEventListener("change", (e) => {
    traceRun = e.target.value;
    renderTrace();
    syncHash();
});
$("trace-scrub").addEventListener("input", (e) => {
    traceSetReplay(Number(e.target.value));
});
$("v-stats").addEventListener("click", () => setView("stats"));
$("stats-run").addEventListener("change", (e) => {
    statsRun = e.target.value;
    renderStats();
    syncHash();
});
$("v-compare").addEventListener("click", () => setView("compare"));
$("v-find").addEventListener("click", () => setView("find"));
$("find-go").addEventListener("click", runFind);
$("find-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFind();
});
$("cmp-a").addEventListener("change", (e) => {
    cmpA = e.target.value;
    renderCompare();
    syncHash();
});
$("cmp-b").addEventListener("change", (e) => {
    cmpB = e.target.value;
    renderCompare();
    syncHash();
});
$("cmp-swap").addEventListener("click", () => {
    const a = $("cmp-a").value;
    cmpA = $("cmp-b").value;
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
$("projfilter").addEventListener("change", (e) => {
    projectFilter = e.target.value;
    runFilter = ""; // the previous run belongs to the previous project
    runFilterAuto = true; // re-follow the live/last run in the new project
    try {
        localStorage.setItem("obs.projectFilter", projectFilter);
    } catch {
        /* ignore */
    }
    applyVisibility();
    syncHash();
});
$("runfilter").addEventListener("change", (e) => {
    runFilter = e.target.value;
    runFilterAuto = false; // an explicit choice (incl. "all runs") pins it
    applyVisibility();
});
$("search").addEventListener("input", (e) => {
    search = e.target.value.trim().toLowerCase();
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
// restore the project filter from a previous session
try {
    projectFilter = localStorage.getItem("obs.projectFilter") || "";
} catch {
    projectFilter = "";
}
if (projectFilter) {
    maybeAddProject(projectFilter); // ensure the option exists + selected
    $("projfilter").value = projectFilter;
}
updateRunFilter(); // show the run picker if a project was restored
applyHash(); // permalink state (view/project/pinned runs) — beats localStorage
window.addEventListener("hashchange", applyHash);
setInterval(renderHeader, 500);
connect();
loadRunArchive(); // run history beyond the live buffer (sink-file index)

