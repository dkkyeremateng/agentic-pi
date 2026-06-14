// ── trace (waterfall) view — master–detail over one run ─────────────────────
// One run = one workflow invocation (shared runId). The orchestrator is the
// root; each dispatched agent is a child whose `parent` names its dispatcher.
// Nested spans render on a shared time axis with tool-call ticks and retry
// markers; clicking a row opens the span's detail in the drawer. The axis
// supports a hover crosshair, drag-to-zoom, and a playable replay (as-of-T).
let traceRun = ""; // "" = follow the latest run; otherwise a pinned runId
let traceCurrentRun = ""; // the runId actually rendered (for exports)

// Replay: when set, only events ≤ T feed the nodes, so bars, metrics, and
// running states show the run as it was at that moment. null = live.
let traceReplayT = null;
let traceReplayRun = ""; // the run the scrub position belongs to
let traceRunBounds = null; // [t0, t1] of the rendered run (slider math)
let tracePlayTimer = null; // interval handle while playing
let traceSpeed = 4; // playback multiplier (×1 / ×4 / ×16)
let traceLoop = false; // restart at the end instead of snapping back to live
const TRACE_SPEEDS = [1, 4, 16];

// Replay markers + step targets for the current run, rebuilt each render.
// `traceMarkers` = notable moments shown on the axis (errors / dispatches /
// turns); `traceMoments` = the sorted timestamps ←/→ snaps between.
let traceMarkers = [];
let traceMoments = [];

// Zoom: the axis DOMAIN only (absolute ts window); replay filters events,
// zoom just re-scales the x axis. null = the full run.
let traceZoom = null;
let traceZoomRun = "";

// Slider input (0..1000 across the FULL run); the far right means live.
function traceSetReplay(v) {
    if (!traceRunBounds) return;
    const [t0, t1] = traceRunBounds;
    traceReplayT = v >= 1000 ? null : t0 + (v / 1000) * Math.max(1, t1 - t0);
    traceReplayRun = traceCurrentRun;
    renderTrace();
}

function* eventsUpTo(source, t) {
    for (const item of source) if (item.ev.ts <= t) yield item;
}

// Scan a run's full event stream for replay markers (errors / dispatches /
// turns, drawn on the axis) and step moments (every notable boundary ←/→ snaps
// between). Always over the UNFILTERED run, so you can see and jump to events
// that are still ahead of the playhead.
function collectTraceMarkers(runId, fromArchive) {
    const src = fromArchive ? archiveRunEvents(runId) : laneRunEvents(runId);
    const markers = [];
    const moments = new Set();
    for (const { ev } of src) {
        if (ev.runId !== runId || ev.type === "verdict") continue;
        const p = ev.payload || {};
        let m = null;
        if (ev.type === "error") m = { ts: ev.ts, kind: "error", label: p.message || p.status || "error" };
        else if (ev.type === "tool_end" && p.isError) m = { ts: ev.ts, kind: "error", label: (p.tool || "tool") + " error" };
        else if (ev.type === "dispatch_retry") m = { ts: ev.ts, kind: "error", label: "re-dispatched" };
        else if (ev.type === "dispatch_start") m = { ts: ev.ts, kind: "dispatch", label: "→ " + (p.agent || "agent") };
        else if (ev.type === "turn_start") m = { ts: ev.ts, kind: "turn", label: "turn " + (p.turnIndex ?? "") };
        if (m) markers.push(m);
        // step targets: marker moments + every tool/session boundary
        if (m || ev.type === "tool_start" || ev.type === "tool_end" || ev.type === "session_start" || ev.type === "session_end")
            moments.add(ev.ts);
    }
    markers.sort((a, b) => a.ts - b.ts);
    return { markers, moments: [...moments].sort((a, b) => a - b) };
}

// Park the playhead at an absolute timestamp (clamped just inside the run).
function traceSeek(ts) {
    if (!traceRunBounds) return;
    const [t0, t1] = traceRunBounds;
    traceReplayT = ts >= t1 ? t1 - 1 : Math.max(t0, ts);
    traceReplayRun = traceCurrentRun;
    traceStopPlay();
    renderTrace();
}

// Snap the playhead to the previous / next step moment (dir = -1 / +1).
function traceStep(dir) {
    if (!traceRunBounds) return;
    const [t0, t1] = traceRunBounds;
    const cur = traceReplayT == null ? t1 : traceReplayT;
    let next = null;
    if (dir > 0) {
        for (const m of traceMoments) if (m > cur + 0.5) { next = m; break; }
        next = next ?? t1;
    } else {
        for (let i = traceMoments.length - 1; i >= 0; i--)
            if (traceMoments[i] < cur - 0.5) { next = traceMoments[i]; break; }
        next = next ?? t0;
    }
    traceStopPlay();
    traceReplayT = next >= t1 ? null : Math.max(t0, next);
    traceReplayRun = traceCurrentRun;
    renderTrace();
}

// A finished run that spent nothing (no cost, tokens, or tools) and has gone
// quiet is a no-op (a trivial ping or aborted run) — hidden from the pickers,
// matching the server's /runs filter and the React dashboard. Live/recent runs
// (which read all-zero before their first turn) are kept.
const RUN_QUIET_MS = 90_000;
function isRunEmptyFinished(r, now) {
    const empty =
        (r.costUsd || 0) === 0 && (r.tokens || 0) === 0 && (r.toolCalls || 0) === 0;
    return empty && now - r.lastTs > RUN_QUIET_MS;
}

// Group every runId we've seen (within the active project) with its time bounds.
function collectRuns() {
    const runs = new Map();
    for (const a of lanes.values()) {
        if (!laneInProject(a)) continue;
        for (const ev of a.events) {
            if (!ev.runId) continue;
            let r = runs.get(ev.runId);
            if (!r) {
                r = {
                    id: ev.runId,
                    project: a.project,
                    firstTs: ev.ts,
                    lastTs: ev.ts,
                    agents: new Set(),
                    count: 0, // lane-held events, vs the archive's full count
                    costUsd: 0,
                    tokens: 0,
                    toolCalls: 0,
                    errors: 0,
                };
                runs.set(ev.runId, r);
            }
            if (ev.ts < r.firstTs) r.firstTs = ev.ts;
            if (ev.ts > r.lastTs) r.lastTs = ev.ts;
            r.agents.add(ev.agent);
            if (ev.name) r.name = ev.name; // root-only run name (if named)
            r.count++;
            // tally spend so quiet no-op runs can be filtered out below
            if (ev.type === "turn_end" && ev.payload) {
                r.costUsd += ev.payload.costUsd || 0;
                if (ev.payload.tokens) r.tokens += ev.payload.tokens.total || 0;
            } else if (ev.type === "tool_start") {
                r.toolCalls++;
            } else if (ev.type === "error") {
                r.errors++;
            } else if (ev.type === "tool_end" && ev.payload && ev.payload.isError) {
                r.errors++;
            }
        }
    }
    // Merge in archived runs the live buffer never (or no longer) held. Bounds
    // and agents come from the server's sink index; `archived` marks that the
    // events must be fetched via /events?run= rather than read from lanes.
    for (const [id, s] of archiveRuns) {
        if (runs.has(id)) continue;
        const project = projectName(s.cwd);
        if (projectFilter && project !== projectFilter) continue;
        runs.set(id, {
            id,
            project,
            firstTs: s.firstTs,
            lastTs: s.lastTs,
            agents: new Set(s.agents || []),
            name: s.name,
            count: 0,
            costUsd: s.costUsd || 0,
            tokens: s.tokens || 0,
            toolCalls: s.toolCalls || 0,
            errors: s.errors || 0,
            archived: true,
        });
    }
    // Drop finished no-op runs (the server already filters /runs, but the live
    // buffer can still hold a quiet all-zero run).
    const now = Date.now();
    for (const [id, r] of runs) if (isRunEmptyFinished(r, now)) runs.delete(id);
    return runs;
}

// Event sources for buildTraceNodes: the live lanes, or a fetched archive run
// (which has no lanes — laneKey is null and the drawer's jump action hides).
function* laneRunEvents(runId) {
    for (const a of lanes.values()) {
        if (!laneInProject(a)) continue;
        if (!laneGroupVisible(a)) continue; // hidden orchestrator groups drop from the trace
        for (const ev of a.events)
            if (ev.runId === runId) yield { ev, laneKey: a.key };
    }
}
function* archiveRunEvents(runId) {
    for (const ev of archivedEvents.get(runId) || [])
        if (ev.runId === runId) yield { ev, laneKey: null };
}

// Build per-agent span nodes for one run, plus the orchestrator-side dispatch
// annotations (which arrive on the orchestrator lane but describe a child).
// `source` yields { ev, laneKey } — laneRunEvents (live) or archiveRunEvents.
function buildTraceNodes(runId, source) {
    const nodes = new Map(); // sessionId -> node
    // Dispatch annotations indexed two ways: by dispatchId (precise, binds to
    // the exact instance) and by agent name (legacy events lacking one).
    const byId = new Map();
    const byName = new Map();
    const recordDispatch = (ev) => {
        const did = ev.payload && ev.payload.dispatchId;
        const nm = ev.payload && ev.payload.agent;
        if (!did && !nm) return;
        let d = did ? byId.get(did) : byName.get(nm);
        if (!d)
            d = { retries: 0, reason: null, status: null, attempts: 1, retryTs: [] };
        if (ev.type === "dispatch_retry") {
            d.retries++;
            d.retryTs.push(ev.ts);
            if (ev.payload.reason) d.reason = ev.payload.reason;
        } else if (ev.type === "dispatch_end") {
            d.status = ev.payload.status || d.status;
            if (ev.payload.reason) d.reason = ev.payload.reason;
            if (ev.payload.attempts) d.attempts = ev.payload.attempts;
        }
        if (did) byId.set(did, d);
        else byName.set(nm, d);
    };
    for (const { ev, laneKey } of source) {
        if (ev.runId !== runId) continue;
        // Verdicts are run-level (a CLI score even rides its own tiny session)
        // — they must not become spans or stretch one.
        if (ev.type === "verdict") continue;
        // dispatch_* events ride on the ORCHESTRATOR lane but describe a child.
        if (
            ev.type === "dispatch_start" ||
            ev.type === "dispatch_retry" ||
            ev.type === "dispatch_end"
        ) {
            recordDispatch(ev);
        }
        // Key nodes by sessionId so parallel/sequential instances of one agent
        // are separate spans (not merged under the agent name).
        let n = nodes.get(ev.sessionId);
        if (!n) {
            n = {
                agent: ev.agent, // bare name; parent links + labels use it
                sessionId: ev.sessionId,
                dispatchId: null,
                laneKey,
                parent: null, // parent AGENT NAME (resolved in renderTrace)
                firstTs: ev.ts,
                lastTs: ev.ts,
                rollup: newRollup(),
                ended: false,
                toolTicks: [], // { ts, err } — tool calls inside the bar
                tickById: new Map(),
            };
            nodes.set(ev.sessionId, n);
        }
        if (ev.ts < n.firstTs) n.firstTs = ev.ts;
        if (ev.ts > n.lastTs) n.lastTs = ev.ts;
        if (ev.parent && !n.parent) n.parent = ev.parent;
        if (ev.type === "session_start" && ev.payload && ev.payload.dispatchId)
            n.dispatchId = ev.payload.dispatchId;
        if (ev.type === "session_end") n.ended = true;
        if (ev.type === "tool_start") {
            const tick = { ts: ev.ts, err: false };
            n.toolTicks.push(tick);
            if (ev.payload && ev.payload.toolCallId)
                n.tickById.set(ev.payload.toolCallId, tick);
        } else if (ev.type === "tool_end" && ev.payload && ev.payload.isError) {
            const tick = n.tickById.get(ev.payload.toolCallId);
            if (tick) tick.err = true;
        }
        applyRollup(n.rollup, ev);
    }
    // Bind each instance to its dispatch annotation: dispatchId first, name
    // as the legacy fallback.
    for (const n of nodes.values()) {
        const d = (n.dispatchId && byId.get(n.dispatchId)) || byName.get(n.agent);
        if (d) n.dispatch = d;
    }
    return nodes;
}

// Status of a span node: running (active & not ended), error, else done.
function traceStatus(n) {
    const d = n.dispatch;
    if (d && d.status === "error") return "error";
    if (n.rollup.errors > 0 || n.rollup.toolErrors > 0) return "error";
    if (n.rollup.active && !n.ended) return "running";
    return "done";
}

// Picker label for a run (shared by the combobox list + closed display).
function traceRunLabel(r, live) {
    return (
        verdictMark(r.id) +
        runName(r) +
        " · " +
        r.agents.size +
        " agents · " +
        fmtDur(r.lastTs - r.firstTs) +
        (live.has(r.id) ? " · live" : r.archived ? " · archived" : "")
    );
}

// ── span detail (drawer) ─────────────────────────────────────────────────────
function openSpanDrawer(n, runId) {
    const r = n.rollup;
    const d = n.dispatch;
    $("insp-type").textContent = "span · " + n.label;
    $("insp-agent").textContent = n.label;
    $("insp-time").textContent =
        clock(n.firstTs) +
        " → " +
        clock(n.lastTs) +
        " (" +
        fmtDur(n.lastTs - n.firstTs) +
        ")";
    $("insp-seq").textContent = n.sessionId;
    $("insp-typ2").textContent = traceStatus(n);
    $("insp-summary").textContent = [
        r.turns + " turns · " + r.toolCalls + " tools (" + r.toolErrors + " err)",
        fmtTok(r.tokens) +
            " tok (in " +
            fmtTok(r.inTok) +
            " / out " +
            fmtTok(r.outTok) +
            ") · " +
            fmtCost(r.costUsd),
        r.model ? "model  " + r.model : "",
        r.prefillCount
            ? "prefill ~" + Math.round(r.prefillSum / r.prefillCount) + "ms"
            : "",
        r.ctxPercent != null ? "context  " + Math.round(r.ctxPercent) + "%" : "",
        d && d.retries
            ? "↻ " + d.retries + " retr" + (d.reason ? " (" + d.reason + ")" : "")
            : "",
        d && d.status ? "dispatch  " + d.status : "",
    ]
        .filter(Boolean)
        .join("\n");
    $("insp-json").textContent = JSON.stringify(
        {
            agent: n.agent,
            sessionId: n.sessionId,
            runId,
            firstTs: n.firstTs,
            lastTs: n.lastTs,
            rollup: n.rollup,
            dispatch: n.dispatch ?? null,
        },
        (k, v) => (v instanceof Map ? undefined : v),
        2,
    );
    const act = $("insp-action");
    if (n.laneKey) {
        act.hidden = false;
        act.textContent = "open in Events";
        act.onclick = () => selectLane(n.laneKey);
    } else {
        act.hidden = true;
    }
    $("inspector").classList.add("open");
}

// ── render ───────────────────────────────────────────────────────────────────
function renderTrace() {
    const runs = collectRuns();
    const runList = [...runs.values()].sort((a, b) => b.lastTs - a.lastTs);

    if (!runList.length) {
        $("trace-empty").style.display = "block";
        $("trace-tree").innerHTML = "";
        $("trace-ticks").innerHTML = "";
        $("trace-axis").textContent = "";
        traceCombo.update([], "");
        return;
    }
    $("trace-empty").style.display = "none";

    // Which runs are live (any of their lanes still active).
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup.active && a.runId) live.add(a.runId);

    const distinctProjects = new Set(runList.map((r) => r.project));
    const byProject = projectFilter === "" && distinctProjects.size > 1;

    // Default (sentinel) follows the live run, else the latest.
    const def = runList.find((r) => live.has(r.id)) || runList[0];
    const run = traceRun && runs.get(traceRun) ? runs.get(traceRun) : def;
    traceCurrentRun = run.id;

    // Combobox lists every run (project-tagged when several projects are in
    // view); the picker follows the live/latest run until one is pinned.
    const items = runList.map((r) => ({
        value: r.id,
        label: traceRunLabel(r, live),
        sub: byProject ? r.project : "",
        live: live.has(r.id),
    }));
    traceCombo.update(items, traceRunLabel(run, live), run.id);
    const traceDot = $("trace-run-dot");
    if (traceDot) traceDot.classList.toggle("on", live.has(run.id));

    // Replay + zoom belong to one run — switching runs resets both.
    if (traceReplayRun && traceReplayRun !== run.id) {
        traceReplayT = null;
        traceReplayRun = "";
        traceStopPlay();
    }
    if (traceZoomRun && traceZoomRun !== run.id) {
        traceZoom = null;
        traceZoomRun = "";
    }
    traceRunBounds = [run.firstTs, run.lastTs];
    const scrubbing = traceReplayT != null;
    const scrub = $("trace-scrub");
    const scrubT = $("trace-scrub-t");
    if (scrub && scrubT) {
        const span0 = Math.max(1, run.lastTs - run.firstTs);
        scrub.value = scrubbing
            ? Math.round(((traceReplayT - run.firstTs) / span0) * 1000)
            : 1000;
        scrubT.textContent = scrubbing
            ? "T+" + fmtDur(traceReplayT - run.firstTs)
            : "live";
        scrubT.classList.toggle("scrubbing", scrubbing);
    }
    $("trace-zoom-reset").hidden = !traceZoom;

    // Lanes may hold nothing (or a stale tail) of a non-live run the sink
    // still has in full — render those from the fetched archive instead.
    const fromArchive =
        !live.has(run.id) && (run.archived || archiveHasMore(run));
    if (fromArchive && !archivedEvents.has(run.id)) {
        fetchArchivedRun(run.id); // re-renders on arrival
        $("trace-axis").innerHTML = "loading archived run…";
        $("trace-tree").innerHTML =
            '<div class="skeleton trace-skel"></div>'.repeat(3);
        $("trace-ticks").innerHTML = "";
        return;
    }
    // replay markers + step moments for this run (over the full, unfiltered run)
    const mk = collectTraceMarkers(run.id, fromArchive);
    traceMarkers = mk.markers;
    traceMoments = mk.moments;

    let source = fromArchive ? archiveRunEvents(run.id) : laneRunEvents(run.id);
    if (scrubbing) source = eventsUpTo(source, traceReplayT);
    const nodes = buildTraceNodes(run.id, source);
    // An archived run is finished — never "running" (unless replay-scrubbing,
    // where the as-of-T running state is the whole point).
    if (fromArchive && !scrubbing)
        for (const n of nodes.values()) n.rollup.active = false;

    // Axis domain: the zoom window, else the full run.
    const dom0 = traceZoom ? traceZoom[0] : run.firstTs;
    const dom1 = traceZoom ? traceZoom[1] : run.lastTs;
    const span = Math.max(1, dom1 - dom0);
    const xOf = (ts) => ((ts - dom0) / span) * 100;

    // Per-agent-name index → "agent #n" labels for parallel instances.
    const byStart = (arr) => arr.sort((x, y) => x.firstTs - y.firstTs);
    const nameCount = new Map();
    for (const n of nodes.values())
        nameCount.set(n.agent, (nameCount.get(n.agent) || 0) + 1);
    const nameSeen = new Map();
    for (const n of byStart([...nodes.values()])) {
        const i = nameSeen.get(n.agent) || 0;
        nameSeen.set(n.agent, i + 1);
        n.label = nameCount.get(n.agent) > 1 ? n.agent + " #" + (i + 1) : n.agent;
    }

    // Parent linkage: resolve parent agent NAMES to their earliest node.
    const nodeByAgent = new Map();
    for (const n of byStart([...nodes.values()]))
        if (!nodeByAgent.has(n.agent)) nodeByAgent.set(n.agent, n);
    const childrenOf = new Map();
    const roots = [];
    for (const n of nodes.values()) {
        const p = n.parent && nodeByAgent.get(n.parent);
        if (p && p !== n) {
            if (!childrenOf.has(p.sessionId)) childrenOf.set(p.sessionId, []);
            childrenOf.get(p.sessionId).push(n);
        } else {
            roots.push(n);
        }
    }
    byStart(roots);
    for (const arr of childrenOf.values()) byStart(arr);

    const rows = [];
    const walk = (n, depth) => {
        rows.push({ n, depth });
        for (const c of childrenOf.get(n.sessionId) || []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);

    // Run totals (as-of-T when scrubbing, since nodes are built from events ≤ T).
    let running = 0;
    let cost = 0;
    let tokens = 0;
    let tools = 0;
    let turns = 0;
    let errors = 0;
    for (const n of nodes.values()) {
        if (traceStatus(n) === "running") running++;
        const r = n.rollup;
        cost += r.costUsd || 0;
        tokens += r.tokens || 0;
        tools += r.toolCalls || 0;
        turns += r.turns || 0;
        errors += (r.errors || 0) + (r.toolErrors || 0);
    }
    $("trace-axis").innerHTML =
        (scrubbing
            ? '<span class="verd open">replay T+' +
              fmtDur(traceReplayT - run.firstTs) +
              "</span> · "
            : "") +
        (traceZoom
            ? '<span class="verd open">zoom ' +
              fmtDur(dom0 - run.firstTs) +
              "–" +
              fmtDur(dom1 - run.firstTs) +
              "</span> · "
            : "") +
        (byProject ? "project <b>" + run.project + "</b> · " : "") +
        "<b>" +
        nodes.size +
        "</b> agents · span <b>" +
        fmtDur(run.lastTs - run.firstTs) +
        "</b> · <b>" +
        turns +
        "</b> turns · <b>" +
        fmtTok(tokens) +
        "</b> tok · <b>" +
        fmtCost(cost) +
        "</b> · <b>" +
        tools +
        "</b> tools" +
        (errors
            ? ' · <b style="color:var(--err)">' + errors + "</b> errors"
            : "") +
        (running ? " · <b>" + running + "</b> running" : "") +
        verdictBadge(run.id);

    // Ticks header: T+offset labels at 0/25/50/75/100% of the DOMAIN.
    const ticks = $("trace-ticks");
    ticks.innerHTML = "";
    const sp1 = document.createElement("div");
    sp1.className = "trace-label-sp";
    const tk = document.createElement("div");
    tk.className = "ticks-track";
    tk.id = "ticks-track";
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const t = document.createElement("span");
        t.className = "tick-lbl";
        t.style.left = f * 100 + "%";
        t.textContent = "T+" + fmtDur(dom0 + f * span - run.firstTs);
        tk.appendChild(t);
    }
    // clickable replay markers — jump straight to the moment it dispatched/failed
    for (const m of traceMarkers) {
        const x = xOf(m.ts);
        if (x < 0 || x > 100) continue;
        const el = document.createElement("span");
        el.className = "trace-marker " + m.kind;
        el.style.left = x + "%";
        el.title = "T+" + fmtDur(m.ts - run.firstTs) + " · " + m.label;
        el.addEventListener("mousedown", (e) => e.stopPropagation()); // don't start a brush
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            traceSeek(m.ts);
        });
        tk.appendChild(el);
    }
    // playhead position on the axis while scrubbing
    if (scrubbing) {
        const x = xOf(traceReplayT);
        if (x >= 0 && x <= 100) {
            const ph = document.createElement("span");
            ph.className = "trace-playhead";
            ph.style.left = x + "%";
            tk.appendChild(ph);
        }
    }
    const sp2 = document.createElement("div");
    sp2.className = "trace-meta-sp";
    ticks.append(sp1, tk, sp2);

    const tree = $("trace-tree");
    tree.innerHTML = "";
    for (const { n, depth } of rows) {
        const status = traceStatus(n);
        const row = document.createElement("div");
        row.className = "trace-row";
        row.addEventListener("click", () => {
            if (traceSuppressClick) return;
            openSpanDrawer(n, run.id);
        });

        // label (indented by depth)
        const label = document.createElement("div");
        label.className = "trace-label";
        label.style.paddingLeft = depth * 16 + "px";
        const dot = document.createElement("span");
        dot.className = "dot" + (status === "running" ? " on" : "");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = n.label;
        label.append(dot, nm);
        if (n.rollup.model) {
            const m = document.createElement("span");
            m.className = "model";
            m.textContent = n.rollup.model;
            m.title = n.rollup.model;
            label.append(m);
        }

        // timeline track: span bar + tool ticks + retry markers
        const track = document.createElement("div");
        track.className = "trace-track";
        const left = xOf(n.firstTs);
        const right = xOf(n.lastTs);
        if (right >= 0 && left <= 100) {
            const l = Math.max(0, Math.min(100, left));
            const w = Math.max(0.6, Math.min(100, right) - l);
            const bar = document.createElement("div");
            bar.className = "trace-span " + status;
            bar.style.left = l + "%";
            bar.style.width = Math.min(100 - l, w) + "%";
            bar.title =
                n.label +
                " · " +
                fmtDur(n.lastTs - n.firstTs) +
                " · " +
                fmtTok(n.rollup.tokens) +
                " tok · " +
                fmtCost(n.rollup.costUsd);
            track.append(bar);
        }
        for (const tick of n.toolTicks) {
            const x = xOf(tick.ts);
            if (x < 0 || x > 100) continue;
            const el = document.createElement("span");
            el.className = "t-tick" + (tick.err ? " err" : "");
            el.style.left = x + "%";
            track.append(el);
        }
        if (n.dispatch && n.dispatch.retryTs) {
            for (const ts of n.dispatch.retryTs) {
                const x = xOf(ts);
                if (x < 0 || x > 100) continue;
                const el = document.createElement("span");
                el.className = "t-retry";
                el.style.left = x + "%";
                el.textContent = "↻";
                el.title = "re-dispatched here";
                track.append(el);
            }
        }

        // right-side metrics + dispatch tags
        const meta = document.createElement("div");
        meta.className = "trace-meta";
        meta.innerHTML =
            "<b>" +
            fmtDur(n.lastTs - n.firstTs) +
            "</b> · " +
            fmtTok(n.rollup.tokens) +
            " · " +
            fmtCost(n.rollup.costUsd) +
            " · " +
            n.rollup.toolCalls +
            " tools";
        const d = n.dispatch;
        if (d && d.retries > 0) {
            const tag = document.createElement("span");
            tag.className = "trace-tag retry";
            tag.textContent = "↻" + d.retries;
            tag.title = d.retries + " retry(s)";
            meta.append(tag);
        }
        if (d && d.reason === "truncated") {
            const tag = document.createElement("span");
            tag.className = "trace-tag trunc";
            tag.textContent = "truncated";
            tag.title = "stop reason: length (output-token limit)";
            meta.append(tag);
        }

        row.append(label, track, meta);
        tree.append(row);
    }
}

// ── replay playback ──────────────────────────────────────────────────────────
function traceStopPlay() {
    if (tracePlayTimer) clearInterval(tracePlayTimer);
    tracePlayTimer = null;
    const b = $("trace-play");
    if (b) b.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>';
}
function traceTogglePlay() {
    if (tracePlayTimer) {
        traceStopPlay();
        return;
    }
    if (!traceRunBounds) return;
    if (traceReplayT == null) traceReplayT = traceRunBounds[0]; // from the top
    traceReplayRun = traceCurrentRun;
    $("trace-play").innerHTML = '<svg class="icon"><use href="#i-pause"/></svg>';
    tracePlayTimer = setInterval(() => {
        traceReplayT += 250 * traceSpeed;
        if (traceReplayT >= traceRunBounds[1]) {
            if (traceLoop) {
                traceReplayT = traceRunBounds[0]; // wrap to the start and keep going
            } else {
                traceReplayT = null; // reached the end — snap back to live
                traceStopPlay();
            }
        }
        renderTrace();
    }, 250);
}

// ── crosshair + brush zoom (pointer interactions over the timeline) ─────────
let traceSuppressClick = false; // a brush-drag must not fire the row click

function traceTrackRect() {
    const t = $("ticks-track");
    return t ? t.getBoundingClientRect() : null;
}

(function () {
    const body = $("trace-body");
    const cross = $("trace-cross");
    const crossT = $("trace-cross-t");
    const brushEl = $("trace-brush");
    let brush = null; // { x0 } in viewport px

    const domain = () => {
        if (!traceRunBounds) return null;
        return traceZoom ?? traceRunBounds;
    };
    const tsAtX = (x, rect) => {
        const d = domain();
        if (!d) return null;
        const f = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        return d[0] + f * (d[1] - d[0]);
    };

    body.addEventListener("mousemove", (e) => {
        const rect = traceTrackRect();
        if (!rect || e.clientX < rect.left || e.clientX > rect.right) {
            cross.hidden = true;
            if (!brush) return;
        } else {
            const bodyRect = body.getBoundingClientRect();
            cross.hidden = false;
            cross.style.left = e.clientX - bodyRect.left + "px";
            const ts = tsAtX(e.clientX, rect);
            if (ts != null && traceRunBounds)
                crossT.textContent = "T+" + fmtDur(ts - traceRunBounds[0]);
        }
        if (brush) {
            const bodyRect = body.getBoundingClientRect();
            const a = Math.min(brush.x0, e.clientX);
            const b = Math.max(brush.x0, e.clientX);
            brushEl.hidden = false;
            brushEl.style.left = a - bodyRect.left + "px";
            brushEl.style.width = b - a + "px";
        }
    });
    body.addEventListener("mouseleave", () => {
        cross.hidden = true;
    });
    body.addEventListener("mousedown", (e) => {
        const rect = traceTrackRect();
        if (!rect || e.clientX < rect.left || e.clientX > rect.right) return;
        brush = { x0: e.clientX };
    });
    window.addEventListener("mouseup", (e) => {
        if (!brush) return;
        const rect = traceTrackRect();
        const moved = Math.abs(e.clientX - brush.x0);
        if (rect && moved > 8) {
            const a = tsAtX(Math.min(brush.x0, e.clientX), rect);
            const b = tsAtX(Math.max(brush.x0, e.clientX), rect);
            if (a != null && b != null && b - a > 10) {
                traceZoom = [a, b];
                traceZoomRun = traceCurrentRun;
                traceSuppressClick = true; // swallow the click this drag ends with
                setTimeout(() => (traceSuppressClick = false), 0);
                renderTrace();
            }
        }
        brush = null;
        brushEl.hidden = true;
    });
    body.addEventListener("dblclick", () => {
        if (!traceZoom) return;
        traceZoom = null;
        traceZoomRun = "";
        renderTrace();
    });
})();

// ── controls + keyboard ──────────────────────────────────────────────────────
// The run is chosen from the left runs rail now — no in-page run picker. Keep a
// no-op stub so the render path's traceCombo.update(...) calls stay harmless.
const traceCombo = $("trace-run-q")
    ? makeCombo({
          input: $("trace-run-q"),
          list: $("trace-run-list"),
          onPick: (v) => {
              traceRun = v;
              traceRunByCombo = true;
              renderTrace();
              syncRunsRail();
              syncHash();
          },
      })
    : { update: () => {} };

$("trace-play").addEventListener("click", traceTogglePlay);
function traceSetSpeed(dir) {
    const i = TRACE_SPEEDS.indexOf(traceSpeed);
    const ni = dir
        ? Math.min(TRACE_SPEEDS.length - 1, Math.max(0, i + dir))
        : (i + 1) % TRACE_SPEEDS.length;
    traceSpeed = TRACE_SPEEDS[ni];
    $("trace-speed").textContent = "×" + traceSpeed;
}
$("trace-speed").addEventListener("click", () => traceSetSpeed(0));
$("trace-loop").addEventListener("click", () => {
    traceLoop = !traceLoop;
    $("trace-loop").classList.toggle("on", traceLoop);
    $("trace-loop").setAttribute("aria-pressed", String(traceLoop));
});
$("trace-zoom-reset").addEventListener("click", () => {
    traceZoom = null;
    traceZoomRun = "";
    renderTrace();
});

// space = play/pause · ←/→ = snap to prev/next event (shift = coarse time nudge)
// Home/End = jump to start/live · ↑/↓ = speed
window.addEventListener("keydown", (e) => {
    if (view !== "trace") return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (!$("palette").hidden) return;
    if (!traceRunBounds && e.key !== " ") return;
    if (e.key === " ") {
        e.preventDefault();
        traceTogglePlay();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.shiftKey) {
            // coarse: nudge by 10% of the run span
            const [t0, t1] = traceRunBounds;
            const cur = traceReplayT == null ? t1 : traceReplayT;
            const next = cur + dir * ((t1 - t0) / 10);
            traceStopPlay();
            traceReplayT = next >= t1 ? null : Math.max(t0, next);
            traceReplayRun = traceCurrentRun;
            renderTrace();
        } else {
            traceStep(dir);
        }
    } else if (e.key === "Home") {
        e.preventDefault();
        traceSeek(traceRunBounds[0]);
    } else if (e.key === "End") {
        e.preventDefault();
        traceStopPlay();
        traceReplayT = null; // back to live
        renderTrace();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        traceSetSpeed(e.key === "ArrowUp" ? 1 : -1);
    }
});
