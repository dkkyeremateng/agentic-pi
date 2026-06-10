// Dashboard client for the agent observability server. Vanilla JS, no build.
// Two views over the same SSE stream: Swimlane (a live lane per agent) and
// Single (one agent's full timeline with filters, search, stat bar, and
// pause/resume-live auto-scroll). Mirrors disler/pi-agent-observability.

const FEED_MAX = 14; // rows kept in a swimlane lane
const EVENTS_CAP = 4000; // events kept per agent

const agents = new Map(); // name -> { name, events[], rollup, lane, btn }
let view = "swimlane";
let selected = null;
let search = "";
let autoscroll = true;
let totalEvents = 0;
let firstTs = null;
let lastTs = null;

const $ = (id) => document.getElementById(id);

// ── event categories (filter chips) ──────────────────────────────────────────
const CATS = [
    ["session", "session"],
    ["turn", "turn"],
    ["user", "user"],
    ["assistant", "assistant"],
    ["thinking", "thinking"],
    ["tool", "tool call"],
    ["result", "tool result"],
    ["model", "model"],
    ["compaction", "compaction"],
    ["error", "error"],
];
const filters = new Set(CATS.map((c) => c[0]));

function categoryOf(ev) {
    switch (ev.type) {
        case "session_start":
        case "boot":
        case "session_end":
            return "session";
        case "turn_start":
        case "turn_end":
            return "turn";
        case "message":
            return (ev.payload && ev.payload.kind) || "assistant";
        case "tool_start":
            return "tool";
        case "tool_end":
            return "result";
        case "model_change":
            return "model";
        case "compaction":
            return "compaction";
        case "error":
            return "error";
        default:
            return "session";
    }
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtTok(n) {
    n = Math.round(n || 0);
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
}
function fmtCost(n) {
    n = n || 0;
    return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}
function fmtDur(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m" + String(s % 60).padStart(2, "0") + "s";
}
function fmtMs(ms) {
    if (!ms) return "";
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}
function clock(ts) {
    return new Date(ts).toTimeString().slice(0, 8);
}

// ── describe an event into renderable parts ──────────────────────────────────
function describe(ev) {
    const p = ev.payload || {};
    let kls = "sys";
    let badge = ev.type;
    let detail = "";
    switch (ev.type) {
        case "session_start":
            badge = "start";
            detail = p.model ? "model " + p.model : "";
            break;
        case "boot": {
            badge = "boot";
            const parts = [];
            if (p.tools) parts.push(p.tools.length + " tools");
            if (p.skills) parts.push(p.skills.length + " skills");
            if (p.contextFiles) parts.push(p.contextFiles.length + " ctx");
            if (p.promptChars) parts.push(fmtTok(p.promptChars) + "ch prompt");
            detail = parts.join(" · ");
            break;
        }
        case "session_end":
            badge = "end";
            detail = p.reason || "";
            break;
        case "turn_start":
            kls = "turn";
            badge = "turn " + (p.turnIndex ?? "");
            detail = "thinking…";
            break;
        case "turn_end": {
            kls = "turn";
            badge = "turn " + (p.turnIndex ?? "");
            const tok = p.tokens && p.tokens.total ? fmtTok(p.tokens.total) : "";
            const ctx =
                p.context && p.context.percent != null
                    ? " · ctx " + Math.round(p.context.percent) + "%"
                    : "";
            detail =
                (p.stopReason || "done") +
                (tok ? " · " + tok + " tok" : "") +
                (p.costUsd ? " · " + fmtCost(p.costUsd) : "") +
                (p.durationMs ? " · " + fmtMs(p.durationMs) : "") +
                (p.prefillMs ? " · prefill " + fmtMs(p.prefillMs) : "") +
                (p.tps ? " · " + p.tps + " tok/s" : "") +
                ctx;
            break;
        }
        case "message":
            if (p.kind === "thinking") {
                kls = "think";
                badge = "think";
            } else if (p.kind === "user") {
                kls = "user";
                badge = "user";
            } else {
                kls = "say";
                badge = "say";
            }
            detail = p.text || "";
            break;
        case "tool_start":
            kls = "tool";
            badge = p.toolName || "tool";
            detail = p.arg || "";
            break;
        case "tool_end":
            kls = p.isError ? "err" : "result";
            badge = p.toolName || "tool";
            detail =
                (p.isError ? "ERROR " : "") +
                (p.result || "ok") +
                (p.durationMs ? "  (" + fmtMs(p.durationMs) + ")" : "");
            break;
        case "model_change":
            badge = "model";
            detail = p.model || "";
            break;
        case "compaction":
            badge = "compact";
            detail = "context compacted";
            break;
        case "error":
            kls = "err";
            badge = "error";
            detail =
                (p.source ? p.source + " " : "") + (p.message || p.status || "");
            break;
        default:
            detail = JSON.stringify(p);
    }
    return { kls, badge, detail };
}

// The full, expand-on-click detail for an event (complete tool args/result,
// message text, boot snapshot, or the whole payload as a fallback).
function fullDetail(ev) {
    const p = ev.payload || {};
    switch (ev.type) {
        case "tool_start":
            return (
                (p.argsText || p.arg || "(no args)") +
                (p.argsTruncated ? "\n\n… (args truncated)" : "")
            );
        case "tool_end":
            return (
                (p.resultText || p.result || "(no result)") +
                (p.resultTruncated ? "\n\n… (result truncated)" : "")
            );
        case "message":
            return p.text || "";
        case "boot":
            return JSON.stringify(
                {
                    tools: p.tools,
                    skills: p.skills,
                    contextFiles: p.contextFiles,
                    promptChars: p.promptChars,
                    promptHash: p.promptHash,
                },
                null,
                2,
            );
        default:
            return JSON.stringify(p, null, 2);
    }
}

function toggleExpand(row, ev) {
    const next = row.nextSibling;
    if (next && next.classList && next.classList.contains("xpanel")) {
        next.remove();
        return;
    }
    const panel = document.createElement("div");
    panel.className = "xpanel";
    const pre = document.createElement("pre");
    pre.textContent = fullDetail(ev);
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.textContent = "copy";
    copy.addEventListener("click", (e) => {
        e.stopPropagation();
        if (navigator.clipboard) navigator.clipboard.writeText(pre.textContent);
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1000);
    });
    panel.append(copy, pre);
    row.parentNode.insertBefore(panel, row.nextSibling);
}

// `full` (Single view) rows are expandable; swimlane lane rows are static
// previews — no caret, no click-to-expand, no scroll.
function makeRow(ev, full) {
    const { kls, badge, detail } = describe(ev);
    // The row shows only the first line; the full (multi-line) content lives in
    // the expand panel (Single view) and the title tooltip.
    const oneLine = detail.split("\n")[0];
    const row = document.createElement("div");
    row.className = "row" + (full ? " expandable" : " new");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(ev.ts);
    const b = document.createElement("span");
    b.className = "badge " + kls;
    b.textContent = badge;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = oneLine;
    if (detail) d.title = detail;

    if (full) {
        const caret = document.createElement("span");
        caret.className = "caret";
        caret.textContent = "›";
        row.append(caret, t, b, d);
        row.addEventListener("click", () => {
            // Don't toggle when the user is selecting text.
            const sel = window.getSelection && String(window.getSelection());
            if (sel) return;
            caret.textContent = caret.textContent === "›" ? "⌄" : "›";
            toggleExpand(row, ev);
        });
    } else {
        row.append(t, b, d);
        setTimeout(() => row.classList.remove("new"), 600);
    }
    return row;
}

// ── rollups ──────────────────────────────────────────────────────────────────
function newRollup() {
    return {
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        errors: 0,
        tokens: 0,
        inTok: 0,
        outTok: 0,
        cacheRead: 0,
        cacheWrite: 0,
        turnMs: 0,
        costUsd: 0,
        active: false,
        ctxPercent: null,
        context: null,
        prefillSum: 0,
        prefillCount: 0,
        model: "",
    };
}
function applyRollup(r, ev) {
    const p = ev.payload || {};
    switch (ev.type) {
        case "session_start":
            r.active = true;
            if (p.model) r.model = p.model;
            break;
        case "session_end":
            r.active = false;
            break;
        case "turn_start":
            r.active = true;
            break;
        case "turn_end":
            r.turns++;
            if (p.tokens) {
                r.tokens += p.tokens.total || 0;
                r.inTok += p.tokens.input || 0;
                r.outTok += p.tokens.output || 0;
                r.cacheRead += p.tokens.cacheRead || 0;
                r.cacheWrite += p.tokens.cacheWrite || 0;
            }
            r.turnMs += p.durationMs || 0;
            r.costUsd += p.costUsd || 0;
            if (p.context && p.context.percent != null) {
                r.ctxPercent = p.context.percent;
                r.context = p.context;
            }
            if (p.prefillMs) {
                r.prefillSum += p.prefillMs;
                r.prefillCount++;
            }
            if (p.model) r.model = p.model;
            break;
        case "tool_start":
            r.toolCalls++;
            r.active = true;
            break;
        case "tool_end":
            if (p.isError) r.toolErrors++;
            break;
        case "model_change":
            if (p.model) r.model = p.model;
            break;
        case "error":
            r.errors++;
            break;
    }
}

// ── state plumbing ───────────────────────────────────────────────────────────
function ensureAgent(name) {
    let a = agents.get(name);
    if (a) return a;
    a = { name, events: [], rollup: newRollup(), lane: null, btn: null };
    agents.set(name, a);
    ensureLane(a);
    ensureSidebarBtn(a);
    return a;
}

function ensureSidebarBtn(a) {
    const btn = document.createElement("button");
    btn.className = "sbtn";
    btn.title = a.name;
    btn.textContent = a.name.slice(0, 1).toUpperCase();
    const dot = document.createElement("span");
    dot.className = "live-dot";
    btn.appendChild(dot);
    btn.addEventListener("click", () => selectAgent(a.name));
    $("sbtns").appendChild(btn);
    a.btn = btn;
}

function ensureLane(a) {
    $("empty").style.display = "none";
    const el = document.createElement("div");
    el.className = "lane";
    el.innerHTML =
        '<div class="lane-head"><span class="dot"></span>' +
        '<span class="agent"></span><span class="lane-meta"></span></div>' +
        '<div class="feed"></div>';
    el.querySelector(".agent").textContent = a.name;
    el.querySelector(".lane-head").addEventListener("click", () =>
        selectAgent(a.name),
    );
    $("lanes").appendChild(el);
    a.lane = { el, feed: el.querySelector(".feed"), meta: el.querySelector(".lane-meta") };
}

function laneMeta(a) {
    const r = a.rollup;
    const errs = r.toolErrors + r.errors;
    a.lane.el.classList.toggle("active", r.active);
    a.lane.meta.textContent =
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
    totalEvents++;
    if (firstTs === null || ev.ts < firstTs) firstTs = ev.ts;
    if (lastTs === null || ev.ts > lastTs) lastTs = ev.ts;

    const a = ensureAgent(ev.agent);
    a.events.push(ev);
    if (a.events.length > EVENTS_CAP) a.events.shift();
    applyRollup(a.rollup, ev);

    // swimlane lane (always maintained so switching views is instant)
    a.lane.feed.appendChild(makeRow(ev, false));
    while (a.lane.feed.childElementCount > FEED_MAX)
        a.lane.feed.removeChild(a.lane.feed.firstChild);
    laneMeta(a);

    if (a.btn) a.btn.classList.toggle("active", a.rollup.active);

    // single view (only the selected agent, respecting filters)
    if (view === "single" && ev.agent === selected && passesFilter(ev)) {
        $("single-feed").appendChild(makeRow(ev, true));
        if (autoscroll) window.scrollTo(0, document.body.scrollHeight);
        renderStatbar();
    }
}

// ── single view rendering ────────────────────────────────────────────────────
function selectAgent(name) {
    selected = name;
    setView("single");
    for (const a of agents.values())
        if (a.btn) a.btn.classList.toggle("on", a.name === name);
    renderSingle();
}

function renderSingle() {
    const a = selected && agents.get(selected);
    $("single-empty").style.display = a ? "none" : "block";
    $("single-agent").textContent = a ? a.name : "—";
    $("single-sub").textContent = a && a.rollup.model ? a.rollup.model : "";
    const dot = document.querySelector(".single-dot");
    if (dot) dot.classList.toggle("active", !!(a && a.rollup.active));
    const feed = $("single-feed");
    feed.innerHTML = "";
    if (!a) {
        renderStatbar();
        return;
    }
    const frag = document.createDocumentFragment();
    for (const ev of a.events) if (passesFilter(ev)) frag.appendChild(makeRow(ev, true));
    feed.appendChild(frag);
    renderStatbar();
    if (autoscroll) window.scrollTo(0, document.body.scrollHeight);
}

function renderStatbar() {
    const bar = $("statbar");
    const a = selected && agents.get(selected);
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
        r.prefillCount > 0 ? fmtMs(Math.round(r.prefillSum / r.prefillCount)) : "—";
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

function renderCtxWidget(ctx) {
    const used = ctx && ctx.tokens != null ? ctx.tokens : null;
    const win = ctx && ctx.window ? ctx.window : null;
    const pct = ctx && ctx.percent != null ? ctx.percent : null;
    $("ctx-used").textContent = used != null ? fmtTok(used) : "—";
    $("ctx-win").textContent = win != null ? fmtTok(win) : "—";
    $("ctx-pct").textContent =
        pct != null ? Math.max(0, Math.round(100 - pct)) + "%" : "—";
    $("ctx-fill").style.width = (pct != null ? Math.min(100, pct) : 0) + "%";
}

// ── chips / search / view toggle ─────────────────────────────────────────────
function buildChips() {
    const wrap = $("chips");
    for (const [key, label] of CATS) {
        const c = document.createElement("span");
        c.className = "chip on";
        c.textContent = label;
        c.addEventListener("click", () => {
            if (filters.has(key)) filters.delete(key);
            else filters.add(key);
            c.classList.toggle("on", filters.has(key));
            renderSingle();
        });
        wrap.appendChild(c);
    }
    const all = document.createElement("span");
    all.className = "chip act";
    all.textContent = "+ all";
    all.addEventListener("click", () => {
        for (const [k] of CATS) filters.add(k);
        document.querySelectorAll("#chips .chip:not(.act)").forEach((c) => c.classList.add("on"));
        renderSingle();
    });
    const none = document.createElement("span");
    none.className = "chip act";
    none.textContent = "− all";
    none.addEventListener("click", () => {
        filters.clear();
        document.querySelectorAll("#chips .chip:not(.act)").forEach((c) => c.classList.remove("on"));
        renderSingle();
    });
    wrap.append(all, none);
}

function setView(v) {
    view = v;
    for (const k of ["swimlane", "single", "race"]) {
        $("v-" + k).classList.toggle("on", v === k);
        $(k).classList.toggle("on", v === k);
    }
    if (v === "single") {
        if (!selected && agents.size) selectAgent(agents.keys().next().value);
        else renderSingle();
    }
    if (v === "race") renderRace();
}

// ── race view (turn-normalized: lanes share a turn-index axis; each turn's
// events render as arrows in that turn's cell — so you see who reached which
// step and what they did there) ──────────────────────────────────────────────

// Bucket an agent's events by their turn index. Events before the first turn
// (session_start, boot, …) go to a "setup" bucket (-1).
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

function arrowTitle(ev) {
    const { badge, detail } = describe(ev);
    const d = detail.split("\n")[0];
    return clock(ev.ts) + "  " + badge + (d ? " · " + d : "");
}

function renderRace() {
    const grid = $("race-grid");
    const list = [...agents.values()].filter((a) => a.events.length);
    if (!list.length) {
        $("race-empty").style.display = "block";
        grid.innerHTML = "";
        $("race-axis").textContent = "";
        return;
    }
    $("race-empty").style.display = "none";

    const buckets = new Map();
    let maxTurn = -1;
    let anySetup = false;
    for (const a of list) {
        const b = bucketByTurn(a);
        buckets.set(a.name, b);
        if (b.maxTurn > maxTurn) maxTurn = b.maxTurn;
        if (b.setup.length) anySetup = true;
    }
    const cols = [];
    if (anySetup) cols.push(-1);
    for (let i = 0; i <= maxTurn; i++) cols.push(i);

    const leader = list.reduce(
        (m, a) =>
            buckets.get(a.name).turnsReached > (m ? buckets.get(m.name).turnsReached : -1)
                ? a
                : m,
        null,
    );
    const running = list.filter((a) => a.rollup.active).length;
    $("race-axis").innerHTML =
        "turns <b>0–" +
        Math.max(0, maxTurn) +
        "</b> · agents <b>" +
        list.length +
        "</b>" +
        (leader ? " · leader <b>" + leader.name + "</b>" : "") +
        (running ? " · <b>" + running + "</b> running" : "");

    // stable lane order: by first event time (pipeline order)
    const sorted = [...list].sort(
        (x, y) => (x.events[0]?.ts || 0) - (y.events[0]?.ts || 0),
    );

    const sl = grid.scrollLeft; // preserve horizontal scroll across re-render
    grid.style.gridTemplateColumns = `160px repeat(${cols.length}, 112px)`;
    grid.innerHTML = "";

    const corner = document.createElement("div");
    corner.className = "race-cell rc-corner rc-sticky";
    corner.textContent = "agent";
    grid.appendChild(corner);
    for (const c of cols) {
        const h = document.createElement("div");
        h.className = "race-cell rc-head";
        h.textContent = c === -1 ? "setup" : "turn " + c;
        grid.appendChild(h);
    }

    for (const a of sorted) {
        const b = buckets.get(a.name);
        const lab = document.createElement("div");
        lab.className = "race-cell rc-label rc-sticky";
        const dot = document.createElement("span");
        dot.className = "dot" + (a.rollup.active ? " on" : "");
        const nm = document.createElement("span");
        nm.textContent = a.name;
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = b.turnsReached + "t";
        lab.append(dot, nm, sub);
        lab.addEventListener("click", () => selectAgent(a.name));
        grid.appendChild(lab);

        for (const c of cols) {
            const cell = document.createElement("div");
            cell.className = "race-cell rc-turn";
            const evs = c === -1 ? b.setup : b.turns.get(c) || [];
            if (!evs.length) cell.classList.add("empty");
            for (const ev of evs) {
                const { kls } = describe(ev);
                const m = document.createElement("span");
                m.className = "rc-arrow " + kls;
                m.textContent = "▸";
                m.title = arrowTitle(ev);
                cell.appendChild(m);
            }
            grid.appendChild(cell);
        }
    }
    grid.scrollLeft = sl;
}

// ── header ───────────────────────────────────────────────────────────────────
function renderHeader() {
    $("s-agents").textContent = agents.size;
    $("s-events").textContent = totalEvents;
    let tok = 0,
        cost = 0,
        out = 0,
        turnMs = 0,
        errs = 0;
    for (const a of agents.values()) {
        const r = a.rollup;
        tok += r.tokens;
        cost += r.costUsd;
        out += r.outTok;
        turnMs += r.turnMs;
        errs += r.toolErrors + r.errors;
    }
    $("s-tokens").textContent = fmtTok(tok);
    $("s-cost").textContent = fmtCost(cost);
    $("s-tps").textContent = turnMs > 0 ? Math.round((out / turnMs) * 1000) : 0;
    $("s-errors").textContent = errs;
    $("s-elapsed").textContent =
        firstTs && lastTs ? fmtDur(lastTs - firstTs) : "0s";
}

// ── auto-scroll pause/resume (single view) ───────────────────────────────────
function nearBottom() {
    return (
        window.innerHeight + window.scrollY >=
        document.body.scrollHeight - 40
    );
}
window.addEventListener("scroll", () => {
    if (view !== "single") return;
    if (nearBottom()) {
        autoscroll = true;
        $("resume").classList.remove("show");
    } else {
        autoscroll = false;
        $("resume").classList.add("show");
    }
});

// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
    const es = new EventSource("/stream");
    es.addEventListener("open", () => {
        $("conn").textContent = "live";
        $("conn").classList.add("up");
    });
    es.addEventListener("error", () => {
        $("conn").textContent = "reconnecting…";
        $("conn").classList.remove("up");
    });
    es.addEventListener("obs", (e) => {
        try {
            handle(JSON.parse(e.data));
        } catch {
            /* ignore */
        }
    });
}

// ── init ─────────────────────────────────────────────────────────────────────
$("v-swimlane").addEventListener("click", () => setView("swimlane"));
$("v-single").addEventListener("click", () => setView("single"));
$("v-race").addEventListener("click", () => setView("race"));
$("search").addEventListener("input", (e) => {
    search = e.target.value.trim().toLowerCase();
    renderSingle();
});
$("resume").addEventListener("click", () => {
    autoscroll = true;
    $("resume").classList.remove("show");
    window.scrollTo(0, document.body.scrollHeight);
});
buildChips();
setInterval(renderHeader, 500);
// keep active race bars growing toward "now"
setInterval(() => {
    if (view === "race") renderRace();
}, 400);
connect();
