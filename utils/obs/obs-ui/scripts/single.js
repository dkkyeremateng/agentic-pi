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

// One virtualized row (item = { ev, odd } — `odd` is the turn-CYCLE parity:
// a cycle runs from a turn 0 start to the last turn before the next turn 0,
// i.e. one user-request round; alternating cycles get a tinted background).
function makeVRow(item) {
    const ev = item.ev;
    const galt = item.odd ? " galt" : "";
    if (ev.type === "turn_start") {
        const sep = document.createElement("div");
        const idx = ev.payload?.turnIndex ?? "";
        sep.className = "vsep" + galt + (idx === 0 ? " g0" : "");
        const lbl = document.createElement("span");
        lbl.textContent = "turn " + idx + " · " + clock(ev.ts);
        sep.appendChild(lbl);
        return sep;
    }
    const { kls, badge, detail } = describe(ev);
    const row = document.createElement("div");
    row.className = "row vrow" + galt;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(ev.ts);
    const em = iconEl(ev);
    const b = document.createElement("span");
    b.className = "badge " + kls;
    b.textContent = badge;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = detail.split("\n")[0];
    row.append(t, em, b, d);
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
        openInspector(ev, selected ? lanes.get(selected) : null);
    });
    return row;
}

// The lane to show when nothing is selected: the orchestrator (the run's root),
// else the first visible lane.
function defaultSingleLane() {
    let first = null;
    for (const l of lanes.values()) {
        if (!laneVisible(l)) continue;
        if (l.agent === "orchestrator") return l;
        if (!first) first = l;
    }
    return first;
}

function renderSingle() {
    let a = selected && lanes.get(selected);
    // Default to the orchestrator when nothing (valid) is selected, so opening
    // Single lands on the run's root instead of a blank pane.
    if (!a || !laneVisible(a)) {
        a = defaultSingleLane();
        selected = a ? a.key : null;
    }
    $("single-empty").style.display = a ? "none" : "block";
    $("single-agent").textContent = a ? a.label : "—";
    $("single-proj").textContent = a ? a.project : "";
    $("single-model").textContent = a && a.rollup.model ? a.rollup.model : "";
    const dot = document.querySelector(".single-dot");
    if (dot) dot.classList.toggle("active", !!(a && a.rollup.active));
    const list = singleList();
    if (!a) {
        list.setItems([], makeVRow);
        renderStatbar();
        return;
    }
    const items = [];
    singleCycle = 0; // turn-cycle counter (a turn 0 start begins a new cycle)
    for (const ev of a.events) {
        if (isCycleStart(ev)) singleCycle++;
        if (ev.type === "turn_start" || passesFilter(ev))
            items.push({ ev, odd: singleCycle % 2 === 1 });
    }
    list.setItems(items, makeVRow);
    renderStatbar();
    if (autoscroll) $("content").scrollTop = $("content").scrollHeight;
}

// A new user-request cycle starts when the agent loop resets to turn 0.
function isCycleStart(ev) {
    return ev.type === "turn_start" && (ev.payload?.turnIndex ?? 0) === 0;
}
let singleCycle = 0; // parity source for live appends (set by renderSingle)

// Live tail: append without rebuilding the whole window.
function singleAppend(ev) {
    if (!singleVList) return renderSingle();
    if (isCycleStart(ev)) singleCycle++;
    singleVList.append({ ev, odd: singleCycle % 2 === 1 });
    if (autoscroll) $("content").scrollTop = $("content").scrollHeight;
}

function renderStatbar() {
    const bar = $("statbar");
    const a = selected && lanes.get(selected);
    if (!a) {
        bar.innerHTML = "";
        renderCtxWidget(null);
        return;
    }
    const r = a.rollup;
    let first = null,
        last = null;
    for (const ev of a.events) {
        if (first === null || ev.ts < first) first = ev.ts;
        if (last === null || ev.ts > last) last = ev.ts;
    }
    const tps = r.turnMs > 0 ? Math.round((r.outTok / r.turnMs) * 1000) : 0;
    const prefill =
        r.prefillCount > 0
            ? fmtMs(Math.round(r.prefillSum / r.prefillCount))
            : "—";
    const pills = [
        ["events", a.events.length],
        ["duration", fmtDur((last || 0) - (first || 0))],
        ["cost", fmtCost(r.costUsd), "cost"],
        ["in", fmtTok(r.inTok)],
        ["out", fmtTok(r.outTok)],
        ["cache r", fmtTok(r.cacheRead)],
        ["cache w", fmtTok(r.cacheWrite)],
        ["~tps", tps],
        ["prefill", prefill],
        ["errors", r.toolErrors + r.errors],
    ];
    bar.innerHTML = "";
    for (const [k, v, cls] of pills) {
        const el = document.createElement("span");
        el.className = "pill" + (cls ? " " + cls : "");
        el.innerHTML = k + " <b></b>";
        el.querySelector("b").textContent = v;
        bar.appendChild(el);
    }
    renderCtxWidget(r.context);
}

// The ring gauge drains as the window fills: arc length = % remaining, with
// runway colors (ok ≥40% left, warn ≥15%, err below). Center shows what's left.
const CTX_RING_C = 2 * Math.PI * 15.5; // circumference at r=15.5

function renderCtxWidget(ctx) {
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
