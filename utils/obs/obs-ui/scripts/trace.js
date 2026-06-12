// ── trace (waterfall) view ───────────────────────────────────────────────────
// One run = one workflow invocation (shared runId). The orchestrator is the root;
// each dispatched agent is a child whose `parent` names the agent that spawned it.
// We render nested spans on a shared time axis, annotated with the orchestrator's
// dispatch_* outcomes (retries, truncation).
let traceRun = ""; // "" = follow the latest run; otherwise a pinned runId
let traceCurrentRun = ""; // the runId actually rendered (for the export buttons)

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
                };
                runs.set(ev.runId, r);
            }
            if (ev.ts < r.firstTs) r.firstTs = ev.ts;
            if (ev.ts > r.lastTs) r.lastTs = ev.ts;
            r.agents.add(ev.agent);
            if (ev.name) r.name = ev.name; // root-only run name (if the session was named)
            r.count++;
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
            archived: true,
        });
    }
    return runs;
}

// Event sources for buildTraceNodes: the live lanes, or a fetched archive run
// (which has no lanes — laneKey is null and rows aren't clickable).
function* laneRunEvents(runId) {
    for (const a of lanes.values()) {
        if (!laneInProject(a)) continue;
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
    // Dispatch annotations indexed two ways: by dispatchId (precise, binds to the
    // exact instance) and by agent name (fallback for events lacking a dispatchId).
    const byId = new Map();
    const byName = new Map();
    const recordDispatch = (ev) => {
        const did = ev.payload && ev.payload.dispatchId;
        const nm = ev.payload && ev.payload.agent;
        if (!did && !nm) return;
        // A dispatchId identifies the exact instance; without one, fall back to the
        // agent name (legacy events). Never cross the two indexes, or sibling
        // instances of the same agent would merge into one record.
        let d = did ? byId.get(did) : byName.get(nm);
        if (!d) d = { retries: 0, reason: null, status: null, attempts: 1 };
        if (ev.type === "dispatch_retry") {
            d.retries++;
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
        // dispatch_* events ride on the ORCHESTRATOR lane but describe a child.
        // Record the annotation, but still let the event extend the emitting
        // (orchestrator) span so the root bar spans the whole run.
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
                dispatchId: null, // this instance's dispatch id (from session_start)
                laneKey,
                parent: null, // parent AGENT NAME (resolved to a node in renderTrace)
                firstTs: ev.ts,
                lastTs: ev.ts,
                rollup: newRollup(),
                ended: false,
            };
            nodes.set(ev.sessionId, n);
        }
        if (ev.ts < n.firstTs) n.firstTs = ev.ts;
        if (ev.ts > n.lastTs) n.lastTs = ev.ts;
        if (ev.parent && !n.parent) n.parent = ev.parent;
        if (ev.type === "session_start" && ev.payload && ev.payload.dispatchId)
            n.dispatchId = ev.payload.dispatchId;
        if (ev.type === "session_end") n.ended = true;
        applyRollup(n.rollup, ev);
    }
    // Bind each instance to its dispatch annotation: prefer the precise dispatchId
    // match, fall back to the agent name (legacy events without a dispatchId).
    for (const n of nodes.values()) {
        const d = (n.dispatchId && byId.get(n.dispatchId)) || byName.get(n.agent);
        if (d) n.dispatch = d;
    }
    return nodes;
}

// Status of a span node: running (active & not ended), error (any error signal),
// else done.
function traceStatus(n) {
    const d = n.dispatch;
    if (d && d.status === "error") return "error";
    if (n.rollup.errors > 0 || n.rollup.toolErrors > 0) return "error";
    if (n.rollup.active && !n.ended) return "running";
    return "done";
}

function renderTrace() {
    const runs = collectRuns();
    const runList = [...runs.values()].sort((a, b) => b.lastTs - a.lastTs);
    const sel = $("trace-run");

    if (!runList.length) {
        $("trace-empty").style.display = "block";
        $("trace-tree").innerHTML = "";
        $("trace-axis").textContent = "";
        sel.innerHTML = "";
        return;
    }
    $("trace-empty").style.display = "none";

    // Which runs are live (any of their lanes still active).
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup.active && a.runId) live.add(a.runId);

    // Run picker — latest first, with a "follow live/latest" sentinel. When all
    // projects are shown and >1 is present, group runs under their project. Live
    // runs are flagged with green text + "· live". With only one run the sentinel
    // is redundant — omit it and just show that run.
    const distinctProjects = new Set(runList.map((r) => r.project));
    const byProject = projectFilter === "" && distinctProjects.size > 1;
    const single = runList.length === 1;

    sel.innerHTML = "";
    if (!single) {
        const latest = document.createElement("option");
        latest.value = "";
        latest.textContent = "live (latest)";
        sel.appendChild(latest);
    }

    const optFor = (r) => {
        const o = document.createElement("option");
        o.value = r.id;
        const isLive = live.has(r.id);
        if (isLive) o.style.color = "var(--ok)";
        o.textContent =
            (r.name || fmtWhen(r.firstTs)) +
            " · " +
            r.agents.size +
            " agents · " +
            fmtDur(r.lastTs - r.firstTs) +
            (isLive ? " · live" : r.archived ? " · archived" : "");
        return o;
    };

    if (!byProject) {
        runList.forEach((r) => sel.appendChild(optFor(r)));
    } else {
        // Bucket runs by project, preserving latest-first order; projects ordered
        // by their most recent run.
        const projs = new Map();
        runList.forEach((r) => {
            let p = projs.get(r.project);
            if (!p) {
                p = [];
                projs.set(r.project, p);
            }
            p.push(r);
        });
        for (const [project, items] of projs) {
            const og = document.createElement("optgroup");
            og.label = project;
            for (const r of items) og.appendChild(optFor(r));
            sel.appendChild(og);
        }
    }
    // Default (sentinel) follows the live run, else the latest.
    const def = runList.find((r) => live.has(r.id)) || runList[0];
    const run = traceRun && runs.get(traceRun) ? runs.get(traceRun) : def;
    traceCurrentRun = run.id;
    // No sentinel when single — select the one run directly.
    sel.value = traceRun && runs.has(traceRun) ? traceRun : single ? run.id : "";
    // Live dot inside the picker — the same .dot.on used on the agent cards.
    const traceDot = $("trace-run-dot");
    if (traceDot) traceDot.classList.toggle("on", live.has(run.id));

    // Lanes may hold nothing (or just a stale tail) of a non-live run the sink
    // still has in full — render those from the fetched archive instead.
    const fromArchive =
        !live.has(run.id) && (run.archived || archiveHasMore(run));
    if (fromArchive && !archivedEvents.has(run.id)) {
        fetchArchivedRun(run.id); // re-renders on arrival
        $("trace-axis").innerHTML = "loading archived run…";
        $("trace-tree").innerHTML = "";
        return;
    }
    const nodes = buildTraceNodes(
        run.id,
        fromArchive ? archiveRunEvents(run.id) : laneRunEvents(run.id),
    );
    // An archived run is finished by definition — never show it as running
    // (a crashed agent may have left no session_end).
    if (fromArchive) for (const n of nodes.values()) n.rollup.active = false;
    const t0 = run.firstTs;
    const span = Math.max(1, run.lastTs - run.firstTs);

    // Per-agent-name index → "agent #n" labels when a name has several instances.
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

    // Parent linkage: a node's parent is an agent NAME; resolve it to the
    // representative (earliest) node of that name. childrenOf is keyed by the
    // parent node's sessionId so parallel same-name parents don't merge.
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

    // DFS into a flat, depth-tagged row list.
    const rows = [];
    const walk = (n, depth) => {
        rows.push({ n, depth });
        for (const c of childrenOf.get(n.sessionId) || []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);

    let running = 0;
    for (const n of nodes.values())
        if (traceStatus(n) === "running") running++;
    $("trace-axis").innerHTML =
        (byProject ? "project <b>" + run.project + "</b> · " : "") +
        "<b>" +
        nodes.size +
        "</b> agents · span <b>" +
        fmtDur(span) +
        "</b>" +
        (running ? " · <b>" + running + "</b> running" : "");

    const tree = $("trace-tree");
    tree.innerHTML = "";
    for (const { n, depth } of rows) {
        const status = traceStatus(n);
        const row = document.createElement("div");
        row.className = "trace-row";
        // Archived runs have no lanes to jump to — rows aren't clickable.
        if (n.laneKey)
            row.addEventListener("click", () => selectLane(n.laneKey));

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

        // timeline track + positioned span bar
        const track = document.createElement("div");
        track.className = "trace-track";
        const bar = document.createElement("div");
        bar.className = "trace-span " + status;
        const left = ((n.firstTs - t0) / span) * 100;
        const width = Math.max(0.6, ((n.lastTs - n.firstTs) / span) * 100);
        bar.style.left = Math.max(0, Math.min(100, left)) + "%";
        bar.style.width = Math.min(100 - left, width) + "%";
        bar.title =
            n.label +
            " · " +
            fmtDur(n.lastTs - n.firstTs) +
            " · " +
            fmtTok(n.rollup.tokens) +
            " tok · " +
            fmtCost(n.rollup.costUsd);
        track.append(bar);

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
            "🔧";
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

