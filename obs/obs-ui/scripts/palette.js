// ── command palette (⌘K) — jump to a view, run, or project ──────────────────
// Sources: the seven views, known projects, and the newest runs from the
// server's archive index (so it works across everything ever recorded).
let palSel = 0;
let palShown = []; // currently rendered items

function palSources() {
    const items = [];
    const VIEWS = [
        ["swimlane", "Swimlane"],
        ["trace", "Timeline"],
        ["race", "Race"],
        ["single", "Events"],
        ["stats", "Stats"],
        ["compare", "Compare"],
        ["find", "Search"],
    ];
    for (const [k, label] of VIEWS)
        items.push({
            label: "Go to " + label,
            kind: "view",
            act: () => setView(k),
        });
    for (const p of projects)
        items.push({
            label: "Project: " + p,
            kind: "project",
            act: () => setProjectFilter(p === projectFilter ? "" : p),
        });
    const runs = [...archiveRuns.values()]
        .sort((a, b) => b.firstTs - a.firstTs)
        .slice(0, 40);
    for (const r of runs)
        items.push({
            label: r.name || r.runId,
            sub: verdictMark(r.runId) + fmtWhen(r.firstTs) + " · " + projectName(r.cwd),
            kind: "run",
            act: () => {
                traceRun = r.runId;
                setView("trace");
            },
        });
    return items;
}

function palRender() {
    const q = $("pal-q").value.trim().toLowerCase();
    const all = palSources();
    palShown = q
        ? all.filter((i) =>
              (i.label + " " + (i.sub || "")).toLowerCase().includes(q),
          )
        : all;
    palSel = Math.min(palSel, Math.max(0, palShown.length - 1));
    const list = $("pal-list");
    list.innerHTML = "";
    if (!palShown.length) {
        list.innerHTML = '<div class="pal-empty">no matches</div>';
        return;
    }
    palShown.forEach((item, i) => {
        const el = document.createElement("div");
        el.className = "pal-item" + (i === palSel ? " sel" : "");
        const lbl = document.createElement("span");
        lbl.textContent = item.label;
        el.appendChild(lbl);
        if (item.sub) {
            const sub = document.createElement("span");
            sub.className = "pal-sub";
            sub.textContent = item.sub;
            el.appendChild(sub);
        }
        const kind = document.createElement("span");
        kind.className = "pal-kind";
        kind.textContent = item.kind;
        el.appendChild(kind);
        el.addEventListener("click", () => palRun(i));
        el.addEventListener("mousemove", () => {
            if (palSel !== i) {
                palSel = i;
                palRender();
            }
        });
        list.appendChild(el);
    });
    const sel = list.children[palSel];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
}

function palRun(i) {
    const item = palShown[i];
    palClose();
    if (item) item.act();
}

function palOpen() {
    loadRunArchive(); // freshen the run list while the palette is up
    $("palette").hidden = false;
    $("pal-q").value = "";
    palSel = 0;
    palRender();
    $("pal-q").focus();
}

function palClose() {
    $("palette").hidden = true;
}

$("pal-open").addEventListener("click", palOpen);
$("pal-q").addEventListener("input", () => {
    palSel = 0;
    palRender();
});
$("pal-q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
        e.preventDefault();
        palSel = Math.min(palSel + 1, palShown.length - 1);
        palRender();
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        palSel = Math.max(palSel - 1, 0);
        palRender();
    } else if (e.key === "Enter") {
        palRun(palSel);
    } else if (e.key === "Escape") {
        palClose();
    }
});
// click on the dimmed backdrop closes; clicks inside the box don't bubble out
$("palette").addEventListener("click", (e) => {
    if (e.target === $("palette")) palClose();
});
window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if ($("palette").hidden) palOpen();
        else palClose();
    }
});
