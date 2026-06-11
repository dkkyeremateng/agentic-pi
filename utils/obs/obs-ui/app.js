// Dashboard client for the agent observability server. Vanilla JS, no build.
// Three views over the same SSE stream — Swimlane, Single, Race — and it is
// multi-instance aware: lanes are keyed by project+agent (from each event's
// cwd), so the same agent name in different projects stays on separate lanes.
// A project filter in the header scopes the views to one instance.

const FEED_MAX = 14; // rows kept in a swimlane lane
const EVENTS_CAP = 4000; // events kept per lane

const lanes = new Map(); // key -> { key, agent, project, cwd, events[], rollup, card, btn }
const projects = new Set();
const hidden = new Set(); // lane keys toggled off via the sidebar
let view = "swimlane";
let selected = null; // lane key
let search = "";
let projectFilter = ""; // "" = all projects
let autoscroll = true;

const $ = (id) => document.getElementById(id);

// ── lane identity (project + agent) ──────────────────────────────────────────
function projectName(cwd) {
    if (!cwd) return "local";
    const parts = String(cwd).split("/").filter(Boolean);
    return parts[parts.length - 1] || "local";
}
function laneKey(ev) {
    return (ev.cwd || "") + "\u0000" + ev.agent;
}

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
    ["dispatch", "dispatch"],
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
        case "dispatch_start":
        case "dispatch_retry":
        case "dispatch_end":
            return "dispatch";
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
        case "dispatch_start":
            kls = "dispatch";
            badge = "dispatch→" + (p.agent || "?");
            detail =
                "attempt " + (p.attempt || 1) + (p.task ? " · " + p.task : "");
            break;
        case "dispatch_retry":
            kls = "dispatch";
            badge = "retry " + (p.agent || "?");
            detail =
                "attempt " +
                (p.attempt || 2) +
                (p.reason ? " · " + p.reason : "");
            break;
        case "dispatch_end":
            kls = p.status === "error" ? "err" : "dispatch";
            badge = "dispatch " + (p.status || "done");
            detail =
                (p.agent || "?") +
                (p.reason ? " · " + p.reason : "") +
                (p.attempts && p.attempts > 1 ? " · " + p.attempts + " tries" : "") +
                (p.durationMs ? " · " + fmtMs(p.durationMs) : "");
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

// The full, expand-on-click detail for an event.
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

// `full` (Single view) rows are expandable; swimlane lane rows are static.
function makeRow(ev, full) {
    const { kls, badge, detail } = describe(ev);
    const oneLine = detail.split("\n")[0];
    const row = document.createElement("div");
    row.className = "row" + (full ? " expandable" : " new");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(ev.ts);
    const em = document.createElement("span");
    em.className = "row-emoji";
    em.textContent = emojiFor(ev);
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
        row.append(caret, t, em, b, d);
        row.addEventListener("click", () => {
            const sel = window.getSelection && String(window.getSelection());
            if (sel) return;
            caret.textContent = caret.textContent === "›" ? "⌄" : "›";
            toggleExpand(row, ev);
        });
    } else {
        row.append(t, em, b, d);
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
    if (!laneInProject(a)) a.btn.style.display = "none";
    if (!laneVisible(a)) a.card.el.style.display = "none";
    updateSidebarState(); // highlight the new button for the current view
    return a;
}

function buildSidebarBtn(a) {
    const btn = document.createElement("button");
    btn.className = "sbtn";
    btn.title = a.project + " / " + a.agent + " — click to show/hide";
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
    el.querySelector(".agent").textContent = a.agent;
    el.querySelector(".proj-tag").textContent = a.project;
    el.querySelector(".lane-head").addEventListener("click", () =>
        selectLane(a.key),
    );
    $("lanes").appendChild(el);
    a.card = {
        el,
        feed: el.querySelector(".feed"),
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

// ── single view ──────────────────────────────────────────────────────────────
// Open an agent's full timeline in Single (used by lane headers / race cards,
// not the sidebar, which only toggles visibility).
function selectLane(key) {
    selected = key;
    setView("single");
    updateSidebarState();
    renderSingle();
}

function renderSingle() {
    const a = selected && lanes.get(selected);
    $("single-empty").style.display = a ? "none" : "block";
    $("single-agent").textContent = a ? a.agent : "—";
    $("single-proj").textContent = a ? a.project : "";
    $("single-model").textContent = a && a.rollup.model ? a.rollup.model : "";
    const dot = document.querySelector(".single-dot");
    if (dot) dot.classList.toggle("active", !!(a && a.rollup.active));
    const feed = $("single-feed");
    feed.innerHTML = "";
    if (!a) {
        renderStatbar();
        return;
    }
    const frag = document.createDocumentFragment();
    for (const ev of a.events)
        if (passesFilter(ev)) frag.appendChild(makeRow(ev, true));
    feed.appendChild(frag);
    renderStatbar();
    if (autoscroll) window.scrollTo(0, document.body.scrollHeight);
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
        document
            .querySelectorAll("#chips .chip:not(.act)")
            .forEach((c) => c.classList.add("on"));
        renderSingle();
    });
    const none = document.createElement("span");
    none.className = "chip act";
    none.textContent = "− all";
    none.addEventListener("click", () => {
        filters.clear();
        document
            .querySelectorAll("#chips .chip:not(.act)")
            .forEach((c) => c.classList.remove("on"));
        renderSingle();
    });
    wrap.append(all, none);
}

function setView(v) {
    view = v;
    for (const k of ["swimlane", "single", "race", "trace", "stats"]) {
        $("v-" + k).classList.toggle("on", v === k);
        $(k).classList.toggle("on", v === k);
    }
    if (v === "single") {
        const cur = selected && lanes.get(selected);
        if (cur && !laneVisible(cur)) selected = null;
        renderSingle();
    }
    updateSidebarState();
    if (v === "race") renderRace();
    if (v === "trace") renderTrace();
    if (v === "stats") renderStats();
}

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

// Event inspector (bottom dock) — full detail for a clicked event.
function openInspector(ev, lane) {
    $("insp-type").textContent = emojiFor(ev) + "  " + typeLabel(ev);
    $("insp-agent").textContent =
        (lane ? lane.agent : ev.agent) +
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
    $("race-axis").innerHTML =
        "turns <b>0–" +
        Math.max(0, maxTurn) +
        "</b> · agents <b>" +
        list.length +
        "</b>" +
        (leader ? " · leader <b>" + leader.agent + "</b>" : "") +
        (running ? " · <b>" + running + "</b> running" : "");

    const sorted = [...list].sort(
        (x, y) => (x.events[0]?.ts || 0) - (y.events[0]?.ts || 0),
    );

    tracks.innerHTML = "";
    for (const a of sorted) {
        const b = buckets.get(a.key);
        const cols = [];
        if (b.setup.length) cols.push(-1);
        for (let i = 0; i <= b.maxTurn; i++) cols.push(i);
        // active turn: follow the latest unless the user pinned one or zoomed
        // out (activeTurn === null means all turns collapsed).
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
        nm.textContent = a.agent;
        const proj = document.createElement("span");
        proj.className = "proj-tag";
        proj.textContent = a.project;
        top.append(dot, nm, proj);
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
        tracks.append(track);

        // follow the latest turn (align it to the start) unless the user pinned
        // one — then restore their horizontal scroll
        if (a.followLatest !== false && activeEl)
            turns.scrollLeft = Math.max(0, activeEl.offsetLeft - turns.offsetLeft - 8);
        else if (raceScroll.has(a.key)) turns.scrollLeft = raceScroll.get(a.key);
    }
}

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
                };
                runs.set(ev.runId, r);
            }
            if (ev.ts < r.firstTs) r.firstTs = ev.ts;
            if (ev.ts > r.lastTs) r.lastTs = ev.ts;
            r.agents.add(ev.agent);
        }
    }
    return runs;
}

// Build per-agent span nodes for one run, plus the orchestrator-side dispatch
// annotations (which arrive on the orchestrator lane but describe a child).
function buildTraceNodes(runId) {
    const nodes = new Map(); // agent -> node
    const dispatch = new Map(); // child agent -> { retries, reason, status, attempts }
    for (const a of lanes.values()) {
        if (!laneInProject(a)) continue;
        for (const ev of a.events) {
            if (ev.runId !== runId) continue;
            // dispatch_* events ride on the ORCHESTRATOR lane but describe a child.
            // Route the annotation to the child, but still let the event extend the
            // emitting (orchestrator) span so the root bar spans the whole run.
            if (
                ev.type === "dispatch_start" ||
                ev.type === "dispatch_retry" ||
                ev.type === "dispatch_end"
            ) {
                const child = ev.payload && ev.payload.agent;
                if (child) {
                    const d = dispatch.get(child) || {
                        retries: 0,
                        reason: null,
                        status: null,
                        attempts: 1,
                    };
                    if (ev.type === "dispatch_retry") {
                        d.retries++;
                        if (ev.payload.reason) d.reason = ev.payload.reason;
                    } else if (ev.type === "dispatch_end") {
                        d.status = ev.payload.status || d.status;
                        if (ev.payload.reason) d.reason = ev.payload.reason;
                        if (ev.payload.attempts) d.attempts = ev.payload.attempts;
                    }
                    dispatch.set(child, d);
                }
            }
            let n = nodes.get(ev.agent);
            if (!n) {
                n = {
                    agent: ev.agent,
                    laneKey: a.key,
                    parent: null,
                    firstTs: ev.ts,
                    lastTs: ev.ts,
                    rollup: newRollup(),
                    ended: false,
                };
                nodes.set(ev.agent, n);
            }
            if (ev.ts < n.firstTs) n.firstTs = ev.ts;
            if (ev.ts > n.lastTs) n.lastTs = ev.ts;
            if (ev.parent && !n.parent) n.parent = ev.parent;
            if (ev.type === "session_end") n.ended = true;
            applyRollup(n.rollup, ev);
        }
    }
    for (const [child, d] of dispatch) {
        const n = nodes.get(child);
        if (n) n.dispatch = d;
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

    // Run picker — latest first, with a "follow latest" sentinel.
    sel.innerHTML = "";
    const latest = document.createElement("option");
    latest.value = "";
    latest.textContent = "latest (live)";
    sel.appendChild(latest);
    runList.forEach((r, i) => {
        const o = document.createElement("option");
        o.value = r.id;
        const when = new Date(r.firstTs).toTimeString().slice(0, 8);
        o.textContent =
            (i === 0 ? "● " : "") +
            when +
            " · " +
            r.agents.size +
            " agents · " +
            fmtDur(r.lastTs - r.firstTs);
        sel.appendChild(o);
    });
    sel.value = traceRun && runs.has(traceRun) ? traceRun : "";

    const run = traceRun && runs.get(traceRun) ? runs.get(traceRun) : runList[0];
    traceCurrentRun = run.id;
    const nodes = buildTraceNodes(run.id);
    const t0 = run.firstTs;
    const span = Math.max(1, run.lastTs - run.firstTs);

    // Adjacency: root = no parent (or a parent not present in this run).
    const childrenOf = new Map();
    const roots = [];
    for (const n of nodes.values()) {
        if (n.parent && nodes.has(n.parent)) {
            if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
            childrenOf.get(n.parent).push(n);
        } else {
            roots.push(n);
        }
    }
    const byStart = (arr) => arr.sort((x, y) => x.firstTs - y.firstTs);
    byStart(roots);
    for (const arr of childrenOf.values()) byStart(arr);

    // DFS into a flat, depth-tagged row list.
    const rows = [];
    const walk = (n, depth) => {
        rows.push({ n, depth });
        for (const c of childrenOf.get(n.agent) || []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);

    let running = 0;
    for (const n of nodes.values())
        if (traceStatus(n) === "running") running++;
    $("trace-axis").innerHTML =
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
        row.addEventListener("click", () => selectLane(n.laneKey));

        // label (indented by depth)
        const label = document.createElement("div");
        label.className = "trace-label";
        label.style.paddingLeft = depth * 16 + "px";
        const dot = document.createElement("span");
        dot.className = "dot" + (status === "running" ? " on" : "");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = n.agent;
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
            n.agent +
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

// ── stats (analytics) view ───────────────────────────────────────────────────
// Aggregate metrics computed client-side from the event stream — latency
// percentiles, per-agent cost/tokens, a tool-duration leaderboard, and cumulative
// cost over time. Scopes to one run (shared runId) or all runs in the project.
let statsRun = ""; // "" = all runs; otherwise a pinned runId

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
    );
    return sorted[idx];
}

// Walk visible lanes' events (optionally scoped to a runId) into aggregates.
function collectAnalytics(runId) {
    const a = {
        firstTs: null,
        lastTs: null,
        agents: new Set(),
        turns: 0,
        turnDur: [],
        prefills: [],
        outTok: 0,
        turnMs: 0,
        tokens: 0,
        cost: 0,
        toolCalls: 0,
        toolErrors: 0,
        errors: 0,
        perAgent: new Map(), // agent -> {cost, tokens, turns, tools}
        perTool: new Map(), // tool -> {calls, totalMs, errors}
        costSeries: [], // {ts, cost} per turn_end, in time order
    };
    for (const lane of lanes.values()) {
        if (!laneInProject(lane)) continue;
        for (const ev of lane.events) {
            if (runId && ev.runId !== runId) continue;
            if (a.firstTs === null || ev.ts < a.firstTs) a.firstTs = ev.ts;
            if (a.lastTs === null || ev.ts > a.lastTs) a.lastTs = ev.ts;
            a.agents.add(lane.agent);
            const p = ev.payload || {};
            const ag =
                a.perAgent.get(lane.agent) ||
                { cost: 0, tokens: 0, turns: 0, tools: 0 };
            switch (ev.type) {
                case "turn_end": {
                    a.turns++;
                    ag.turns++;
                    if (p.durationMs) a.turnDur.push(p.durationMs);
                    if (p.prefillMs) a.prefills.push(p.prefillMs);
                    a.turnMs += p.durationMs || 0;
                    if (p.tokens) {
                        a.tokens += p.tokens.total || 0;
                        a.outTok += p.tokens.output || 0;
                        ag.tokens += p.tokens.total || 0;
                    }
                    a.cost += p.costUsd || 0;
                    ag.cost += p.costUsd || 0;
                    a.costSeries.push({ ts: ev.ts, cost: p.costUsd || 0 });
                    break;
                }
                case "tool_start": {
                    a.toolCalls++;
                    ag.tools++;
                    break;
                }
                case "tool_end": {
                    const t =
                        a.perTool.get(p.toolName || "?") ||
                        { calls: 0, totalMs: 0, errors: 0 };
                    t.calls++;
                    t.totalMs += p.durationMs || 0;
                    if (p.isError) {
                        t.errors++;
                        a.toolErrors++;
                    }
                    a.perTool.set(p.toolName || "?", t);
                    break;
                }
                case "error":
                    a.errors++;
                    break;
            }
            a.perAgent.set(lane.agent, ag);
        }
    }
    a.costSeries.sort((x, y) => x.ts - y.ts);
    return a;
}

function tile(parent, k, v, cls) {
    const el = document.createElement("div");
    el.className = "tile";
    const kk = document.createElement("div");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("div");
    vv.className = "v" + (cls ? " " + cls : "");
    vv.textContent = v;
    el.append(kk, vv);
    parent.append(el);
}

function renderCostTimeline(series, span0, span1) {
    const box = $("stats-timeline");
    box.innerHTML = "";
    if (series.length < 2) {
        box.innerHTML = '<span class="stats-muted">not enough turns yet</span>';
        return;
    }
    const t0 = span0,
        t1 = Math.max(span1, span0 + 1);
    let cum = 0;
    const pts = series.map((s) => {
        cum += s.cost;
        return { x: ((s.ts - t0) / (t1 - t0)) * 100, y: cum };
    });
    const maxY = pts[pts.length - 1].y || 1;
    const H = 30,
        W = 100;
    const sx = (x) => x.toFixed(2);
    const sy = (y) => (H - (y / maxY) * (H - 2)).toFixed(2);
    let line = "";
    for (const pt of pts) line += (line ? " L" : "M") + sx(pt.x) + " " + sy(pt.y);
    const area =
        "M0 " +
        H +
        " L" +
        sx(pts[0].x) +
        " " +
        H +
        " " +
        line.replace(/^M/, "L") +
        " L" +
        sx(pts[pts.length - 1].x) +
        " " +
        H +
        " Z";
    box.innerHTML =
        '<svg viewBox="0 0 ' +
        W +
        " " +
        H +
        '" preserveAspectRatio="none">' +
        '<path d="' +
        area +
        '" fill="rgba(122,162,247,0.18)"/>' +
        '<path d="' +
        line +
        '" fill="none" stroke="var(--accent)" stroke-width="0.7" vector-effect="non-scaling-stroke"/>' +
        "</svg>" +
        '<div class="stats-muted" style="font-size:11px;margin-top:4px">' +
        "total " +
        fmtCost(maxY) +
        " over " +
        fmtDur(t1 - t0) +
        " · " +
        series.length +
        " turns</div>";
}

function renderStats() {
    const runs = collectRuns();
    const runList = [...runs.values()].sort((x, y) => y.lastTs - x.lastTs);
    const sel = $("stats-run");
    sel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "all runs";
    sel.appendChild(allOpt);
    runList.forEach((r, i) => {
        const o = document.createElement("option");
        o.value = r.id;
        const when = new Date(r.firstTs).toTimeString().slice(0, 8);
        o.textContent =
            (i === 0 ? "● " : "") + when + " · " + r.agents.size + " agents";
        sel.appendChild(o);
    });
    sel.value = statsRun && runs.has(statsRun) ? statsRun : "";

    const a = collectAnalytics(statsRun && runs.has(statsRun) ? statsRun : "");
    const has = a.firstTs !== null && a.agents.size > 0;
    $("stats-empty").style.display = has ? "none" : "block";
    $("stats-body").style.display = has ? "" : "none";
    if (!has) {
        $("stats-axis").textContent = "";
        return;
    }

    const wall = (a.lastTs || 0) - (a.firstTs || 0);
    $("stats-axis").innerHTML =
        "<b>" +
        a.agents.size +
        "</b> agents · <b>" +
        a.turns +
        "</b> turns · wall <b>" +
        fmtDur(wall) +
        "</b>";

    // headline tiles
    const tiles = $("stats-tiles");
    tiles.innerHTML = "";
    const avgTps = a.turnMs > 0 ? Math.round((a.outTok / a.turnMs) * 1000) : 0;
    tile(tiles, "cost", fmtCost(a.cost), "ok");
    tile(tiles, "tokens", fmtTok(a.tokens));
    tile(tiles, "turns", a.turns);
    tile(tiles, "tool calls", a.toolCalls);
    tile(
        tiles,
        "errors",
        a.errors + a.toolErrors,
        a.errors + a.toolErrors ? "err" : "",
    );
    tile(tiles, "agents", a.agents.size);
    tile(tiles, "wall clock", fmtDur(wall));
    tile(tiles, "avg tok/s", avgTps);

    // latency percentiles
    const dur = a.turnDur.slice().sort((x, y) => x - y);
    const pre = a.prefills.slice().sort((x, y) => x - y);
    const lat = $("stats-latency");
    const latCells = [
        ["turn p50", fmtMs(percentile(dur, 50)) || "—"],
        ["turn p90", fmtMs(percentile(dur, 90)) || "—"],
        ["turn p99", fmtMs(percentile(dur, 99)) || "—"],
        ["turn max", fmtMs(dur[dur.length - 1]) || "—"],
        ["prefill p50", pre.length ? fmtMs(percentile(pre, 50)) : "—"],
        ["gen tok/s", avgTps],
    ];
    lat.innerHTML = '<div class="lat-grid"></div>';
    const latGrid = lat.querySelector(".lat-grid");
    for (const [k, v] of latCells) {
        const c = document.createElement("div");
        c.className = "lat-cell";
        c.innerHTML =
            '<div class="lk"></div><div class="lv"></div>';
        c.querySelector(".lk").textContent = k;
        c.querySelector(".lv").textContent = v;
        latGrid.append(c);
    }

    // per-agent cost/token bars (sorted by cost)
    const agentBox = $("stats-agents");
    agentBox.innerHTML = "";
    const agentRows = [...a.perAgent.entries()].sort(
        (x, y) => y[1].cost - x[1].cost,
    );
    const maxCost = agentRows.reduce((m, [, v]) => Math.max(m, v.cost), 0) || 1;
    if (!agentRows.length)
        agentBox.innerHTML = '<span class="stats-muted">no priced turns yet</span>';
    for (const [name, v] of agentRows) {
        const row = document.createElement("div");
        row.className = "bar-row";
        row.innerHTML =
            '<span class="nm"></span><span class="bar-track">' +
            '<span class="bar-fill cost"></span></span>' +
            '<span class="bv"></span>';
        row.querySelector(".nm").textContent = name;
        row.querySelector(".nm").title = name;
        row.querySelector(".bar-fill").style.width =
            Math.max(2, (v.cost / maxCost) * 100) + "%";
        row.querySelector(".bv").innerHTML =
            "<b>" + fmtCost(v.cost) + "</b> · " + fmtTok(v.tokens);
        agentBox.append(row);
    }

    // tool leaderboard (by total time)
    const toolBox = $("stats-tools");
    const toolRows = [...a.perTool.entries()]
        .sort((x, y) => y[1].totalMs - x[1].totalMs)
        .slice(0, 12);
    if (!toolRows.length) {
        toolBox.innerHTML = '<span class="stats-muted">no tool calls yet</span>';
    } else {
        let html =
            '<table class="lead"><thead><tr><th>tool</th>' +
            '<th class="num">calls</th><th class="num">total</th>' +
            '<th class="num">avg</th><th class="num">errors</th></tr></thead><tbody>';
        for (const [name, v] of toolRows) {
            const avg = v.calls ? v.totalMs / v.calls : 0;
            html +=
                '<tr><td class="tool">' +
                name +
                '</td><td class="num">' +
                v.calls +
                '</td><td class="num">' +
                (fmtMs(v.totalMs) || "—") +
                '</td><td class="num">' +
                (fmtMs(Math.round(avg)) || "—") +
                '</td><td class="num' +
                (v.errors ? " err" : "") +
                '">' +
                (v.errors || "—") +
                "</td></tr>";
        }
        toolBox.innerHTML = html + "</tbody></table>";
    }

    // cost over time
    renderCostTimeline(a.costSeries, a.firstTs, a.lastTs);
}

// ── header ───────────────────────────────────────────────────────────────────
// Header totals reflect the selected project (or all projects when none).
function renderHeader() {
    let agents = 0,
        count = 0,
        tok = 0,
        cost = 0,
        out = 0,
        turnMs = 0,
        errs = 0,
        first = null,
        last = null;
    for (const a of lanes.values()) {
        if (!laneVisible(a)) continue;
        agents++;
        count += a.count;
        const r = a.rollup;
        tok += r.tokens;
        cost += r.costUsd;
        out += r.outTok;
        turnMs += r.turnMs;
        errs += r.toolErrors + r.errors;
        if (a.firstTs != null && (first === null || a.firstTs < first))
            first = a.firstTs;
        if (a.lastTs != null && (last === null || a.lastTs > last))
            last = a.lastTs;
    }
    $("s-agents").textContent = agents;
    $("s-events").textContent = count;
    $("s-tokens").textContent = fmtTok(tok);
    $("s-cost").textContent = fmtCost(cost);
    $("s-tps").textContent = turnMs > 0 ? Math.round((out / turnMs) * 1000) : 0;
    $("s-errors").textContent = errs;
    $("s-elapsed").textContent = first && last ? fmtDur(last - first) : "0s";
}

// ── auto-scroll pause/resume (single view) ───────────────────────────────────
function nearBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
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
$("v-trace").addEventListener("click", () => setView("trace"));
$("trace-run").addEventListener("change", (e) => {
    traceRun = e.target.value;
    renderTrace();
});
$("v-stats").addEventListener("click", () => setView("stats"));
$("stats-run").addEventListener("change", (e) => {
    statsRun = e.target.value;
    renderStats();
});

// ── trace export ──────────────────────────────────────────────────────────────
function downloadBlob(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 0);
}
$("trace-otlp").addEventListener("click", () => {
    if (!traceCurrentRun) return;
    // Server-side OTLP conversion (download triggered by Content-Disposition).
    const a = document.createElement("a");
    a.href =
        "/otel?run=" + encodeURIComponent(traceCurrentRun) + "&download=1";
    a.download = "otel-" + traceCurrentRun + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
});
$("trace-json").addEventListener("click", () => {
    if (!traceCurrentRun) return;
    // Raw events for this run, gathered client-side from the lanes.
    const evs = [];
    for (const lane of lanes.values())
        for (const ev of lane.events)
            if (ev.runId === traceCurrentRun) evs.push(ev);
    evs.sort((x, y) => x.ts - y.ts);
    downloadBlob(
        "run-" + traceCurrentRun + ".jsonl",
        evs.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "application/x-ndjson",
    );
});
$("projfilter").addEventListener("change", (e) => {
    projectFilter = e.target.value;
    try {
        localStorage.setItem("obs.projectFilter", projectFilter);
    } catch {
        /* ignore */
    }
    applyVisibility();
});
$("search").addEventListener("input", (e) => {
    search = e.target.value.trim().toLowerCase();
    renderSingle();
});
$("resume").addEventListener("click", () => {
    autoscroll = true;
    $("resume").classList.remove("show");
    window.scrollTo(0, document.body.scrollHeight);
});
$("insp-close").addEventListener("click", closeInspector);
$("insp-copy").addEventListener("click", () => {
    if (navigator.clipboard)
        navigator.clipboard.writeText($("insp-json").textContent);
    const b = $("insp-copy");
    b.textContent = "copied";
    setTimeout(() => (b.textContent = "copy"), 1000);
});
window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInspector();
});
// Clicking outside an expanded turn (not on a turn, agent card, inspector, or
// header) zooms out — collapses the expanded turn(s).
document.addEventListener("click", (e) => {
    if (view !== "race") return;
    if (
        e.target.closest(".race-turn") ||
        e.target.closest(".race-agent") ||
        e.target.closest("#inspector") ||
        e.target.closest("header")
    )
        return;
    let changed = false;
    for (const a of lanes.values()) {
        if (laneVisible(a) && a.activeTurn != null) {
            a.activeTurn = null;
            a.followLatest = false;
            changed = true;
        }
    }
    if (changed) renderRace();
});
buildChips();
// restore the project filter from a previous session
try {
    projectFilter = localStorage.getItem("obs.projectFilter") || "";
} catch {
    projectFilter = "";
}
if (projectFilter) {
    maybeAddProject(projectFilter); // ensure the option exists + selected
    $("projfilter").value = projectFilter;
}
setInterval(renderHeader, 500);
connect();
