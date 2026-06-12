// ── chips / search / view toggle ─────────────────────────────────────────────
function buildChips() {
    const wrap = $("chips");
    for (const [key, label] of CATS) {
        const c = document.createElement("span");
        c.className = "chip on";
        c.textContent = label;
        c.addEventListener("click", () => {
            if (filters.has(key)) filters.delete(key);
            else filters.add(key);
            c.classList.toggle("on", filters.has(key));
            renderSingle();
        });
        wrap.appendChild(c);
    }
    const all = document.createElement("span");
    all.className = "chip act";
    all.textContent = "+ all";
    all.addEventListener("click", () => {
        for (const [k] of CATS) filters.add(k);
        document
            .querySelectorAll("#chips .chip:not(.act)")
            .forEach((c) => c.classList.add("on"));
        renderSingle();
    });
    const none = document.createElement("span");
    none.className = "chip act";
    none.textContent = "− all";
    none.addEventListener("click", () => {
        filters.clear();
        document
            .querySelectorAll("#chips .chip:not(.act)")
            .forEach((c) => c.classList.remove("on"));
        renderSingle();
    });
    wrap.append(all, none);
}

function setView(v) {
    view = v;
    for (const k of [
        "swimlane",
        "single",
        "race",
        "trace",
        "stats",
        "compare",
        "find",
    ]) {
        $("v-" + k).classList.toggle("on", v === k);
        $(k).classList.toggle("on", v === k);
    }
    if (v === "single") {
        const cur = selected && lanes.get(selected);
        if (cur && !laneVisible(cur)) selected = null;
        renderSingle();
    }
    updateSidebarState();
    updateRunFilter(); // shown only on the lane views (swimlane/single/race)
    if (v === "race") renderRace();
    if (v === "trace") renderTrace();
    if (v === "stats") renderStats();
    if (v === "compare") renderCompare();
    // Refresh the archive's run list when a run picker comes into view.
    if (v === "trace" || v === "stats" || v === "compare") loadRunArchive();
    syncHash();
}

// ── permalinks (URL hash state) ──────────────────────────────────────────────
// view / project / pinned runs live in location.hash so any dashboard state can
// be bookmarked or pasted between terminals. replaceState keeps Back usable.
let hashApplying = false; // applying the hash must not rewrite it mid-apply

function syncHash() {
    if (hashApplying) return;
    const p = new URLSearchParams();
    if (view !== "swimlane") p.set("view", view);
    if (projectFilter) p.set("project", projectFilter);
    if (typeof traceRun === "string" && traceRun) p.set("run", traceRun);
    if (typeof statsRun === "string" && statsRun) p.set("stats", statsRun);
    if (typeof cmpA === "string" && cmpA) p.set("a", cmpA);
    if (typeof cmpB === "string" && cmpB) p.set("b", cmpB);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname);
}

function applyHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return;
    const p = new URLSearchParams(h);
    hashApplying = true;
    try {
        const proj = p.get("project");
        if (proj) {
            projectFilter = proj;
            maybeAddProject(proj); // ensure the option exists + selected
            $("projfilter").value = proj;
            applyVisibility();
        }
        if (p.get("run")) traceRun = p.get("run");
        if (p.get("stats")) statsRun = p.get("stats");
        if (p.get("a")) cmpA = p.get("a");
        if (p.get("b")) cmpB = p.get("b");
        const v = p.get("view");
        if (v && $("v-" + v)) setView(v);
    } finally {
        hashApplying = false;
    }
    syncHash(); // normalize once applied
}

