// ── trace (span tree, master–detail) view ────────────────────────────────────
// Left: a hierarchical span tree for one run (orchestrator → sub-agents, and
// under each agent its LLM turns + tool calls). Right: the selected span's
// detail — chips, Input/Output, Metadata, and raw payloads. Ports the React
// Trace tab's master-detail to vanilla.

let spansSelId = null; // selected span id (persists across live re-renders)
let spansItems = new Map(); // id -> span item
let spansEvents = []; // current run's events (time-ordered)
let spansDetailTab = "io"; // detail sub-tab: io | meta | raw

function spanDur(ms) {
    return ms < 1000 ? fmtMs(Math.max(0, Math.round(ms))) : fmtDur(ms);
}

// ── readable tool I/O (ported from the React app's toolArgs) ──────────────────
function sdStr(v) {
    return typeof v === "string" ? v : "";
}
function sdClampLine(t, max) {
    t = String(t || "").replace(/\s+/g, " ").trim();
    return t.length > (max || 600) ? t.slice(0, (max || 600) - 1) + "…" : t;
}
function sdClampBlock(t) {
    const all = String(t || "").replace(/\r/g, "").trim().split("\n");
    let out = all.slice(0, 60).join("\n");
    if (out.length > 6000) out = out.slice(0, 5999) + "…";
    else if (all.length > 60) out += "\n…";
    return out;
}

// tool_start args → the salient argument (file path, command, url, …).
const SD_SALIENT = ["command", "cmd", "file_path", "filePath", "path", "url", "pattern", "query", "prompt", "task"];
function toolArgsText(p) {
    p = p || {};
    let args = {};
    if (p.args && typeof p.args === "object") args = p.args;
    else if (typeof p.argsText === "string") {
        try {
            const o = JSON.parse(p.argsText);
            if (o && typeof o === "object") args = o;
        } catch {
            /* not JSON */
        }
    } else if (p.argsText && typeof p.argsText === "object") args = p.argsText;
    for (const k of SD_SALIENT) {
        if (typeof args[k] === "string" && args[k]) return sdClampLine(args[k]);
        if (typeof p[k] === "string" && p[k]) return sdClampLine(p[k]);
    }
    if (typeof args.old_string === "string" && typeof args.file_path === "string")
        return sdClampLine(args.file_path);
    const parts = Object.entries(args)
        .filter(([, v]) => typeof v === "string" || typeof v === "number")
        .map(([k, v]) => k + ": " + v);
    if (parts.length) return sdClampLine(parts.join(" · "));
    return sdClampLine(sdStr(p.arg));
}

function sdTextField(c) {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && typeof c.text === "string") return c.text;
    return "";
}
// extract result.content[].text (the MCP shape), tolerating a JSON string.
function sdContentText(raw) {
    let obj = raw;
    if (typeof raw === "string") {
        const t = raw.trim();
        if (!(t.startsWith("{") || t.startsWith("["))) return "";
        try {
            obj = JSON.parse(t);
        } catch {
            return "";
        }
    }
    if (!obj || typeof obj !== "object") return "";
    const content = obj.content;
    if (Array.isArray(content)) return content.map(sdTextField).filter(Boolean).join("\n");
    return sdTextField(content);
}
function sdPlainText(raw) {
    if (typeof raw === "string") {
        const t = raw.trim();
        return t.startsWith("{") || t.startsWith("[") ? "" : t;
    }
    if (raw && typeof raw === "object") return sdTextField(raw);
    return "";
}
// tool_end result → readable text (structured content first, then plain stdout).
function toolResultText(p) {
    p = p || {};
    for (const raw of [p.result, p.resultText]) {
        const t = sdContentText(raw);
        if (t) return sdClampBlock(t);
    }
    if (typeof p.summary === "string" && p.summary) return sdClampBlock(p.summary);
    for (const raw of [p.result, p.resultText, p.output, p.stdout, p.text]) {
        const t = sdPlainText(raw);
        if (t) return sdClampBlock(t);
    }
    return "";
}

// ── resizable split (drag the divider) ───────────────────────────────────────
(function () {
    const KEY = "obs.spansSplit";
    const MIN = 280;
    const MAX = 760;
    const setW = (w) => {
        const d = $("spans-detail");
        if (d) d.style.width = w + "px";
    };
    const saved = Number(localStorage.getItem(KEY));
    if (saved >= MIN && saved <= MAX) setW(saved);

    const div = $("spans-divider");
    if (!div) return;
    let dragging = false;
    div.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        dragging = true;
        div.classList.add("drag");
        try {
            div.setPointerCapture(e.pointerId);
        } catch {
            /* ignore */
        }
    });
    div.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const grid = $("spans-grid");
        if (!grid) return;
        let w = grid.getBoundingClientRect().right - e.clientX;
        w = Math.max(MIN, Math.min(MAX, w));
        setW(w);
        try {
            localStorage.setItem(KEY, String(Math.round(w)));
        } catch {
            /* ignore */
        }
    });
    const end = () => {
        dragging = false;
        div.classList.remove("drag");
    };
    div.addEventListener("pointerup", end);
    div.addEventListener("pointercancel", end);
})();

// Agent hierarchy rows (orchestrator → children), mirroring the Timeline's tree.
function buildSpanAgentRows(nodes) {
    const byStart = (arr) => arr.sort((x, y) => x.firstTs - y.firstTs);
    const nameCount = new Map();
    for (const n of nodes.values())
        nameCount.set(n.agent, (nameCount.get(n.agent) || 0) + 1);
    const seen = new Map();
    for (const n of byStart([...nodes.values()])) {
        const i = seen.get(n.agent) || 0;
        seen.set(n.agent, i + 1);
        n.label = nameCount.get(n.agent) > 1 ? n.agent + " #" + (i + 1) : n.agent;
    }
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
        } else roots.push(n);
    }
    byStart(roots);
    for (const arr of childrenOf.values()) byStart(arr);
    const rows = [];
    const walk = (n, depth) => {
        rows.push({ n, depth });
        for (const c of childrenOf.get(n.sessionId) || []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return rows;
}

// LLM-turn + tool-call spans for one session, time-ordered.
function sessionChildSpans(sessionId, events) {
    const out = [];
    const openTurn = [];
    const openTool = new Map();
    for (const ev of events) {
        if (ev.sessionId !== sessionId) continue;
        const p = ev.payload || {};
        if (ev.type === "turn_start") {
            openTurn.push({ ts: ev.ts, idx: p.turnIndex, model: p.model });
        } else if (ev.type === "turn_end") {
            const o = openTurn.pop() || { ts: ev.ts, idx: p.turnIndex, model: p.model };
            out.push({
                kind: "llm",
                ts: o.ts,
                end: ev.ts,
                label:
                    (o.model || p.model || "model") +
                    " · turn " +
                    (o.idx != null ? o.idx : p.turnIndex != null ? p.turnIndex : "?"),
                tokens: p.tokens && p.tokens.total ? p.tokens.total : 0,
                cost: p.costUsd || 0,
                error: false,
                ev,
                start: null,
            });
        } else if (ev.type === "tool_start") {
            const id = p.toolCallId != null ? p.toolCallId : "t" + ev.seq;
            openTool.set(id, { ev, name: p.tool || p.name || p.toolName || "tool" });
        } else if (ev.type === "tool_end") {
            const id = p.toolCallId != null ? p.toolCallId : null;
            const o = (id != null && openTool.get(id)) || null;
            out.push({
                kind: "tool",
                ts: o ? o.ev.ts : ev.ts,
                end: ev.ts,
                label: (o ? o.name : p.tool || p.name || p.toolName) || "tool",
                error: p.isError === true,
                ev,
                start: o ? o.ev : null,
            });
            if (o && id != null) openTool.delete(id);
        }
    }
    return out.sort((a, b) => a.ts - b.ts);
}

function spanRowEl(item, kindLabel, meta) {
    const row = document.createElement("button");
    row.className = "span-row " + item.kind + (item.status === "error" ? " err" : "");
    row.dataset.id = item.id;
    row.style.paddingLeft = 10 + item.depth * 18 + "px";
    const kind = document.createElement("span");
    kind.className = "span-kind " + item.kind;
    kind.textContent = kindLabel;
    const nm = document.createElement("span");
    nm.className = "span-nm";
    nm.textContent = item.label;
    nm.title = item.label;
    const m = document.createElement("span");
    m.className = "span-meta";
    m.textContent = meta || "";
    const dur = document.createElement("span");
    dur.className = "span-dur";
    dur.textContent = spanDur(item.end - item.ts);
    row.append(kind, nm, m, dur);
    row.addEventListener("click", () => {
        spansSelId = item.id;
        applySpanSelection();
    });
    return row;
}

function renderSpans() {
    const tree = $("spans-tree");
    const empty = $("spans-empty");
    const grid = $("spans-grid");
    const head = $("spans-head");
    if (!tree) return;
    const runs = collectRuns();
    const run =
        (traceRun && runs.get(traceRun)) ||
        [...runs.values()].sort((a, b) => b.lastTs - a.lastTs)[0];
    if (!run) {
        if (empty) empty.style.display = "block";
        if (grid) grid.style.display = "none";
        if (head) head.style.display = "none";
        tree.innerHTML = "";
        return;
    }
    if (empty) empty.style.display = "none";
    if (grid) grid.style.display = "";
    if (head) head.style.display = "";

    // live vs archived run (same resolution as the Timeline tab)
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup.active && a.runId) live.add(a.runId);
    const fromArchive = !live.has(run.id) && (run.archived || archiveHasMore(run));
    if (fromArchive && !archivedEvents.has(run.id)) {
        fetchArchivedRun(run.id); // re-renders on arrival
        tree.innerHTML = '<div class="span-skel skeleton"></div>'.repeat(4);
        return;
    }

    const events = [];
    for (const { ev } of fromArchive ? archiveRunEvents(run.id) : laneRunEvents(run.id))
        events.push(ev);
    events.sort((a, b) => a.ts - b.ts || (a.seq || 0) - (b.seq || 0));
    spansEvents = events;

    const nodes = buildTraceNodes(
        run.id,
        (function* () {
            for (const ev of events) yield { ev, laneKey: null };
        })(),
    );
    const rows = buildSpanAgentRows(nodes);
    spansItems = new Map();
    tree.innerHTML = "";
    if (!rows.length) {
        if (empty) empty.style.display = "block";
        if ($("spans-count")) $("spans-count").textContent = "0";
        renderSpanDetail(null);
        return;
    }
    for (const { n, depth } of rows) {
        const r = n.rollup;
        const ai = {
            id: n.sessionId,
            kind: "agent",
            depth,
            label: n.label,
            ts: n.firstTs,
            end: n.lastTs,
            status: traceStatus(n),
            node: n,
            sessionId: n.sessionId,
        };
        spansItems.set(ai.id, ai);
        tree.appendChild(
            spanRowEl(
                ai,
                "AGENT",
                r.turns + "t · " + r.toolCalls + " tools · " + fmtTok(r.tokens) + " · " + fmtCost(r.costUsd),
            ),
        );
        for (const sp of sessionChildSpans(n.sessionId, events)) {
            const id = n.sessionId + "#" + sp.kind + "#" + sp.end + "#" + (sp.ev.seq || 0);
            const it = {
                id,
                kind: sp.kind,
                depth: depth + 1,
                label: sp.label,
                ts: sp.ts,
                end: sp.end,
                status: sp.error ? "error" : "done",
                ev: sp.ev,
                start: sp.start,
                sessionId: n.sessionId,
            };
            spansItems.set(id, it);
            tree.appendChild(
                spanRowEl(
                    it,
                    sp.kind === "llm" ? "LLM" : "TOOL",
                    sp.kind === "llm"
                        ? fmtTok(sp.tokens) + " · " + fmtCost(sp.cost)
                        : sp.error
                          ? "error"
                          : "",
                ),
            );
        }
    }
    if (head && $("spans-count")) $("spans-count").textContent = spansItems.size;
    // keep the selection (or default to the root agent)
    if (!spansSelId || !spansItems.has(spansSelId))
        spansSelId = rows.length ? rows[0].n.sessionId : null;
    applySpanSelection();
}

function applySpanSelection() {
    const tree = $("spans-tree");
    if (tree)
        for (const btn of tree.querySelectorAll(".span-row"))
            btn.classList.toggle("sel", btn.dataset.id === spansSelId);
    renderSpanDetail(spansItems.get(spansSelId) || null);
}

// ── detail panel ─────────────────────────────────────────────────────────────
function buildSpanDetail(item) {
    const sv = (v) => (typeof v === "string" ? v : "");
    const sess = spansEvents.filter((e) => e.sessionId === item.sessionId);
    const within = sess.filter((e) => e.ts >= item.ts && e.ts <= item.end);
    const latency = spanDur(item.end - item.ts);

    const meta = [
        ["kind", item.kind],
        ["agent", item.node ? item.node.agent : (sess[0] && sess[0].agent) || ""],
    ];
    const parent = (sess.find((e) => e.parent) || {}).parent;
    if (parent) meta.push(["parent", parent]);
    const model = sv((sess.find((e) => e.payload && typeof e.payload.model === "string") || { payload: {} }).payload.model);
    if (model) meta.push(["model", model]);
    meta.push(["session", item.sessionId]);
    meta.push(["started", clock(item.ts)]);
    meta.push(["ended", clock(item.end)]);
    meta.push(["events", String(within.length)]);

    let chips = [];
    let io = [];
    let rawEv = [];
    if (item.kind === "agent") {
        const r = item.node.rollup;
        chips = [
            ["span", item.node.agent],
            ["latency", latency],
            ["tokens", fmtTok(r.tokens)],
            ["cost", fmtCost(r.costUsd)],
            ["tools", String(r.toolCalls)],
        ];
        const d = item.node.dispatch;
        if (d && d.retries) chips.push(["retry", "×" + d.retries, true]);
        const disp = spansEvents
            .filter((e) => e.type === "dispatch_start" && e.payload && e.payload.agent === item.node.agent)
            .pop();
        io.push(["Input", "dispatch task", disp ? sv(disp.payload.task) || "(no task text)" : "session started"]);
        const lastMsg = [...sess].reverse().find((e) => e.type === "message" && e.payload && (e.payload.text || e.payload.content));
        const lastTurn = [...sess].reverse().find((e) => e.type === "turn_end");
        if (lastMsg) io.push(["Output", "message", sv(lastMsg.payload.text) || sv(lastMsg.payload.content)]);
        else if (lastTurn) {
            const p = lastTurn.payload || {};
            io.push(["Output", "latest turn", (sv(p.stopReason) || "end_turn") + " · " + fmtTok((p.tokens && p.tokens.total) || 0) + " tok · " + fmtCost(p.costUsd || 0)]);
        } else io.push(["Output", "status", r.active && !r.ended ? "running…" : "done"]);
        rawEv = within.slice(0, 8);
    } else if (item.kind === "tool") {
        const p = (item.start && item.start.payload) || (item.ev && item.ev.payload) || {};
        chips = [
            ["tool", item.label],
            ["latency", latency],
            ["status", item.status, item.status === "error"],
        ];
        io.push(["Input", item.label, toolArgsText((item.start && item.start.payload) || p) || "(no args)"]);
        io.push([
            "Output",
            item.status === "error" ? "error" : "result",
            toolResultText(item.ev && item.ev.payload) || (item.status === "error" ? "failed" : "ok"),
        ]);
        rawEv = [item.start, item.ev].filter(Boolean);
    } else {
        const p = (item.ev && item.ev.payload) || {};
        chips = [
            ["turn", item.label],
            ["latency", latency],
            ["tokens", fmtTok((p.tokens && p.tokens.total) || 0)],
            ["cost", fmtCost(p.costUsd || 0)],
        ];
        if (typeof p.contextPct === "number") chips.push(["ctx", p.contextPct + "%"]);
        io.push(["Input", "prompt", "turn " + (p.turnIndex != null ? p.turnIndex : "?") + " · " + (sv(p.model) || "model")]);
        io.push(["Output", "completion", (sv(p.stopReason) || "end_turn") + " · " + fmtTok((p.tokens && p.tokens.total) || 0) + " tok"]);
        rawEv = [item.ev].filter(Boolean);
    }
    return { chips, io, meta, rawEv, kindLabel: item.kind === "agent" ? "AGENT" : item.kind === "llm" ? "LLM" : "TOOL" };
}

const SD_TABS = [
    ["io", "I/O"],
    ["meta", "Metadata"],
    ["raw", "Raw"],
];

function spanDetailBody(d, tab) {
    if (tab === "meta") {
        return (
            '<div class="sd-meta">' +
            d.meta
                .map((m) => '<div class="sd-mrow"><span>' + escHtml(m[0]) + "</span><b>" + escHtml(m[1]) + "</b></div>")
                .join("") +
            "</div>"
        );
    }
    if (tab === "raw") {
        if (!d.rawEv.length) return '<div class="span-detail-empty small">No payloads in this span.</div>';
        return d.rawEv
            .map(
                (ev) =>
                    '<div class="sd-io"><div class="sd-io-h">' +
                    escHtml(ev.type) +
                    " · " +
                    clock(ev.ts) +
                    "</div><pre>" +
                    escHtml(JSON.stringify(ev.payload, null, 2)) +
                    "</pre></div>",
            )
            .join("");
    }
    // io — Input / Output blocks, each with a role sub-label (· read, · result)
    if (!d.io.length) return '<div class="span-detail-empty small">No I/O.</div>';
    return d.io
        .map(
            ([title, role, text]) =>
                '<div class="sd-io"><div class="sd-io-h"><b>' +
                escHtml(title) +
                "</b>" +
                (role ? ' <span class="sd-role">· ' + escHtml(role) + "</span>" : "") +
                "</div><pre>" +
                escHtml(text || "") +
                "</pre></div>",
        )
        .join("");
}

function renderSpanDetail(item) {
    const panel = $("spans-detail");
    if (!panel) return;
    if (!item) {
        panel.innerHTML = '<div class="span-detail-empty">Select a span.</div>';
        return;
    }
    const d = buildSpanDetail(item);
    const tab = spansDetailTab;
    panel.innerHTML =
        '<div class="sd-chips">' +
        d.chips
            .map((c) => '<span class="sd-chip' + (c[2] ? " w" : "") + '">' + escHtml(c[0]) + " <b>" + escHtml(c[1]) + "</b></span>")
            .join("") +
        "</div>" +
        '<div class="sd-tabs" role="tablist">' +
        SD_TABS.map(
            (t) =>
                '<button class="sd-tab' +
                (tab === t[0] ? " on" : "") +
                '" role="tab" data-tab="' +
                t[0] +
                '">' +
                t[1] +
                "</button>",
        ).join("") +
        "</div>" +
        '<div class="sd-body">' +
        spanDetailBody(d, tab) +
        "</div>";
    for (const b of panel.querySelectorAll(".sd-tab"))
        b.addEventListener("click", () => {
            spansDetailTab = b.dataset.tab;
            renderSpanDetail(spansItems.get(spansSelId) || item);
        });
}
