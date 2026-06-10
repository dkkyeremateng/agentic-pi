// Dashboard client for the agent observability server. Vanilla JS, no build.
// Connects to /stream (SSE), groups events into per-agent lanes, and renders a
// live feed plus a header rollup. Mirrors the rollup logic in obs-server-core.

const lanes = new Map(); // agent -> { el, feedEl, metaEl, rollup, lastSeen }
const FEED_MAX = 12;
let totalEvents = 0;
let firstTs = null;
let lastTs = null;

const $ = (id) => document.getElementById(id);

function fmtTok(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
}
function fmtCost(n) {
    return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}
function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m" + String(s % 60).padStart(2, "0") + "s";
}
function clock(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
}

function newRollup(agent) {
    return {
        agent,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        errors: 0,
        tokens: 0,
        outTokens: 0,
        turnMs: 0,
        costUsd: 0,
        active: false,
    };
}

function fmtMs(ms) {
    if (!ms) return "";
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

function ensureLane(agent) {
    let lane = lanes.get(agent);
    if (lane) return lane;
    $("empty").style.display = "none";
    const el = document.createElement("div");
    el.className = "lane";
    el.innerHTML =
        '<div class="lane-head"><span class="dot"></span>' +
        '<span class="agent"></span><span class="lane-meta"></span></div>' +
        '<div class="feed"></div>';
    el.querySelector(".agent").textContent = agent;
    $("lanes").appendChild(el);
    lane = {
        el,
        feedEl: el.querySelector(".feed"),
        metaEl: el.querySelector(".lane-meta"),
        rollup: newRollup(agent),
        order: lanes.size,
    };
    lanes.set(agent, lane);
    return lane;
}

function rowFor(ev) {
    const p = ev.payload || {};
    let kls = "sys";
    let key = ev.type;
    let detail = "";
    switch (ev.type) {
        case "session_start":
            key = "start";
            detail = p.model ? "model " + p.model : "";
            break;
        case "boot": {
            kls = "sys";
            key = "boot";
            const parts = [];
            if (p.tools) parts.push(p.tools.length + " tools");
            if (p.skills) parts.push(p.skills.length + " skills");
            if (p.contextFiles)
                parts.push(p.contextFiles.length + " ctx");
            if (p.promptChars) parts.push(fmtTok(p.promptChars) + " ch prompt");
            detail = parts.join(" · ");
            break;
        }
        case "error":
            kls = "err";
            key = "error";
            detail =
                (p.source ? p.source + " " : "") + (p.message || p.status || "");
            break;
        case "message":
            if (p.kind === "thinking") {
                kls = "think";
                key = "think";
            } else if (p.kind === "user") {
                kls = "sys";
                key = "user";
            } else {
                kls = "say";
                key = "say";
            }
            detail = (p.text || "").replace(/\s+/g, " ");
            break;
        case "session_end":
            key = "end";
            detail = p.reason || "";
            break;
        case "turn_start":
            kls = "turn";
            key = "turn " + (p.turnIndex ?? "");
            detail = "thinking…";
            break;
        case "turn_end": {
            kls = "turn";
            key = "turn " + (p.turnIndex ?? "");
            const tok = p.tokens && p.tokens.total ? fmtTok(p.tokens.total) : "";
            detail =
                (p.stopReason || "done") +
                (tok ? " · " + tok + " tok" : "") +
                (p.costUsd ? " · " + fmtCost(p.costUsd) : "") +
                (p.durationMs ? " · " + fmtMs(p.durationMs) : "") +
                (p.tps ? " · " + p.tps + " tok/s" : "");
            break;
        }
        case "tool_start":
            kls = "tool";
            key = p.toolName || "tool";
            detail = p.arg || "";
            break;
        case "tool_end":
            kls = p.isError ? "err" : "tool";
            key = p.toolName || "tool";
            detail =
                (p.isError ? "ERROR " : "") +
                (p.result || "ok") +
                (p.durationMs ? "  (" + fmtMs(p.durationMs) + ")" : "");
            break;
        case "model_change":
            kls = "sys";
            key = "model";
            detail = p.model || "";
            break;
        case "compaction":
            kls = "sys";
            key = "compact";
            detail = "context compacted";
            break;
        default:
            detail = JSON.stringify(p);
    }
    const row = document.createElement("div");
    row.className = "row new";
    row.innerHTML =
        '<span class="t"></span><span class="k ' +
        kls +
        '"></span><span class="d"></span>';
    row.querySelector(".t").textContent = clock(ev.ts);
    row.querySelector(".k").textContent = key;
    const d = row.querySelector(".d");
    d.textContent = detail;
    if (detail) d.title = detail; // full text on hover (rows are single-line)
    setTimeout(() => row.classList.remove("new"), 600);
    return row;
}

function applyRollup(r, ev) {
    const p = ev.payload || {};
    switch (ev.type) {
        case "session_start":
            r.active = true;
            break;
        case "session_end":
            r.active = false;
            break;
        case "turn_start":
            r.active = true;
            break;
        case "turn_end":
            r.turns++;
            r.tokens += (p.tokens && p.tokens.total) || 0;
            r.outTokens += (p.tokens && p.tokens.output) || 0;
            r.turnMs += p.durationMs || 0;
            r.costUsd += p.costUsd || 0;
            break;
        case "tool_start":
            r.toolCalls++;
            r.active = true;
            break;
        case "tool_end":
            if (p.isError) r.toolErrors++;
            break;
        case "error":
            r.errors++;
            break;
    }
}

function handle(ev) {
    totalEvents++;
    if (firstTs === null || ev.ts < firstTs) firstTs = ev.ts;
    if (lastTs === null || ev.ts > lastTs) lastTs = ev.ts;

    const lane = ensureLane(ev.agent);
    applyRollup(lane.rollup, ev);

    lane.feedEl.appendChild(rowFor(ev));
    while (lane.feedEl.childElementCount > FEED_MAX)
        lane.feedEl.removeChild(lane.feedEl.firstChild);
    lane.feedEl.scrollTop = lane.feedEl.scrollHeight;

    const r = lane.rollup;
    lane.el.classList.toggle("active", r.active);
    const errs = r.toolErrors + r.errors;
    lane.metaEl.textContent =
        r.turns +
        "t · " +
        r.toolCalls +
        " tools" +
        (errs ? " · " + errs + " err" : "") +
        " · " +
        fmtTok(r.tokens) +
        " · " +
        fmtCost(r.costUsd);
}

function renderHeader() {
    $("s-agents").textContent = lanes.size;
    $("s-events").textContent = totalEvents;
    let tok = 0,
        cost = 0,
        outTok = 0,
        turnMs = 0,
        errs = 0;
    for (const l of lanes.values()) {
        const r = l.rollup;
        tok += r.tokens;
        cost += r.costUsd;
        outTok += r.outTokens;
        turnMs += r.turnMs;
        errs += r.toolErrors + r.errors;
    }
    $("s-tokens").textContent = fmtTok(tok);
    $("s-cost").textContent = fmtCost(cost);
    $("s-tps").textContent =
        turnMs > 0 ? Math.round((outTok / turnMs) * 1000) : 0;
    $("s-errors").textContent = errs;
    $("s-elapsed").textContent =
        firstTs && lastTs ? fmtDur(lastTs - firstTs) : "0s";
}

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

setInterval(renderHeader, 500);
connect();
