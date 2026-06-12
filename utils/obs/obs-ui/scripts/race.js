// ── race view (turn-normalized) ──────────────────────────────────────────────
function bucketByTurn(a) {
    let cur = -1;
    const setup = [];
    const turns = new Map();
    let maxTurn = -1;
    for (const ev of a.events) {
        const idx = ev.payload && ev.payload.turnIndex;
        let ti;
        if (ev.type === "turn_start") {
            cur = idx != null ? idx : cur + 1;
            ti = cur;
        } else if (ev.type === "turn_end") {
            ti = idx != null ? idx : cur;
        } else {
            ti = cur;
        }
        if (ti < 0) {
            setup.push(ev);
            continue;
        }
        if (!turns.has(ti)) turns.set(ti, []);
        turns.get(ti).push(ev);
        if (ti > maxTurn) maxTurn = ti;
    }
    return { setup, turns, maxTurn, turnsReached: turns.size };
}

// Emoji marker per event type (in the spirit of disler's symbol set).
function emojiFor(ev) {
    switch (ev.type) {
        case "session_start":
            return "🚀";
        case "boot":
            return "🧰";
        case "session_end":
            return "🏁";
        case "turn_start":
            return "▶️";
        case "turn_end":
            return "⏹️";
        case "tool_start":
            return "🔧";
        case "tool_end":
            return ev.payload && ev.payload.isError ? "❌" : "✅";
        case "model_change":
            return "🔁";
        case "dispatch_start":
            return "📤";
        case "dispatch_retry":
            return "🔁";
        case "dispatch_end":
            return ev.payload && ev.payload.status === "error" ? "❌" : "📥";
        case "compaction":
            return "📦";
        case "error":
            return "❌";
        case "message":
            return (ev.payload && ev.payload.kind) === "thinking"
                ? "💭"
                : (ev.payload && ev.payload.kind) === "user"
                  ? "👤"
                  : "💬";
        default:
            return "•";
    }
}

function typeLabel(ev) {
    switch (ev.type) {
        case "session_start":
            return "start";
        case "session_end":
            return "end";
        case "turn_start":
            return "turn start";
        case "turn_end":
            return "turn end";
        case "tool_start":
            return "tool call";
        case "tool_end":
            return "tool result";
        case "model_change":
            return "model";
        case "dispatch_start":
            return "dispatch start";
        case "dispatch_retry":
            return "dispatch retry";
        case "dispatch_end":
            return "dispatch end";
        case "message": {
            const k = ev.payload && ev.payload.kind;
            return k === "thinking"
                ? "thinking"
                : k === "user"
                  ? "user message"
                  : "assistant message";
        }
        default:
            return ev.type;
    }
}

// A short prompt/snippet for a turn (its first assistant/thinking/user text).
function turnSnippet(evs) {
    for (const ev of evs) {
        if (ev.type === "message" && ev.payload && ev.payload.text)
            return ev.payload.text.replace(/\s+/g, " ").trim();
    }
    return "";
}

const raceScroll = new Map(); // laneKey -> scrollLeft of its .race-turns
// Per-agent-group collapse state (groupKey -> explicit user choice). When a group
// is collapsed it shows only its primary instance (the running one, else the last)
// so the active/most-recent run stays accessible. Multi-instance groups default to
// collapsed to keep the page tidy; single-instance groups are never collapsed.
const raceCollapsed = new Map();
function groupCollapsed(g) {
    return raceCollapsed.has(g.key) ? raceCollapsed.get(g.key) : g.lanes.length > 1;
}
// The instance to keep visible when collapsed: the latest still-running one, else
// the last (most recently started) instance.
function primaryLane(g) {
    const active = g.lanes.filter((a) => a.rollup.active);
    return active.length ? active[active.length - 1] : g.lanes[g.lanes.length - 1];
}

// Project-tier collapse state (project -> explicit choice). Only used when viewing
// all projects with more than one present. Projects default to expanded.
const raceProjCollapsed = new Map();
function projCollapsed(project) {
    return raceProjCollapsed.has(project) ? raceProjCollapsed.get(project) : false;
}

// Event inspector (detail drawer) — full detail for a clicked event.
function openInspector(ev, lane) {
    $("insp-action").hidden = true; // span-detail-only affordance
    $("insp-type").textContent = emojiFor(ev) + "  " + typeLabel(ev);
    $("insp-agent").textContent =
        (lane ? lane.label : ev.agent) +
        (lane && lane.project ? " · " + lane.project : "");
    $("insp-time").textContent = clock(ev.ts);
    $("insp-seq").textContent = "#" + ev.seq;
    $("insp-typ2").textContent = typeLabel(ev);
    $("insp-summary").textContent = describe(ev).detail;
    $("insp-json").textContent = JSON.stringify(ev, null, 2);
    $("inspector").classList.add("open");
}
function closeInspector() {
    $("inspector").classList.remove("open");
}

function raceEventCard(ev, lane) {
    const { kls, detail } = describe(ev);
    const card = document.createElement("div");
    card.className = "race-event " + kls;
    card.addEventListener("click", () => openInspector(ev, lane));
    const head = document.createElement("div");
    head.className = "ev-head";
    const em = document.createElement("span");
    em.className = "emoji";
    em.textContent = emojiFor(ev);
    const ty = document.createElement("span");
    ty.className = "ev-type";
    ty.textContent = typeLabel(ev);
    head.append(em, ty);
    if (
        (ev.type === "tool_start" || ev.type === "tool_end") &&
        ev.payload &&
        ev.payload.toolName
    ) {
        const tool = document.createElement("span");
        tool.className = "ev-tool";
        tool.textContent = ev.payload.toolName;
        tool.title = ev.payload.toolName;
        head.append(tool);
    }
    const sum = document.createElement("div");
    sum.className = "ev-summary";
    sum.textContent = detail;
    const time = document.createElement("div");
    time.className = "ev-time";
    time.textContent = clock(ev.ts) + " · #" + ev.seq;
    card.append(head, sum, time);
    return card;
}

// Build one instance's turn track (its per-lane timeline) into `parent`.
// `cardLabel` is the short identity on the track's agent card — "#2" within a
// multi-instance group, or the agent name for a lone instance.
function buildRaceTrack(parent, a, b, cardLabel) {
    const cols = [];
    if (b.setup.length) cols.push(-1);
    for (let i = 0; i <= b.maxTurn; i++) cols.push(i);
    // active turn: follow the latest unless the user pinned one or zoomed out.
    if (a.followLatest !== false) a.activeTurn = b.maxTurn;
    else if (a.activeTurn === undefined) a.activeTurn = b.maxTurn;

    const track = document.createElement("div");
    track.className = "race-track" + (a.rollup.active ? " active" : "");

    // agent card
    const agent = document.createElement("div");
    agent.className = "race-agent";
    const top = document.createElement("div");
    top.className = "top";
    const dot = document.createElement("span");
    dot.className = "dot" + (a.rollup.active ? " on" : "");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = cardLabel;
    top.append(dot, nm);
    const model = document.createElement("div");
    model.className = "model";
    model.textContent = a.rollup.model || "";
    model.title = a.rollup.model || "";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
        a.count +
        " events · " +
        b.turnsReached +
        "t\n" +
        fmtCost(a.rollup.costUsd) +
        " · " +
        fmtTok(a.rollup.tokens) +
        " tok";
    agent.append(top, model, meta);
    agent.addEventListener("click", () => selectLane(a.key));
    track.append(agent);

    // turns
    const turns = document.createElement("div");
    turns.className = "race-turns";
    turns.dataset.key = a.key;
    let activeEl = null;
    for (const c of cols) {
        if (turns.childElementCount > 0) {
            const conn = document.createElement("span");
            conn.className = "race-conn";
            turns.append(conn);
        }
        const evs = c === -1 ? b.setup : b.turns.get(c) || [];
        const label = c === -1 ? "SETUP" : "TURN " + c;
        const turn = document.createElement("div");
        const isActive = c === a.activeTurn;
        turn.className = "race-turn " + (isActive ? "active" : "collapsed");

        const head = document.createElement("div");
        head.className = "race-turn-head";
        const lbl = document.createElement("span");
        lbl.className = "race-turn-label";
        lbl.textContent = label;
        const cnt = document.createElement("span");
        cnt.className = "race-turn-count";
        cnt.textContent = evs.length + " events";
        head.append(lbl, cnt);
        turn.append(head);

        if (isActive) {
            activeEl = turn;
            // click the expanded turn's header to collapse (zoom out)
            head.style.cursor = "pointer";
            head.title = "collapse";
            head.addEventListener("click", () => {
                a.activeTurn = null;
                a.followLatest = false;
                renderRace();
            });
            const row = document.createElement("div");
            row.className = "race-events";
            for (const ev of evs) {
                if (row.childElementCount > 0) {
                    const conn = document.createElement("span");
                    conn.className = "ev-conn";
                    row.append(conn);
                }
                row.append(raceEventCard(ev, a));
            }
            turn.append(row);
        } else {
            const snip = turnSnippet(evs);
            if (snip) {
                const s = document.createElement("div");
                s.className = "race-turn-snippet";
                s.textContent = snip;
                s.title = snip;
                turn.append(s);
            }
            turn.addEventListener("click", () => {
                a.activeTurn = c;
                a.followLatest = false;
                renderRace();
            });
        }
        turns.append(turn);
    }
    track.append(turns);
    parent.append(track);

    // follow the latest turn (align it to the start) unless the user pinned one —
    // then restore their horizontal scroll
    if (a.followLatest !== false && activeEl)
        turns.scrollLeft = Math.max(0, activeEl.offsetLeft - turns.offsetLeft - 8);
    else if (raceScroll.has(a.key)) turns.scrollLeft = raceScroll.get(a.key);
}

function renderRace() {
    const tracks = $("race-tracks");
    const list = [...lanes.values()].filter(
        (a) => a.events.length && laneVisible(a),
    );
    if (!list.length) {
        $("race-empty").style.display = "block";
        tracks.innerHTML = "";
        $("race-axis").textContent = "";
        return;
    }
    $("race-empty").style.display = "none";

    // capture current scroll positions before rebuild
    tracks.querySelectorAll(".race-turns").forEach((el) => {
        if (el.dataset.key) raceScroll.set(el.dataset.key, el.scrollLeft);
    });

    let maxTurn = -1;
    let running = 0;
    let leader = null;
    const buckets = new Map();
    for (const a of list) {
        const b = bucketByTurn(a);
        buckets.set(a.key, b);
        if (b.maxTurn > maxTurn) maxTurn = b.maxTurn;
        if (a.rollup.active) running++;
        if (!leader || b.turnsReached > buckets.get(leader.key).turnsReached)
            leader = a;
    }

    // Group instances by agent (project + agent). Within a group the parallel /
    // sequential runs stack as #1, #2, …; groups order by earliest start.
    const groups = new Map();
    for (const a of list) {
        const gk = a.cwd + "\u0000" + a.agent;
        let g = groups.get(gk);
        if (!g) {
            g = { key: gk, agent: a.agent, project: a.project, lanes: [] };
            groups.set(gk, g);
        }
        g.lanes.push(a);
    }
    const groupStart = (g) =>
        Math.min(...g.lanes.map((a) => a.events[0]?.ts || 0));
    const orderedGroups = [...groups.values()].sort(
        (x, y) => groupStart(x) - groupStart(y),
    );

    // When all projects are shown and more than one is present, add a project tier
    // above the agent groups; otherwise render the agent groups flat.
    const distinctProjects = new Set(list.map((a) => a.project));
    const byProject = projectFilter === "" && distinctProjects.size > 1;

    $("race-axis").innerHTML =
        (byProject ? "projects <b>" + distinctProjects.size + "</b> · " : "") +
        "agents <b>" +
        groups.size +
        "</b>" +
        (list.length > groups.size ? " (" + list.length + " instances)" : "") +
        " · turns <b>0–" +
        Math.max(0, maxTurn) +
        "</b>" +
        (leader ? " · leader <b>" + leader.agent + "</b>" : "") +
        (running ? " · <b>" + running + "</b> running" : "");

    tracks.innerHTML = "";
    if (!byProject) {
        for (const g of orderedGroups) buildAgentGroup(tracks, g, buckets, true);
        return;
    }

    // Bucket the (already start-ordered) agent groups by project, preserving order.
    const projs = new Map();
    for (const g of orderedGroups) {
        let p = projs.get(g.project);
        if (!p) {
            p = { project: g.project, groups: [] };
            projs.set(g.project, p);
        }
        p.groups.push(g);
    }
    for (const p of projs.values()) {
        const pcollapsed = projCollapsed(p.project);
        const projEl = document.createElement("div");
        projEl.className = "race-project";

        const phead = document.createElement("div");
        phead.className = "race-project-head clickable";
        const pcaret = document.createElement("span");
        pcaret.className = "gcaret";
        pcaret.textContent = pcollapsed ? "▸" : "▾";
        const prunning = p.groups.reduce(
            (s, g) => s + g.lanes.filter((a) => a.rollup.active).length,
            0,
        );
        const pdot = document.createElement("span");
        pdot.className = "dot" + (prunning ? " on" : "");
        const pnm = document.createElement("span");
        pnm.className = "pnm";
        pnm.textContent = p.project;
        phead.append(pcaret, pdot, pnm);
        const instances = p.groups.reduce((s, g) => s + g.lanes.length, 0);
        const pcost = p.groups.reduce(
            (s, g) => s + g.lanes.reduce((t, a) => t + a.rollup.costUsd, 0),
            0,
        );
        const ptok = p.groups.reduce(
            (s, g) => s + g.lanes.reduce((t, a) => t + a.rollup.tokens, 0),
            0,
        );
        const pmeta = document.createElement("span");
        pmeta.className = "pmeta";
        pmeta.innerHTML =
            p.groups.length +
            " agents" +
            (instances > p.groups.length ? " (" + instances + ")" : "") +
            " · " +
            fmtCost(pcost) +
            " · " +
            fmtTok(ptok) +
            " tok" +
            (prunning ? " · <b>" + prunning + "</b> running" : "");
        phead.append(pmeta);
        phead.title = pcollapsed ? "expand project" : "collapse project";
        phead.addEventListener("click", (e) => {
            e.stopPropagation();
            raceProjCollapsed.set(p.project, !pcollapsed);
            renderRace();
        });
        projEl.append(phead);
        tracks.append(projEl); // attach first so offsetLeft works for turn scroll

        if (!pcollapsed)
            for (const g of p.groups) buildAgentGroup(projEl, g, buckets, false);
    }
}

// Render one agent's group (header + its instance tracks) into `parent`. Set
// `showProj` to include the project tag (omitted when already under a project
// section).
function buildAgentGroup(parent, g, buckets, showProj) {
    g.lanes.sort((x, y) => (x.ord || 0) - (y.ord || 0));

    const multi = g.lanes.length > 1;
    const collapsed = multi && groupCollapsed(g);

    const groupEl = document.createElement("div");
    groupEl.className = "race-group";

    // group header — agent-level identity + rollup across its instances.
    // Multi-instance groups are collapsible; the header toggles them.
    const head = document.createElement("div");
    head.className = "race-group-head";
    if (multi) {
        const caret = document.createElement("span");
        caret.className = "gcaret";
        caret.textContent = collapsed ? "▸" : "▾";
        head.append(caret);
        head.classList.add("clickable");
        head.title = collapsed ? "expand instances" : "collapse instances";
        head.addEventListener("click", (e) => {
            // Don't let the document-level "click outside a turn" handler also
            // fire (it would collapse the turns and double-render).
            e.stopPropagation();
            raceCollapsed.set(g.key, !collapsed);
            renderRace();
        });
    }
    const grunning = g.lanes.filter((a) => a.rollup.active).length;
    const gdot = document.createElement("span");
    gdot.className = "dot" + (grunning ? " on" : "");
    const gnm = document.createElement("span");
    gnm.className = "nm";
    gnm.textContent = g.agent;
    head.append(gdot, gnm);
    if (multi) {
        const c = document.createElement("span");
        c.className = "gcount";
        c.textContent = "×" + g.lanes.length;
        c.title = g.lanes.length + " instances";
        head.append(c);
    }
    if (showProj) {
        const gproj = document.createElement("span");
        gproj.className = "proj-tag";
        gproj.textContent = g.project;
        head.append(gproj);
    }
    // When collapsed, note which instance is shown and how many are hidden.
    const primary = primaryLane(g);
    if (collapsed) {
        const hint = document.createElement("span");
        hint.className = "ghint";
        const k = g.lanes.indexOf(primary) + 1;
        hint.textContent =
            (primary.rollup.active ? "running #" : "#") +
            k +
            " · +" +
            (g.lanes.length - 1) +
            " hidden";
        head.append(hint);
    }
    const gcost = g.lanes.reduce((s, a) => s + a.rollup.costUsd, 0);
    const gtok = g.lanes.reduce((s, a) => s + a.rollup.tokens, 0);
    const gevents = g.lanes.reduce((s, a) => s + a.count, 0);
    const gmeta = document.createElement("span");
    gmeta.className = "gmeta";
    gmeta.innerHTML =
        gevents +
        " events · " +
        fmtCost(gcost) +
        " · " +
        fmtTok(gtok) +
        " tok" +
        (grunning ? " · <b>" + grunning + "</b> running" : "");
    head.append(gmeta);
    groupEl.append(head);
    parent.append(groupEl); // attach first so offsetLeft works for turn scroll

    const shown = collapsed ? [primary] : g.lanes;
    for (const a of shown) {
        const cardLabel = multi ? "#" + (g.lanes.indexOf(a) + 1) : g.agent;
        buildRaceTrack(groupEl, a, buckets.get(a.key), cardLabel);
    }
}

