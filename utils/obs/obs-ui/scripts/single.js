// ── single view — one agent's full timeline (virtualized) ────────────────────
// Rows are fixed-height and windowed (vlist.js), so the feed handles tens of
// thousands of events. turn_start events render as separator rows; clicking
// any row opens the full event in the detail drawer.

// Open an agent's full timeline in Single (used by lane headers / race cards /
// the trace drawer — the rail buttons only toggle visibility).
function selectLane(key) {
    selected = key;
    setView("single");
    updateSidebarState();
    renderSingle();
}

const SINGLE_ROW_H = 26;
let singleVList = null;

function singleList() {
    if (!singleVList)
        singleVList = makeVList({
            container: $("single-feed"),
            scroller: $("content"),
            rowH: SINGLE_ROW_H,
        });
    return singleVList;
}

// Stable hue per agent name so interleaved agents are visually separable.
function agentHue(name) {
    let h = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

// One virtualized row (item = { ev, lane, agent, odd } — `odd` is the turn-CYCLE
// parity: a cycle runs from a turn 0 start to the next, i.e. one user-request
// round; alternating cycles get a tinted background). The Events feed interleaves
// every agent in the run, so each row carries its agent tag.
function makeVRow(item) {
    const ev = item.ev;
    const galt = item.odd ? " galt" : "";
    const hue = agentHue(item.agent);
    if (ev.type === "turn_start") {
        const sep = document.createElement("div");
        const idx = ev.payload?.turnIndex ?? "";
        sep.className = "vsep" + galt + (idx === 0 ? " g0" : "");
        const lbl = document.createElement("span");
        lbl.textContent =
            (item.agent ? item.agent + " · " : "") + "turn " + idx + " · " + clock(ev.ts);
        sep.appendChild(lbl);
        return sep;
    }
    const { kls, badge, detail } = describe(ev);
    const row = document.createElement("div");
    row.className = "row vrow" + galt;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(ev.ts);
    const ag = document.createElement("span");
    ag.className = "vag";
    ag.style.color = "hsl(" + hue + " 60% 70%)";
    ag.textContent = item.agent || "";
    ag.title = item.agent || "";
    const em = iconEl(ev);
    const b = document.createElement("span");
    b.className = "badge " + kls;
    b.textContent = badge;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = detail.split("\n")[0];
    row.append(t, ag, em, b, d);
    // right-aligned extras: tool latency / turn cost+duration
    const p = ev.payload || {};
    let extra = "";
    if (ev.type === "tool_end" && p.durationMs) extra = fmtMs(p.durationMs);
    else if (ev.type === "turn_end")
        extra =
            (p.durationMs ? fmtDur(p.durationMs) + " · " : "") +
            (p.costUsd ? fmtCost(p.costUsd) : "");
    if (extra) {
        const x = document.createElement("span");
        x.className = "vx";
        x.textContent = extra;
        row.append(x);
    }
    row.addEventListener("click", () => {
        const sel = window.getSelection && String(window.getSelection());
        if (sel) return;
        openInspector(ev, item.lane || null);
    });
    return row;
}

// Every in-scope lane of the open run (the Events feed spans all of them).
function singleRunLanes() {
    const out = [];
    for (const l of lanes.values()) if (laneInScope(l)) out.push(l);
    return out.sort((x, y) => (x.firstTs ?? 0) - (y.firstTs ?? 0));
}

function renderSingle() {
    const ls = singleRunLanes();
    const has = ls.length > 0;
    const rid = activeRunScope();
    const rmeta = rid && typeof archiveRuns !== "undefined" ? archiveRuns.get(rid) : null;
    $("single-empty").style.display = has ? "none" : "block";
    $("single-agent").textContent = has ? (rmeta && rmeta.name) || rid || "all agents" : "—";
    $("single-proj").textContent = ls[0] ? ls[0].project : "";
    $("single-model").textContent = has
        ? ls.length + " agent" + (ls.length === 1 ? "" : "s")
        : "";
    const dot = document.querySelector(".single-dot");
    if (dot) dot.classList.toggle("active", ls.some((l) => l.rollup.active));
    const list = singleList();
    if (!has) {
        list.setItems([], makeVRow);
        renderStatbar(ls);
        return;
    }
    // merge every agent's events into one time-ordered feed
    const merged = [];
    for (const l of ls) for (const ev of l.events) merged.push({ ev, lane: l });
    merged.sort((x, y) => x.ev.ts - y.ev.ts || (x.ev.seq || 0) - (y.ev.seq || 0));
    const items = [];
    singleCycle = 0; // turn-cycle counter (a turn 0 start begins a new cycle)
    for (const m of merged) {
        if (isCycleStart(m.ev)) singleCycle++;
        if (m.ev.type === "turn_start" || passesFilter(m.ev))
            items.push({ ev: m.ev, lane: m.lane, agent: m.lane.label, odd: singleCycle % 2 === 1 });
    }
    list.setItems(items, makeVRow);
    renderStatbar(ls);
    if (autoscroll) $("content").scrollTop = $("content").scrollHeight;
}

// A new user-request cycle starts when the agent loop resets to turn 0.
function isCycleStart(ev) {
    return ev.type === "turn_start" && (ev.payload?.turnIndex ?? 0) === 0;
}
let singleCycle = 0; // parity source for live appends (set by renderSingle)

// Live tail: append without rebuilding the whole window. `lane` is the agent the
// event belongs to (the feed spans the whole run).
function singleAppend(ev, lane) {
    if (!singleVList) return renderSingle();
    if (isCycleStart(ev)) singleCycle++;
    singleVList.append({
        ev,
        lane: lane || null,
        agent: lane ? lane.label : "",
        odd: singleCycle % 2 === 1,
    });
    if (autoscroll) $("content").scrollTop = $("content").scrollHeight;
}

// Run-level totals for the Events tab: aggregate the live lanes, then fold in
// the run's indexed summary (which covers the WHOLE run, even agents/events that
// scrolled out of the live buffer) via max — so the numbers reflect the run, not
// just whichever agents are currently buffered.
function renderStatbar(ls) {
    const bar = $("statbar");
    ls = ls || singleRunLanes();
    const rid = activeRunScope();
    const s = rid && typeof archiveRuns !== "undefined" ? archiveRuns.get(rid) : null;
    if (!ls.length && !s) {
        bar.innerHTML = "";
        return;
    }
    let events = 0,
        first = null,
        last = null,
        cost = 0,
        tokens = 0,
        tools = 0,
        errs = 0;
    for (const a of ls) {
        const r = a.rollup;
        events += a.events.length;
        cost += r.costUsd;
        tokens += r.tokens;
        tools += r.toolCalls;
        errs += r.toolErrors + r.errors;
        if (a.firstTs != null && (first === null || a.firstTs < first)) first = a.firstTs;
        if (a.lastTs != null && (last === null || a.lastTs > last)) last = a.lastTs;
    }
    let agents = ls.length;
    if (s) {
        events = Math.max(events, s.events || 0);
        cost = Math.max(cost, s.costUsd || 0);
        tokens = Math.max(tokens, s.tokens || 0);
        tools = Math.max(tools, s.toolCalls || 0);
        errs = Math.max(errs, s.errors || 0);
        agents = Math.max(agents, (s.agents || []).length);
        if (s.firstTs != null && (first === null || s.firstTs < first)) first = s.firstTs;
        if (s.lastTs != null && (last === null || s.lastTs > last)) last = s.lastTs;
    }
    const pills = [
        ["events", events],
        ["duration", fmtDur((last || 0) - (first || 0))],
        ["cost", fmtCost(cost), "cost"],
        ["tokens", fmtTok(tokens)],
        ["tools", tools],
        ["agents", agents],
        ["errors", errs],
    ];
    bar.innerHTML = "";
    for (const [k, v, cls] of pills) {
        const el = document.createElement("span");
        el.className = "pill" + (cls ? " " + cls : "");
        el.innerHTML = k + " <b></b>";
        el.querySelector("b").textContent = v;
        bar.appendChild(el);
    }
}

// The ring gauge drains as the window fills: arc length = % remaining, with
// runway colors (ok ≥40% left, warn ≥15%, err below). Center shows what's left.
const CTX_RING_C = 2 * Math.PI * 15.5; // circumference at r=15.5

function renderCtxWidget(ctx) {
    if (!$("ctxwidget")) return; // removed from the Events header
    const used = ctx && ctx.tokens != null ? ctx.tokens : null;
    const win = ctx && ctx.window ? ctx.window : null;
    const pct = ctx && ctx.percent != null ? ctx.percent : null; // % USED
    const left =
        pct != null ? Math.max(0, Math.min(100, Math.round(100 - pct))) : null;
    $("ctx-used").textContent = used != null ? fmtTok(used) : "—";
    $("ctx-win").textContent = win != null ? fmtTok(win) : "—";
    $("ctx-pct").textContent = left != null ? left + "%" : "—";
    const ring = $("ctx-ring");
    ring.style.strokeDasharray = CTX_RING_C;
    ring.style.strokeDashoffset =
        left != null ? CTX_RING_C * (1 - left / 100) : CTX_RING_C;
    ring.classList.toggle("warn", left != null && left < 40 && left >= 15);
    ring.classList.toggle("err", left != null && left < 15);
    $("ctx-ring-pct").textContent = left != null ? left + "%" : "—";
}
