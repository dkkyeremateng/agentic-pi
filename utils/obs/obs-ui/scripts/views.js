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
    for (const k of ["swimlane", "single", "race", "trace", "stats"]) {
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
}

