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

// ── orchestrator groups ──────────────────────────────────────────────────────
// Each lane belongs to one orchestrator instance: a root lane (no parent) is its
// own group; every other lane is attributed to the most recent orchestrator (in
// the same project) that had started by the time it began. So the pre- and
// post-/reload orchestrators — same runId, different root session — fall into
// separate groups. Also records, per project, which group is "active": the
// running orchestrator (latest), else the latest orchestrator seen.
function assignGroups() {
    const all = [...lanes.values()];
    const roots = all
        .filter((a) => !a.parent)
        .sort((x, y) => (x.firstTs ?? 0) - (y.firstTs ?? 0));
    for (const a of all) {
        if (!a.parent) {
            a.group = a.sessionId;
            continue;
        }
        let g = null;
        let firstSame = null;
        for (const r of roots) {
            if (r.cwd !== a.cwd) continue;
            if (!firstSame) firstSame = r;
            if ((r.firstTs ?? 0) <= (a.firstTs ?? 0)) g = r; // latest preceding
        }
        a.group = (g || firstSame || a).sessionId;
    }
    // Per cwd: the active group is the latest still-running orchestrator, or the
    // latest orchestrator overall when none is running.
    activeGroupByCwd.clear();
    const latest = new Map(); // roots are sorted ascending, so the last write wins
    const active = new Map();
    for (const r of roots) {
        latest.set(r.cwd, r.sessionId);
        if (r.rollup.active) active.set(r.cwd, r.sessionId);
    }
    for (const cwd of latest.keys())
        activeGroupByCwd.set(cwd, active.get(cwd) || latest.get(cwd));
}

// Is a lane's orchestrator group currently shown? Explicit hide/show win;
// otherwise only the active group (per project) shows by default.
function laneGroupVisible(a) {
    const g = a.group;
    if (hiddenGroups.has(g)) return false;
    if (shownGroups.has(g)) return true;
    return g === activeGroupByCwd.get(a.cwd);
}

// A lane is shown when it's in scope AND its orchestrator group is visible.
function laneVisible(a) {
    return laneInScope(a) && laneGroupVisible(a);
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
            (r.name || when) +
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
            // swimlane/race: every shown agent uses the highlighted style;
            // agents in a hidden orchestrator group are dimmed
            const shown = laneGroupVisible(a);
            a.btn.classList.toggle("on", shown);
            a.btn.classList.toggle("off", !shown);
        }
    }
}

// Hide / show a whole orchestrator group (the orchestrator and its sub-agents).
// Hiding force-hides it; showing force-shows it past the active-only default.
function setGroupHidden(group, hide) {
    if (hide) {
        hiddenGroups.add(group);
        shownGroups.delete(group);
    } else {
        shownGroups.add(group);
        hiddenGroups.delete(group);
    }
    applyVisibility();
}

// Render the swimlane "hidden" strip — a chip per in-scope orchestrator group
// that isn't currently shown (whether auto-hidden as stale or force-hidden).
// Clicking a chip brings that orchestrator and its sub-agents back.
function renderHiddenBar() {
    const bar = $("hidden-bar");
    if (!bar) return;
    const roots = [...lanes.values()]
        .filter((a) => !a.parent && laneInScope(a) && !laneGroupVisible(a))
        .sort((x, y) => (x.firstTs ?? 0) - (y.firstTs ?? 0));
    if (!roots.length) {
        bar.hidden = true;
        bar.innerHTML = "";
        return;
    }
    bar.hidden = false;
    bar.innerHTML = "";
    const lbl = document.createElement("span");
    lbl.className = "hidden-bar-label";
    lbl.textContent = "hidden:";
    bar.appendChild(lbl);
    for (const r of roots) {
        const chip = document.createElement("button");
        chip.className = "hidden-chip";
        chip.textContent = r.label;
        chip.title = "show " + r.label + " and its sub-agents";
        chip.addEventListener("click", () => setGroupHidden(r.sessionId, false));
        bar.appendChild(chip);
    }
}

// Reflect project + run filters and orchestrator-group visibility across views.
function applyVisibility() {
    assignGroups();
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
    renderHiddenBar();
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
        parent: ev.parent || "", // dispatcher agent NAME; "" = root orchestrator
        group: ev.sessionId || "", // orchestrator-instance group (set by assignGroups)
        label: ev.agent, // display name; gets a "#n" suffix when the agent has siblings
        ord: laneOrd++,
        cwd: ev.cwd || "",
        project: projectName(ev.cwd),
        events: [],
        rollup: newRollup(),
        card: null,
        btn: null,
        count: 0, // total events seen (uncapped, for header)
        maxSeq: -1, // highest seq ingested (dedupes SSE reconnect replays)
        firstTs: null,
        lastTs: null,
    };
    lanes.set(key, a);
    maybeAddProject(a.project);
    buildLaneCard(a);
    buildSidebarBtn(a);
    // A new instance can turn "scout" into "scout #1/#2…" — refresh the group.
    refreshGroupLabels(a);
    // A new lane re-groups (a fresh orchestrator becomes the active group; its
    // sub-agents attribute to it) and may introduce a new run — recompute all.
    applyVisibility();
    return a;
}

function buildSidebarBtn(a) {
    const btn = document.createElement("button");
    btn.className = "sbtn";
    btn.title = a.project + " / " + a.label + " — click to show/hide";
    const dot = document.createElement("span");
    dot.className = "live-dot";
    const lbl = document.createElement("span");
    lbl.className = "sb-label";
    lbl.textContent = a.label;
    btn.append(dot, lbl);
    btn.addEventListener("click", () => {
        if (view === "single") {
            // single-select: pick this agent, or deselect if it's already shown
            selected = selected === a.key ? null : a.key;
            updateSidebarState();
            renderSingle();
        } else {
            // swimlane/race: toggle this agent's whole orchestrator group
            setGroupHidden(a.group, laneGroupVisible(a));
        }
    });
    $("sbtns").appendChild(btn);
    a.btn = btn;
}

function buildLaneCard(a) {
    $("empty").style.display = "none";
    const el = document.createElement("div");
    el.className = "lane";
    // Only the orchestrator (root) card carries the hide control; it hides the
    // whole group — the orchestrator and its sub-agents — in one click.
    const hideBtn = a.parent
        ? ""
        : '<button class="lane-hide" title="hide this orchestrator and its sub-agents">×</button>';
    el.innerHTML =
        '<div class="lane-head"><span class="dot"></span>' +
        '<span class="agent"></span><span class="proj-tag"></span>' +
        '<span class="lane-meta"></span>' +
        hideBtn +
        "</div><div class=\"feed\"></div>";
    el.querySelector(".agent").textContent = a.label;
    el.querySelector(".proj-tag").textContent = a.project;
    el.querySelector(".lane-head").addEventListener("click", () =>
        selectLane(a.key),
    );
    const hb = el.querySelector(".lane-hide");
    if (hb)
        hb.addEventListener("click", (e) => {
            e.stopPropagation(); // don't also open Single
            setGroupHidden(a.group, true);
        });
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
    if (errorsOnly) {
        const p = ev.payload || {};
        const isErr =
            ev.type === "error" ||
            (ev.type === "tool_end" && p.isError) ||
            (ev.type === "dispatch_end" && p.status === "error") ||
            ev.type === "dispatch_retry";
        if (!isErr) return false;
    }
    if (search) {
        const { badge, detail } = describe(ev);
        const hay = badge + " " + detail;
        if (searchRegex) {
            try {
                if (!new RegExp(search, "i").test(hay)) return false;
            } catch {
                return false; // an invalid pattern matches nothing
            }
        } else if (!hay.toLowerCase().includes(search)) {
            return false;
        }
    }
    return true;
}

// ── ingest ───────────────────────────────────────────────────────────────────
function handle(ev) {
    // Verdicts are run-level annotations, not session activity — record them
    // (for pickers/run history) without ever creating a lane.
    if (ev.type === "verdict") {
        recordVerdict(ev.runId, { ...(ev.payload || {}), ts: ev.ts });
        if (view === "trace") scheduleTrace();
        if (view === "stats") scheduleStats();
        if (view === "compare") scheduleCompare();
        return;
    }
    const a = ensureLane(ev);
    // An SSE reconnect replays the server's whole buffer — skip what this
    // lane already holds (per-session seq is monotonic in stream order).
    if (ev.seq <= a.maxSeq) return;
    a.maxSeq = ev.seq;
    if (!a.runId && ev.runId) a.runId = ev.runId; // backfill if the first event lacked it
    if (!a.parent && ev.parent) a.parent = ev.parent; // backfill dispatcher name
    a.count++;
    if (a.firstTs === null || ev.ts < a.firstTs) a.firstTs = ev.ts;
    if (a.lastTs === null || ev.ts > a.lastTs) a.lastTs = ev.ts;
    a.events.push(ev);
    if (a.events.length > EVENTS_CAP) a.events.shift();
    applyRollup(a.rollup, ev);

    a.card.feed.appendChild(makeRow(ev));
    while (a.card.feed.childElementCount > FEED_MAX)
        a.card.feed.removeChild(a.card.feed.firstChild);
    laneMeta(a);
    if (a.btn) a.btn.classList.toggle("active", a.rollup.active);

    // Session start/end change a run's agent count and live state, and shift the
    // active orchestrator group (a /reload's new orchestrator becomes active and
    // the old group auto-hides) — re-apply visibility so both update.
    if (ev.type === "session_start" || ev.type === "session_end") {
        applyVisibility();
    }

    if (view === "single" && a.key === selected) {
        // separators (turn_start) always show; the rest pass the filters
        if (ev.type === "turn_start" || passesFilter(ev)) singleAppend(ev);
        renderStatbar();
    }
    if (view === "race") scheduleRace();
    if (view === "trace") scheduleTrace();
    if (view === "stats") scheduleStats();
    if (view === "compare") scheduleCompare();
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

// Compare aggregates two whole runs — throttle like Stats.
let cmpDirty = false;
let cmpLast = 0;
function scheduleCompare() {
    if (cmpDirty) return;
    cmpDirty = true;
    const wait = Math.max(0, 1500 - (Date.now() - cmpLast));
    setTimeout(() => {
        cmpDirty = false;
        cmpLast = Date.now();
        if (view === "compare") renderCompare();
    }, wait);
}

