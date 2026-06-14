// ── projects + visibility ────────────────────────────────────────────────────
function maybeAddProject(p) {
    if (projects.has(p)) return;
    projects.add(p);
    renderProjectFilter();
}

// The project with the most recent activity (live lanes win), used as the
// auto-default scope so the rail/views focus on what you're actually running.
function activeProject() {
    let best = null;
    let bestTs = -1;
    let liveBest = null;
    let liveTs = -1;
    for (const a of lanes.values()) {
        const ts = a.lastTs || 0;
        if (ts > bestTs) {
            bestTs = ts;
            best = a.project;
        }
        if (a.rollup && a.rollup.active && ts > liveTs) {
            liveTs = ts;
            liveBest = a.project;
        }
    }
    return liveBest || best;
}

// Rebuild the project-filter combobox from the known projects. "all projects" is
// included only when more than one project is present; with a single project the
// combo scopes to it (and renders as a static label — the combobox auto-disables
// its dropdown for ≤1 item).
function renderProjectFilter() {
    if (!projfilterCombo) return;
    const names = [...projects].sort();
    // Until the user explicitly chooses, default to the active project (not "all
    // projects") so agents from other projects are hidden. Pick once, then stick
    // until that project is gone — so new activity elsewhere doesn't yank the view.
    if (projectFilterAuto && names.length) {
        const valid = projectFilter && projects.has(projectFilter);
        if (!valid)
            projectFilter =
                names.length === 1 ? names[0] : activeProject() || names[0];
    }
    const items = [
        ...(names.length > 1 ? [{ value: "", label: "all projects" }] : []),
        ...names.map((p) => ({ value: p, label: p })),
    ];
    projfilterCombo.update(items, projectFilter || "all projects", projectFilter);
}

// Switch the project filter (combobox pick, palette, etc.): reset the run scope
// to re-follow the live/last run in the new project, persist, and re-render.
function setProjectFilter(p) {
    projectFilter = p;
    projectFilterAuto = false; // explicit pick (incl. "all projects") sticks
    runFilter = "";
    runFilterAuto = true;
    try {
        localStorage.setItem("obs.projectFilter", projectFilter);
    } catch {
        /* ignore */
    }
    renderProjectFilter();
    applyVisibility();
    syncHash();
}

// Run-picker option label, shared by the header run filter:
// "<run name> · <n> agents[ · live]".
function runLabel(r, live) {
    return (
        runName(r) +
        " · " +
        r.agents.size +
        " agents" +
        (live.has(r.id) ? " · live" : "")
    );
}
function laneInProject(a) {
    return !projectFilter || a.project === projectFilter;
}
// The run a view is scoped to: the Trace/Race/Single tabs share the open run
// (traceRun); Swimlane keeps its own live run filter.
function activeRunScope() {
    if (isRunView(view)) return traceRun || "";
    return runFilter || "";
}
// Trace / Timeline / Race / Events — the run-detail tabs.
function isRunView(v) {
    return v === "spans" || v === "trace" || v === "race" || v === "single";
}
// The run filter scopes the lane views to one run (sessions are single-run).
function laneInRun(a) {
    const r = activeRunScope();
    return !r || a.runId === r;
}
// In scope = passes both the project and the run filter (used for sidebar buttons).
function laneInScope(a) {
    return laneInProject(a) && laneInRun(a);
}

// The run the current view is scoped to (for the footer); "" = none.
function currentRunId() {
    if (isRunView(view)) return traceRun || "";
    if (view === "stats") return (typeof statsRun !== "undefined" && statsRun) || "";
    if (view === "swimlane") return runFilterAuto ? "" : runFilter || "";
    return "";
}

// The orchestrator (root) lane of the open run, for the Single tab's default
// agent; falls back to the first in-scope lane, else null.
function defaultRunAgent() {
    let root = null;
    let first = null;
    for (const a of lanes.values()) {
        if (!laneInScope(a)) continue;
        if (!first || (a.firstTs ?? 0) < (first.firstTs ?? Infinity)) first = a;
        if (!a.parent && (!root || (a.firstTs ?? 0) < (root.firstTs ?? Infinity)))
            root = a;
    }
    return (root || first || {}).key || null;
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
// Did this agent do anything? (no turns / tools / tokens / cost = a no-op).
function laneHasWork(a) {
    const r = a.rollup;
    return r.turns > 0 || r.toolCalls > 0 || (r.tokens || 0) > 0 || (r.costUsd || 0) > 0;
}

// Populate + show the header run filter (a combobox). Runs are project-scoped,
// so it only applies when a single project is selected; it's hidden for "all
// projects". Returns true if the selection changed.
function updateRunFilter() {
    const wrap = $("runfilter-wrap");
    const dot = $("run-dot");
    if (!runfilterCombo) return false;
    const prev = runFilter;
    // Only for the lane views; Trace and Stats have their own per-view run pickers.
    // Only on Swimlane — the run-detail tabs (Trace/Race/Single) scope to the
    // open run instead, and Trace/Stats have their own per-view run pickers.
    const show = projectFilter !== "" && view === "swimlane";
    if (wrap) wrap.style.display = show ? "inline-flex" : "none";
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

    const items = [
        ...(single ? [] : [{ value: "", label: "all runs", live: live.size > 0 }]),
        ...list.map((r) => ({
            value: r.id,
            label: runLabel(r, live),
            live: live.has(r.id),
        })),
    ];
    const sel = list.find((r) => r.id === runFilter);
    runfilterCombo.update(items, sel ? runLabel(sel, live) : "all runs", runFilter);
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
        .filter(
            (a) =>
                !a.parent &&
                laneInScope(a) &&
                !laneGroupVisible(a) &&
                laneHasWork(a), // drop no-op orchestrators from the hidden chips
        )
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
        // swimlane: drop no-op agents (0 turns/tools/tokens/cost), unless still active
        if (a.card)
            a.card.el.style.display =
                laneVisible(a) && (laneHasWork(a) || a.rollup.active) ? "" : "none";
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
    // A new instance can turn "scout" into "scout #1/#2…" — refresh the group.
    refreshGroupLabels(a);
    // A new lane re-groups (a fresh orchestrator becomes the active group; its
    // sub-agents attribute to it) and may introduce a new run — recompute all.
    applyVisibility();
    return a;
}

// ── runs rail ────────────────────────────────────────────────────────────────
// The left rail lists the in-scope runs (project-filtered, no-op runs excluded);
// clicking one pins it in the Trace view. Rebuilt only when the set of runs
// changes; live dots + the selected highlight refresh on the header tick.
let runsRailSig = "";

// The selected run — always highlighted in the rail, on every view.
function railRunOpen(id) {
    return traceRun === id;
}

function railLiveRuns() {
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup && a.rollup.active && a.runId)
            live.add(a.runId);
    return live;
}

function renderRunsRail(runs) {
    const host = $("sbtns");
    if (!host) return;
    const live = railLiveRuns();
    host.innerHTML = "";
    for (const r of runs) {
        const btn = document.createElement("button");
        btn.className =
            "sbtn" +
            (live.has(r.id) ? " active" : "") +
            (railRunOpen(r.id) ? " on" : "");
        btn.dataset.run = r.id;
        btn.title =
            (r.name ? r.name + " · " : "") +
            r.id +
            " · " +
            r.agents.size +
            " agents · " +
            fmtDur(r.lastTs - r.firstTs) +
            (live.has(r.id) ? " · live" : "");
        const dot = document.createElement("span");
        dot.className = "live-dot";
        const lbl = document.createElement("span");
        lbl.className = "sb-label";
        // run name only when scoped to a project; prepend the project in
        // "all projects" view to disambiguate. Never the date/time.
        lbl.textContent = projectFilter ? runName(r) : r.project + " · " + runName(r);
        btn.append(dot, lbl);
        btn.addEventListener("click", () => {
            // a run is always selected — pick this one (never un-pin)
            traceRun = r.id;
            traceRunByCombo = false; // a rail pick must not collapse the rail
            // stay on the current run-page tab (Trace/Timeline/Race/Events);
            // otherwise open the run page on Trace.
            setView(isRunView(view) ? view : "spans");
        });
        host.appendChild(btn);
    }
}

// The run pinned in the current view's TOP run-picker, if any. While one is
// selected the rail collapses to just that run. A left-rail click does NOT count
// (it navigates but keeps the full list), so the trace case requires the run to
// have been pinned via the combo / permalink (traceRunByCombo).
function selectedRailRun() {
    if (view === "trace") return (traceRunByCombo && traceRun) || "";
    if (view === "stats") return (typeof statsRun !== "undefined" && statsRun) || "";
    // Swimlane: only an explicit header run pick (not the live-follow default)
    if (view === "swimlane" && !runFilterAuto) return runFilter || "";
    return "";
}

// Cheap refresh (no rebuild): just the live dots + the selected highlight.
function refreshRunsRailState() {
    const host = $("sbtns");
    if (!host) return;
    const live = railLiveRuns();
    for (const btn of host.children) {
        const id = btn.dataset.run;
        btn.classList.toggle("active", live.has(id));
        btn.classList.toggle("on", railRunOpen(id));
    }
}

// Rebuild the rail when the run set changes, else just refresh dots/highlight.
// When a run is selected in the top panel, collapse the rail to only that run.
function syncRunsRail() {
    if (!$("sbtns")) return;
    const all = [...collectRuns().values()].sort((a, b) => b.lastTs - a.lastTs);
    // a run is always selected — default to the most recent when none is (or the
    // selected one has gone).
    if (all.length && (!traceRun || !all.some((r) => r.id === traceRun))) {
        traceRun = all[0].id;
        traceRunByCombo = false;
    }
    const sel = selectedRailRun();
    const selRun = sel && all.find((r) => r.id === sel);
    const runs = selRun ? [selRun] : all;
    const sig = runs.map((r) => r.id).join(",") + "|" + view + "|" + traceRun + "|" + sel;
    if (sig !== runsRailSig) {
        runsRailSig = sig;
        renderRunsRail(runs);
    } else {
        refreshRunsRailState();
    }
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
        if (view === "spans") scheduleSpans();
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

    if (view === "single" && laneInScope(a)) {
        // Events feed spans every agent in the run; separators (turn_start)
        // always show, the rest pass the filters.
        if (ev.type === "turn_start" || passesFilter(ev)) singleAppend(ev, a);
        renderStatbar();
    }
    if (view === "race") scheduleRace();
    if (view === "trace") scheduleTrace();
    if (view === "spans") scheduleSpans();
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

// Coalesce span-tree (Trace tab) re-renders.
let spansDirty = false;
function scheduleSpans() {
    if (spansDirty) return;
    spansDirty = true;
    requestAnimationFrame(() => {
        spansDirty = false;
        if (view === "spans") renderSpans();
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

