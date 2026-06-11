// ── projects + visibility ────────────────────────────────────────────────────
function maybeAddProject(p) {
    if (projects.has(p)) return;
    projects.add(p);
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    $("projfilter").appendChild(o);
    // keep the dropdown showing the restored filter once its project appears
    if (p === projectFilter) $("projfilter").value = projectFilter;
}
function laneInProject(a) {
    return !projectFilter || a.project === projectFilter;
}
// A lane is shown when it's in the active project AND not toggled off in the
// sidebar. (Sidebar buttons stay visible for out-of-project lanes? no — the
// project filter hides those buttons too; the sidebar toggle only hides cards.)
function laneVisible(a) {
    return laneInProject(a) && !hidden.has(a.key);
}

// Sidebar buttons mean different things per view: in Single the selected agent
// is highlighted (.on); in Swimlane/Race toggled-off agents are dimmed (.off).
function updateSidebarState() {
    for (const a of lanes.values()) {
        if (!a.btn) continue;
        if (view === "single") {
            // the one selected agent is highlighted
            a.btn.classList.remove("off");
            a.btn.classList.toggle("on", a.key === selected);
        } else {
            // swimlane/race: every included (shown) agent uses the same
            // highlighted style; hidden agents are dimmed
            const shown = !hidden.has(a.key);
            a.btn.classList.toggle("on", shown);
            a.btn.classList.toggle("off", !shown);
        }
    }
}

// Reflect project filter + per-agent sidebar toggles across every view.
function applyVisibility() {
    for (const a of lanes.values()) {
        if (a.card) a.card.el.style.display = laneVisible(a) ? "" : "none";
        if (a.btn) a.btn.style.display = laneInProject(a) ? "" : "none";
    }
    // keep Single on a visible agent
    const sel = selected && lanes.get(selected);
    if (sel && !laneVisible(sel)) {
        let next = null;
        for (const a of lanes.values())
            if (laneVisible(a)) {
                next = a;
                break;
            }
        selected = next ? next.key : null;
    }
    updateSidebarState();
    renderHeader();
    if (view === "race") renderRace();
    if (view === "single") renderSingle();
    if (view === "trace") renderTrace();
    if (view === "stats") renderStats();
}

// ── state plumbing ───────────────────────────────────────────────────────────
function ensureLane(ev) {
    const key = laneKey(ev);
    let a = lanes.get(key);
    if (a) return a;
    a = {
        key,
        agent: ev.agent,
        sessionId: ev.sessionId || "",
        label: ev.agent, // display name; gets a "#n" suffix when the agent has siblings
        ord: laneOrd++,
        cwd: ev.cwd || "",
        project: projectName(ev.cwd),
        events: [],
        rollup: newRollup(),
        card: null,
        btn: null,
        count: 0, // total events seen (uncapped, for header)
        firstTs: null,
        lastTs: null,
    };
    lanes.set(key, a);
    maybeAddProject(a.project);
    buildLaneCard(a);
    buildSidebarBtn(a);
    // A new instance can turn "scout" into "scout #1/#2…" — refresh the group.
    refreshGroupLabels(a);
    if (!laneInProject(a)) a.btn.style.display = "none";
    if (!laneVisible(a)) a.card.el.style.display = "none";
    updateSidebarState(); // highlight the new button for the current view
    return a;
}

function buildSidebarBtn(a) {
    const btn = document.createElement("button");
    btn.className = "sbtn";
    btn.title = a.project + " / " + a.label + " — click to show/hide";
    btn.textContent = a.agent.slice(0, 1).toUpperCase();
    const dot = document.createElement("span");
    dot.className = "live-dot";
    btn.appendChild(dot);
    btn.addEventListener("click", () => {
        if (view === "single") {
            // single-select: pick this agent, or deselect if it's already shown
            selected = selected === a.key ? null : a.key;
            updateSidebarState();
            renderSingle();
        } else {
            // swimlane/race: toggle this agent's lane in/out of the view
            if (hidden.has(a.key)) hidden.delete(a.key);
            else hidden.add(a.key);
            applyVisibility();
        }
    });
    $("sbtns").appendChild(btn);
    a.btn = btn;
}

function buildLaneCard(a) {
    $("empty").style.display = "none";
    const el = document.createElement("div");
    el.className = "lane";
    el.innerHTML =
        '<div class="lane-head"><span class="dot"></span>' +
        '<span class="agent"></span><span class="proj-tag"></span>' +
        '<span class="lane-meta"></span></div><div class="feed"></div>';
    el.querySelector(".agent").textContent = a.label;
    el.querySelector(".proj-tag").textContent = a.project;
    el.querySelector(".lane-head").addEventListener("click", () =>
        selectLane(a.key),
    );
    $("lanes").appendChild(el);
    a.card = {
        el,
        feed: el.querySelector(".feed"),
        agentEl: el.querySelector(".agent"),
        meta: el.querySelector(".lane-meta"),
    };
}

function laneMeta(a) {
    const r = a.rollup;
    const errs = r.toolErrors + r.errors;
    a.card.el.classList.toggle("active", r.active);
    a.card.meta.textContent =
        r.turns +
        "t · " +
        r.toolCalls +
        " tools" +
        (errs ? " · " + errs + " err" : "") +
        " · " +
        fmtTok(r.tokens) +
        " · " +
        fmtCost(r.costUsd) +
        (r.ctxPercent != null ? " · ctx " + Math.round(r.ctxPercent) + "%" : "");
}

function passesFilter(ev) {
    if (!filters.has(categoryOf(ev))) return false;
    if (search) {
        const { badge, detail } = describe(ev);
        if (!(badge + " " + detail).toLowerCase().includes(search)) return false;
    }
    return true;
}

// ── ingest ───────────────────────────────────────────────────────────────────
function handle(ev) {
    const a = ensureLane(ev);
    a.count++;
    if (a.firstTs === null || ev.ts < a.firstTs) a.firstTs = ev.ts;
    if (a.lastTs === null || ev.ts > a.lastTs) a.lastTs = ev.ts;
    a.events.push(ev);
    if (a.events.length > EVENTS_CAP) a.events.shift();
    applyRollup(a.rollup, ev);

    a.card.feed.appendChild(makeRow(ev, false));
    while (a.card.feed.childElementCount > FEED_MAX)
        a.card.feed.removeChild(a.card.feed.firstChild);
    laneMeta(a);
    if (a.btn) a.btn.classList.toggle("active", a.rollup.active);

    if (view === "single" && a.key === selected && passesFilter(ev)) {
        $("single-feed").appendChild(makeRow(ev, true));
        if (autoscroll) window.scrollTo(0, document.body.scrollHeight);
        renderStatbar();
    }
    if (view === "race") scheduleRace();
    if (view === "trace") scheduleTrace();
    if (view === "stats") scheduleStats();
}

// Coalesce Race re-renders to one per animation frame under a busy stream.
let raceDirty = false;
function scheduleRace() {
    if (raceDirty) return;
    raceDirty = true;
    requestAnimationFrame(() => {
        raceDirty = false;
        if (view === "race") renderRace();
    });
}

// Coalesce Trace re-renders likewise.
let traceDirty = false;
function scheduleTrace() {
    if (traceDirty) return;
    traceDirty = true;
    requestAnimationFrame(() => {
        traceDirty = false;
        if (view === "trace") renderTrace();
    });
}

// Stats re-renders are heavier; coalesce and throttle to ~1.5s under a busy stream.
let statsDirty = false;
let statsLast = 0;
function scheduleStats() {
    if (statsDirty) return;
    statsDirty = true;
    const wait = Math.max(0, 1500 - (Date.now() - statsLast));
    setTimeout(() => {
        statsDirty = false;
        statsLast = Date.now();
        if (view === "stats") renderStats();
    }, wait);
}

