// ── auto-scroll pause/resume (single view) ───────────────────────────────────
function nearBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
}
window.addEventListener("scroll", () => {
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
            handle(JSON.parse(e.data));
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
});
$("v-stats").addEventListener("click", () => setView("stats"));
$("stats-run").addEventListener("change", (e) => {
    statsRun = e.target.value;
    renderStats();
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
    // Raw events for this run, gathered client-side from the lanes.
    const evs = [];
    for (const lane of lanes.values())
        for (const ev of lane.events)
            if (ev.runId === traceCurrentRun) evs.push(ev);
    evs.sort((x, y) => x.ts - y.ts);
    downloadBlob(
        "run-" + traceCurrentRun + ".jsonl",
        evs.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "application/x-ndjson",
    );
});
$("projfilter").addEventListener("change", (e) => {
    projectFilter = e.target.value;
    try {
        localStorage.setItem("obs.projectFilter", projectFilter);
    } catch {
        /* ignore */
    }
    applyVisibility();
});
$("search").addEventListener("input", (e) => {
    search = e.target.value.trim().toLowerCase();
    renderSingle();
});
$("resume").addEventListener("click", () => {
    autoscroll = true;
    $("resume").classList.remove("show");
    window.scrollTo(0, document.body.scrollHeight);
});
$("insp-close").addEventListener("click", closeInspector);
$("insp-copy").addEventListener("click", () => {
    if (navigator.clipboard)
        navigator.clipboard.writeText($("insp-json").textContent);
    const b = $("insp-copy");
    b.textContent = "copied";
    setTimeout(() => (b.textContent = "copy"), 1000);
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
setInterval(renderHeader, 500);
connect();

