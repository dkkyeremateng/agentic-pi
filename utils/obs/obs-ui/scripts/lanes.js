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
// The run filter scopes the lane views to one run (sessions are single-run). Only
// meaningful within a single project, where the header run picker is shown.
function laneInRun(a) {
    return !runFilter || a.runId === runFilter;
}
// In scope = passes both the project and the run filter (used for sidebar buttons).
function laneInScope(a) {
    return laneInProject(a) && laneInRun(a);
}
// A lane is shown when it's in scope AND not toggled off in the sidebar.
function laneVisible(a) {
    return laneInScope(a) && !hidden.has(a.key);
}

// Populate + show the header run filter. Runs are project-scoped, so it only
// applies when a single project is selected; it's hidden for "all projects".
// Populate + show the header run filter; returns true if the selection changed.
function updateRunFilter() {
    const rf = $("runfilter");
    const wrap = $("runfilter-wrap");
    const dot = $("run-dot");
    if (!rf) return false;
    const prev = runFilter;
    // Only for the lane views; Trace and Stats have their own per-view run pickers.
    const show =
        projectFilter !== "" && view !== "trace" && view !== "stats";
    if (wrap) wrap.style.display = show ? "flex" : "none";
    if (!show) return false;
    const list = [...collectRuns().values()].sort((a, b) => b.lastTs - a.lastTs);

    // Which runs are live (any of their lanes still active).
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup.active && a.runId) live.add(a.runId);

    // With only one run "all runs" is redundant — omit it and scope to that run.
    const single = list.length === 1;
    if (runFilterAuto) {
        // Default to the live run (latest still-running), else the last run.
        const def = list.find((r) => live.has(r.id)) || list[0];
        runFilter = def ? def.id : "";
    } else if (single) {
        runFilter = list[0].id; // only one run — always scoped to it
    } else if (runFilter && !list.some((r) => r.id === runFilter)) {
        runFilter = ""; // a pinned run vanished
    }

    rf.innerHTML = "";
    if (!single) {
        const all = document.createElement("option");
        all.value = "";
        all.textContent = "all runs";
        rf.appendChild(all);
    }
    list.forEach((r, i) => {
        const o = document.createElement("option");
        o.value = r.id;
        const isLive = live.has(r.id);
        // <option>s can't hold the agent's styled dot; greening the text + a "live"
        // suffix flags live runs in the open list. The agent-style dot beside the
        // select (below) is the indicator for the selected run.
        if (isLive) o.style.color = "var(--ok)";
        const when = new Date(r.firstTs).toTimeString().slice(0, 8);
        o.textContent =
            when +
            " · " +
            r.agents.size +
            " agents" +
            (isLive ? " · live" : "");
        rf.appendChild(o);
    });
    rf.value = runFilter;
    // The agent-style green dot next to the picker lights when the selected run is
    // live (or, for "all runs", when any run is live) — the same .dot.on used on
    // the agent cards.
    if (dot)
        dot.classList.toggle(
            "on",
            runFilter ? live.has(runFilter) : live.size > 0,
        );
    return runFilter !== prev;
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

// Reflect project + run filters and per-agent sidebar toggles across every view.
function applyVisibility() {
    updateRunFilter();
    // Re-label agent groups for the current scope so "#n" only appears when an
    // agent has several in-scope instances (one per dedup key is enough).
    const relabeled = new Set();
    for (const a of lanes.values()) {
        const k = a.cwd + "|" + a.agent;
        if (!relabeled.has(k)) {
            relabeled.add(k);
            refreshGroupLabels(a);
        }
    }
    for (const a of lanes.values()) {
        if (a.card) a.card.el.style.display = laneVisible(a) ? "" : "none";
        if (a.btn) a.btn.style.display = laneInScope(a) ? "" : "none";
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
        runId: ev.runId || "", // a session belongs to one run
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
    // A new session may introduce a new run; if auto-follow switches the selected
    // run, refresh all visibility, otherwise just place this new lane.
    if (updateRunFilter()) {
        applyVisibility();
    } else {
        if (!laneInScope(a)) a.btn.style.display = "none";
        if (!laneVisible(a)) a.card.el.style.display = "none";
        updateSidebarState(); // highlight the new button for the current view
    }
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
    if (!a.runId && ev.runId) a.runId = ev.runId; // backfill if the first event lacked it
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

    // Session start/end change a run's agent count and live state — refresh the run
    // picker (counts/dot) after the event is recorded, and re-apply visibility if
    // auto-follow switches to a newly-live run.
    if (ev.type === "session_start" || ev.type === "session_end") {
        if (updateRunFilter()) applyVisibility();
    }

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

