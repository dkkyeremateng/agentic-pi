// ── compare view (run A vs run B) ────────────────────────────────────────────
// Side-by-side diff of two runs: headline metrics, per-agent cost/tokens/time,
// tool usage, and setup changes from the boot snapshots (prompt hash/size,
// tools, skills, context files). A is the baseline, B the candidate — every
// delta reads "B relative to A". Runs come from the live lanes or the sink
// archive (fetched on demand), so any two runs ever recorded can be compared.
let cmpA = ""; // pinned runIds; "" = auto (A = previous run, B = latest)
let cmpB = "";
let cmpCurrentA = ""; // the ids actually rendered (for the swap button)
let cmpCurrentB = "";

function escHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
        c === "&"
            ? "&amp;"
            : c === "<"
              ? "&lt;"
              : c === ">"
                ? "&gt;"
                : "&quot;",
    );
}

// One run's events: from the lanes when they hold the full run, else from the
// fetched archive. Returns null while the archive fetch is in flight.
function compareEventsOf(run, live) {
    const fromArchive =
        !live.has(run.id) && (run.archived || archiveHasMore(run));
    if (fromArchive) {
        if (!archivedEvents.has(run.id)) {
            fetchArchivedRun(run.id); // re-renders on arrival
            return null;
        }
        return archivedEvents.get(run.id);
    }
    const evs = [];
    for (const a of lanes.values()) {
        if (!laneInProject(a)) continue;
        for (const ev of a.events) if (ev.runId === run.id) evs.push(ev);
    }
    return evs;
}

// Aggregate one run's events into comparable facts. Agents are keyed by BARE
// name (instances merged) — that's the grain that lines up across runs.
function collectRunFacts(events) {
    const f = {
        firstTs: null,
        lastTs: null,
        cost: 0,
        tokens: 0,
        outTok: 0,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        errors: 0,
        retries: 0,
        agents: new Map(), // name -> {cost,tokens,turns,tools,toolErrors,errors,ms,model,boot}
        tools: new Map(), // name -> {calls,totalMs,errors}
    };
    const agentOf = (name) => {
        let a = f.agents.get(name);
        if (!a) {
            a = {
                cost: 0,
                tokens: 0,
                turns: 0,
                tools: 0,
                toolErrors: 0,
                errors: 0,
                ms: 0,
                model: "",
                boot: null,
            };
            f.agents.set(name, a);
        }
        return a;
    };
    for (const ev of events) {
        if (ev.type === "verdict") continue; // run-level, not agent activity
        if (f.firstTs === null || ev.ts < f.firstTs) f.firstTs = ev.ts;
        if (f.lastTs === null || ev.ts > f.lastTs) f.lastTs = ev.ts;
        const p = ev.payload || {};
        const a = agentOf(ev.agent);
        switch (ev.type) {
            case "session_start":
                if (p.model) a.model = p.model;
                break;
            case "boot":
                if (!a.boot) a.boot = p;
                break;
            case "turn_end": {
                f.turns++;
                a.turns++;
                if (p.tokens) {
                    f.tokens += p.tokens.total || 0;
                    f.outTok += p.tokens.output || 0;
                    a.tokens += p.tokens.total || 0;
                }
                f.cost += p.costUsd || 0;
                a.cost += p.costUsd || 0;
                a.ms += p.durationMs || 0;
                if (p.model) a.model = p.model;
                break;
            }
            case "tool_start":
                f.toolCalls++;
                a.tools++;
                break;
            case "tool_end": {
                const t = f.tools.get(p.toolName || "?") || {
                    calls: 0,
                    totalMs: 0,
                    errors: 0,
                };
                t.calls++;
                t.totalMs += p.durationMs || 0;
                if (p.isError) {
                    t.errors++;
                    f.toolErrors++;
                    a.toolErrors++;
                }
                f.tools.set(p.toolName || "?", t);
                break;
            }
            case "dispatch_retry":
                f.retries++;
                break;
            case "error":
                f.errors++;
                a.errors++;
                break;
        }
    }
    f.wall = (f.lastTs || 0) - (f.firstTs || 0);
    return f;
}

// Δ of B relative to A. "Up" (more cost/time/errors) renders red, "down" green —
// these are all spend-like metrics where less is better.
function deltaHtml(a, b, fmt) {
    if (a == null || b == null) return "";
    a = a || 0;
    b = b || 0;
    if (a === b) return ' <span class="delta flat">=</span>';
    const cls = b > a ? "up" : "down";
    const txt =
        a > 0
            ? (b > a ? "+" : "−") + Math.round(Math.abs((b - a) / a) * 100) + "%"
            : "new";
    return (
        ' <span class="delta ' +
        cls +
        '" title="' +
        escHtml(fmt(a) + " → " + fmt(b)) +
        '">' +
        txt +
        "</span>"
    );
}

// "A → B Δ" cell; a null side renders "—" (agent/tool absent from that run).
function cmpCell(a, b, fmt) {
    const fa = a == null ? "—" : fmt(a);
    const fb = b == null ? "—" : fmt(b);
    return escHtml(fa) + " → " + escHtml(fb) + deltaHtml(a, b, fmt);
}

const cmpNum = (n) => String(Math.round(n || 0));

function renderCmpHeadline(A, B) {
    const rows = [
        ["cost", A.cost, B.cost, fmtCost],
        ["tokens", A.tokens, B.tokens, fmtTok],
        ["output tokens", A.outTok, B.outTok, fmtTok],
        ["wall clock", A.wall, B.wall, fmtDur],
        ["turns", A.turns, B.turns, cmpNum],
        ["tool calls", A.toolCalls, B.toolCalls, cmpNum],
        ["tool errors", A.toolErrors, B.toolErrors, cmpNum],
        ["provider errors", A.errors, B.errors, cmpNum],
        ["retries", A.retries, B.retries, cmpNum],
        ["agents", A.agents.size, B.agents.size, cmpNum],
    ];
    let html =
        '<table class="lead"><thead><tr><th>metric</th><th class="num">A</th>' +
        '<th class="num">B</th><th class="num">Δ</th></tr></thead><tbody>';
    for (const [k, a, b, fmt] of rows) {
        html +=
            "<tr><td>" +
            escHtml(k) +
            '</td><td class="num">' +
            escHtml(fmt(a)) +
            '</td><td class="num">' +
            escHtml(fmt(b)) +
            '</td><td class="num">' +
            (deltaHtml(a, b, fmt) || '<span class="delta flat">=</span>') +
            "</td></tr>";
    }
    $("cmp-headline").innerHTML = html + "</tbody></table>";
}

// Union of agent names across both runs, ordered by max cost (descending).
function cmpAgentNames(A, B) {
    const names = new Set([...A.agents.keys(), ...B.agents.keys()]);
    return [...names].sort((x, y) => {
        const cx = Math.max(A.agents.get(x)?.cost || 0, B.agents.get(x)?.cost || 0);
        const cy = Math.max(A.agents.get(y)?.cost || 0, B.agents.get(y)?.cost || 0);
        return cy - cx;
    });
}

function renderCmpAgents(A, B) {
    const names = cmpAgentNames(A, B);
    if (!names.length) {
        $("cmp-agents").innerHTML =
            '<span class="stats-muted">no agents in either run</span>';
        return;
    }
    let html =
        '<table class="lead"><thead><tr><th>agent</th><th class="num">cost</th>' +
        '<th class="num">tokens</th><th class="num">time</th>' +
        '<th class="num">turns</th><th class="num">tools</th></tr></thead><tbody>';
    for (const name of names) {
        const a = A.agents.get(name);
        const b = B.agents.get(name);
        const only = !a
            ? ' <span class="cmp-only">only in B</span>'
            : !b
              ? ' <span class="cmp-only">only in A</span>'
              : "";
        html +=
            '<tr><td class="tool">' +
            escHtml(name) +
            only +
            '</td><td class="num">' +
            cmpCell(a?.cost ?? null, b?.cost ?? null, fmtCost) +
            '</td><td class="num">' +
            cmpCell(a?.tokens ?? null, b?.tokens ?? null, fmtTok) +
            '</td><td class="num">' +
            cmpCell(a?.ms ?? null, b?.ms ?? null, fmtDur) +
            '</td><td class="num">' +
            cmpCell(a?.turns ?? null, b?.turns ?? null, cmpNum) +
            '</td><td class="num">' +
            cmpCell(a?.tools ?? null, b?.tools ?? null, cmpNum) +
            "</td></tr>";
    }
    $("cmp-agents").innerHTML = html + "</tbody></table>";
}

// Boot-snapshot diff for one agent present in both runs — the causal layer:
// "the prompt/tools/context changed, AND the cost moved". Returns change strings.
function diffBoot(a, b) {
    const out = [];
    if (a.model && b.model && a.model !== b.model)
        out.push("model " + a.model + " → " + b.model);
    const ba = a.boot;
    const bb = b.boot;
    if (!ba || !bb) return out; // can't diff setup without both snapshots
    if (ba.promptHash !== bb.promptHash)
        out.push(
            "prompt changed (" +
                fmtTok(ba.promptChars || 0) +
                " → " +
                fmtTok(bb.promptChars || 0) +
                " chars)",
        );
    const nTools = (x) => (Array.isArray(x.tools) ? x.tools.length : null);
    if (nTools(ba) !== null && nTools(bb) !== null && nTools(ba) !== nTools(bb))
        out.push("tools " + nTools(ba) + " → " + nTools(bb));
    const nSkills = (x) => (Array.isArray(x.skills) ? x.skills.length : null);
    if (
        nSkills(ba) !== null &&
        nSkills(bb) !== null &&
        nSkills(ba) !== nSkills(bb)
    )
        out.push("skills " + nSkills(ba) + " → " + nSkills(bb));
    // Context files: pair by path, compare content hashes.
    const fileMap = (x) => {
        const m = new Map();
        for (const f of x.contextFiles || []) if (f && f.path) m.set(f.path, f.hash);
        return m;
    };
    const fa = fileMap(ba);
    const fb = fileMap(bb);
    const base = (p) => String(p).split("/").pop();
    const changed = [];
    const added = [];
    const removed = [];
    for (const [p, h] of fb)
        if (!fa.has(p)) added.push(base(p));
        else if (fa.get(p) !== h) changed.push(base(p));
    for (const p of fa.keys()) if (!fb.has(p)) removed.push(base(p));
    const cap = (arr) =>
        arr.slice(0, 3).join(", ") +
        (arr.length > 3 ? " +" + (arr.length - 3) + " more" : "");
    if (changed.length) out.push("ctx changed: " + cap(changed));
    if (added.length) out.push("ctx added: " + cap(added));
    if (removed.length) out.push("ctx removed: " + cap(removed));
    return out;
}

function renderCmpBoot(A, B) {
    const rows = [];
    for (const name of cmpAgentNames(A, B)) {
        const a = A.agents.get(name);
        const b = B.agents.get(name);
        if (!a || !b) {
            rows.push(
                '<div class="cmp-boot-row"><b>' +
                    escHtml(name) +
                    '</b> <span class="cmp-only">only in ' +
                    (a ? "A" : "B") +
                    "</span></div>",
            );
            continue;
        }
        const changes = diffBoot(a, b);
        if (!changes.length) continue;
        rows.push(
            '<div class="cmp-boot-row"><b>' +
                escHtml(name) +
                "</b> — " +
                changes
                    .map((c) => '<span class="cmp-chg">' + escHtml(c) + "</span>")
                    .join(" ") +
                "</div>",
        );
    }
    $("cmp-boot").innerHTML = rows.length
        ? rows.join("")
        : '<span class="stats-muted">no setup changes between A and B</span>';
}

function renderCmpTools(A, B) {
    const names = new Set([...A.tools.keys(), ...B.tools.keys()]);
    const list = [...names]
        .sort((x, y) => {
            const tx = Math.max(
                A.tools.get(x)?.totalMs || 0,
                B.tools.get(x)?.totalMs || 0,
            );
            const ty = Math.max(
                A.tools.get(y)?.totalMs || 0,
                B.tools.get(y)?.totalMs || 0,
            );
            return ty - tx;
        })
        .slice(0, 14);
    if (!list.length) {
        $("cmp-tools").innerHTML =
            '<span class="stats-muted">no tool calls in either run</span>';
        return;
    }
    let html =
        '<table class="lead"><thead><tr><th>tool</th><th class="num">calls</th>' +
        '<th class="num">total time</th><th class="num">errors</th></tr></thead><tbody>';
    for (const name of list) {
        const a = A.tools.get(name);
        const b = B.tools.get(name);
        html +=
            '<tr><td class="tool">' +
            escHtml(name) +
            '</td><td class="num">' +
            cmpCell(a?.calls ?? null, b?.calls ?? null, cmpNum) +
            '</td><td class="num">' +
            cmpCell(a?.totalMs ?? null, b?.totalMs ?? null, (v) => fmtMs(v) || "0ms") +
            '</td><td class="num">' +
            cmpCell(a?.errors ?? null, b?.errors ?? null, cmpNum) +
            "</td></tr>";
    }
    $("cmp-tools").innerHTML = html + "</tbody></table>";
}

function renderCompare() {
    const runs = collectRuns(); // live + archive, project-filtered (trace.js)
    const runList = [...runs.values()].sort((x, y) => y.lastTs - x.lastTs);
    const body = $("compare-body");
    const empty = $("compare-empty");

    if (runList.length < 2) {
        empty.style.display = "block";
        body.style.display = "none";
        $("compare-axis").textContent = "";
        cmpComboA.update([], "");
        cmpComboB.update([], "");
        return;
    }
    empty.style.display = "none";

    // Which runs are live (any of their lanes still active).
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup.active && a.runId) live.add(a.runId);

    // Defaults: B = the latest run, A = the one before it. A pinned pick that
    // disappeared (project switch, sink rotation) falls back to the default.
    const aId = cmpA && runs.has(cmpA) ? cmpA : runList[1].id;
    const bId = cmpB && runs.has(cmpB) ? cmpB : runList[0].id;
    cmpCurrentA = aId;
    cmpCurrentB = bId;

    // When several projects are in view, qualify labels with the project name.
    const manyProjects = new Set(runList.map((r) => r.project)).size > 1;
    const labelFor = (r) =>
        verdictMark(r.id) +
        (manyProjects ? r.project + " · " : "") +
        (r.name || fmtWhen(r.firstTs)) +
        " · " +
        r.agents.size +
        " agents · " +
        fmtDur(r.lastTs - r.firstTs) +
        (live.has(r.id) ? " · live" : r.archived ? " · archived" : "");
    const items = runList.map((r) => ({
        value: r.id,
        label: labelFor(r),
        live: live.has(r.id),
    }));
    cmpComboA.update(items, labelFor(runs.get(aId)), aId);
    cmpComboB.update(items, labelFor(runs.get(bId)), bId);

    const runA = runs.get(aId);
    const runB = runs.get(bId);
    const evA = compareEventsOf(runA, live);
    const evB = compareEventsOf(runB, live);
    if (!evA || !evB) {
        $("compare-axis").textContent = "loading archived run…";
        body.style.display = "none";
        return;
    }
    body.style.display = "";

    const A = collectRunFacts(evA);
    const B = collectRunFacts(evB);
    const label = (r) => r.name || fmtWhen(r.firstTs);
    $("compare-axis").innerHTML =
        "<b>A</b> " +
        escHtml(label(runA)) +
        " · <b>B</b> " +
        escHtml(label(runB)) +
        " · Δ reads B vs A";
    renderCmpHeadline(A, B);
    renderCmpWaterfalls(runA, runB, evA, evB);
    renderCmpAgents(A, B);
    renderCmpBoot(A, B);
    renderCmpTools(A, B);
}

// Side-by-side mini-waterfalls on ONE shared time scale — the visual diff:
// where each run spent its wall clock, by agent.
function renderCmpWaterfalls(runA, runB, evA, evB) {
    const box = $("cmp-waterfalls");
    box.innerHTML = "";
    const scale = Math.max(
        runA.lastTs - runA.firstTs,
        runB.lastTs - runB.firstTs,
        1,
    );
    const renderOne = (tag, run, evs) => {
        const nodes = buildTraceNodes(
            run.id,
            (function* () {
                for (const ev of evs) yield { ev, laneKey: null };
            })(),
        );
        const list = [...nodes.values()]
            .sort((x, y) => x.firstTs - y.firstTs)
            .slice(0, 8);
        for (const n of list) n.rollup.active = false; // post-hoc views never pulse
        const wrap = document.createElement("div");
        wrap.className = "cmp-wf";
        const head = document.createElement("div");
        head.className = "cmp-wf-head";
        head.innerHTML =
            "<b>" +
            tag +
            "</b> " +
            escHtml(run.name || fmtWhen(run.firstTs)) +
            ' <span class="cmp-wf-dur">' +
            fmtDur(run.lastTs - run.firstTs) +
            "</span>";
        wrap.appendChild(head);
        for (const n of list) {
            const row = document.createElement("div");
            row.className = "cmp-wf-row";
            const lbl = document.createElement("span");
            lbl.className = "cmp-wf-lbl";
            lbl.textContent = n.agent;
            lbl.title = n.agent;
            const track = document.createElement("span");
            track.className = "cmp-wf-track";
            const bar = document.createElement("span");
            bar.className = "cmp-wf-bar " + traceStatus(n);
            const l = ((n.firstTs - run.firstTs) / scale) * 100;
            const w = Math.max(0.5, ((n.lastTs - n.firstTs) / scale) * 100);
            bar.style.left = l + "%";
            bar.style.width = Math.min(100 - l, w) + "%";
            bar.title =
                n.agent +
                " · " +
                fmtDur(n.lastTs - n.firstTs) +
                " · " +
                fmtCost(n.rollup.costUsd);
            track.appendChild(bar);
            row.append(lbl, track);
            wrap.appendChild(row);
        }
        box.appendChild(wrap);
    };
    renderOne("A", runA, evA);
    renderOne("B", runB, evB);
}

// A/B pickers (comboboxes — typing filters by name/time/id).
const cmpComboA = makeCombo({
    input: $("cmp-a-q"),
    list: $("cmp-a-list"),
    onPick: (v) => {
        cmpA = v;
        renderCompare();
        syncHash();
    },
});
const cmpComboB = makeCombo({
    input: $("cmp-b-q"),
    list: $("cmp-b-list"),
    onPick: (v) => {
        cmpB = v;
        renderCompare();
        syncHash();
    },
});
