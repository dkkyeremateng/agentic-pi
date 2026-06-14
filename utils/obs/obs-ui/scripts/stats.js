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

// Empty analytics accumulator.
function newAnalytics() {
    return {
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
}

// Fold one event into an analytics accumulator.
function statAddEvent(a, agent, ev) {
    if (ev.type === "verdict") return; // run-level, not agent activity
    if (a.firstTs === null || ev.ts < a.firstTs) a.firstTs = ev.ts;
    if (a.lastTs === null || ev.ts > a.lastTs) a.lastTs = ev.ts;
    a.agents.add(agent);
    const p = ev.payload || {};
    const ag = a.perAgent.get(agent) || { cost: 0, tokens: 0, turns: 0, tools: 0 };
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
            const t = a.perTool.get(p.toolName || "?") || {
                calls: 0,
                totalMs: 0,
                errors: 0,
            };
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
    a.perAgent.set(agent, ag);
}

// Walk events into aggregates — the visible lanes (optionally scoped to a
// runId), or a fetched archive run's events when `fromArchive` is set.
function collectAnalytics(runId, fromArchive) {
    const a = newAnalytics();
    if (fromArchive) {
        for (const ev of archivedEvents.get(runId) || []) statAddEvent(a, ev.agent, ev);
    } else {
        for (const lane of lanes.values()) {
            if (!laneInProject(lane)) continue;
            if (!laneGroupVisible(lane)) continue; // hidden orchestrator groups drop from stats
            for (const ev of lane.events) {
                if (runId && ev.runId !== runId) continue;
                statAddEvent(a, lane.agent, ev);
            }
        }
    }
    a.costSeries.sort((x, y) => x.ts - y.ts);
    return a;
}

// ── all-runs detail aggregation ──────────────────────────────────────────────
// The headline tiles come from per-run summaries, but the detail cards (latency,
// per-agent, tools, cost-over-time) need events. For the all-runs view we fetch
// the recent runs' events (lazily, capped) and fold them all into one analytics.
const aggEvents = new Map(); // runId -> events[]
const aggPending = new Set();
const AGG_RUN_CAP = 50; // most-recent runs to deep-aggregate

function ensureAggEvents(runId) {
    if (aggEvents.has(runId) || aggPending.has(runId) || archivedEvents.has(runId)) return;
    aggPending.add(runId);
    fetch("/events?run=" + encodeURIComponent(runId))
        .then((r) => r.json())
        .then((evs) => {
            aggEvents.set(runId, (Array.isArray(evs) ? evs : []).map(normalizeEvent));
            while (aggEvents.size > AGG_RUN_CAP)
                aggEvents.delete(aggEvents.keys().next().value);
            if (view === "stats") renderStats();
        })
        .catch(() => {
            /* leave unfetched; a later render retries */
        })
        .finally(() => aggPending.delete(runId));
}

// Deep analytics across the recent runs: live runs from their lanes, finished
// runs from fetched events (kicked off on demand). `pending`/`capped` flag an
// incomplete picture so the UI can note it.
function collectAllRunsDetail(runList, live) {
    const a = newAnalytics();
    let pending = 0;
    for (const r of runList.slice(0, AGG_RUN_CAP)) {
        if (live.has(r.id)) {
            for (const lane of lanes.values()) {
                if (lane.runId !== r.id) continue;
                if (!laneInProject(lane) || !laneGroupVisible(lane)) continue;
                for (const ev of lane.events) statAddEvent(a, lane.agent, ev);
            }
        } else {
            const evs = aggEvents.get(r.id) || archivedEvents.get(r.id);
            if (evs) for (const ev of evs) statAddEvent(a, ev.agent, ev);
            else {
                ensureAggEvents(r.id);
                pending++;
            }
        }
    }
    a.costSeries.sort((x, y) => x.ts - y.ts);
    a.pending = pending;
    a.capped = runList.length > AGG_RUN_CAP;
    return a;
}

// KPI tile; `delta` (optional) renders a vs-previous-run arrow:
// { pct, worse } — worse=true colors it red (more cost/time/errors).
function tile(parent, k, v, cls, delta) {
    const el = document.createElement("div");
    el.className = "tile";
    const kk = document.createElement("div");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("div");
    vv.className = "v" + (cls ? " " + cls : "");
    vv.textContent = v;
    el.append(kk, vv);
    if (delta && isFinite(delta.pct) && delta.pct !== 0) {
        const d = document.createElement("div");
        d.className = "kpi-delta " + (delta.worse ? "bad" : "good");
        d.textContent =
            (delta.pct > 0 ? "▲ " : "▼ ") + Math.abs(delta.pct) + "%";
        d.title = "vs the previous run in this project";
        el.append(d);
    }
    parent.append(el);
}

// vs-previous helper: % change current → prev (rounded), `worse` when up.
function deltaVs(cur, prev) {
    if (prev == null || !isFinite(prev) || prev <= 0 || cur == null) return null;
    const pct = Math.round(((cur - prev) / prev) * 100);
    return { pct, worse: pct > 0 };
}

// Cumulative cost over time — canvas line with crosshair + hover tooltip.
function renderCostTimeline(series, span0, span1) {
    const box = $("stats-timeline");
    if (series.length < 2) {
        box.innerHTML = '<span class="stats-muted">not enough turns yet</span>';
        return;
    }
    let canvas = box.querySelector("canvas");
    if (!canvas) {
        box.innerHTML = "";
        canvas = document.createElement("canvas");
        canvas.className = "chart";
        box.appendChild(canvas);
        const note = document.createElement("div");
        note.className = "stats-muted chart-note";
        note.id = "stats-timeline-note";
        box.appendChild(note);
    }
    let cum = 0;
    const pts = series.map((s) => {
        cum += s.cost;
        return { x: s.ts, y: cum };
    });
    chartLine(canvas, pts, { yFmt: fmtCost, xFmt: clock });
    $("stats-timeline-note").textContent =
        "total " +
        fmtCost(cum) +
        " over " +
        fmtDur(span1 - span0) +
        " · " +
        series.length +
        " turns";
}

// "All runs" aggregate from the per-run summaries (collectRuns carries every
// run's cost/tokens/tools/errors/agents). The live lanes only hold the current
// run's tail, so summing summaries is the only way the headline tiles reflect
// the whole project. Event-derived detail (latency, per-agent, tools, cost
// series) isn't in the summaries — those cards show their empty state; pick a
// run for the full breakdown.
function summaryAggregate(runList) {
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
        perAgent: new Map(),
        perTool: new Map(),
        costSeries: [],
        summary: true,
        runCount: runList.length,
        wallSum: 0,
    };
    for (const r of runList) {
        if (a.firstTs === null || r.firstTs < a.firstTs) a.firstTs = r.firstTs;
        if (a.lastTs === null || r.lastTs > a.lastTs) a.lastTs = r.lastTs;
        for (const ag of r.agents) a.agents.add(ag);
        a.cost += r.costUsd || 0;
        a.tokens += r.tokens || 0;
        a.toolCalls += r.toolCalls || 0;
        a.errors += r.errors || 0;
        a.wallSum += Math.max(0, r.lastTs - r.firstTs);
    }
    return a;
}

function renderStats() {
    const runs = collectRuns();
    const runList = [...runs.values()].sort((x, y) => y.lastTs - x.lastTs);

    // Which runs are live (any of their lanes still active).
    const live = new Set();
    for (const a of lanes.values())
        if (laneInProject(a) && a.rollup.active && a.runId) live.add(a.runId);

    // With only one run "all runs" is redundant — omit it and scope to that run.
    const single = runList.length === 1;
    const scope = single
        ? runList[0].id
        : statsRun && runs.has(statsRun)
          ? statsRun
          : "";

    // Run-picker combobox: "all runs" (when several) + every run.
    const statsLabel = (r) =>
        verdictMark(r.id) +
        runName(r) +
        " · " +
        r.agents.size +
        " agents" +
        (live.has(r.id) ? " · live" : r.archived ? " · archived" : "");
    const items = [
        ...(single
            ? []
            : [{ value: "", label: "all runs", live: live.size > 0 }]),
        ...runList.map((r) => ({
            value: r.id,
            label: statsLabel(r),
            live: live.has(r.id),
        })),
    ];
    const scopeRun = runs.get(scope);
    statsCombo.update(items, scopeRun ? statsLabel(scopeRun) : "all runs", scope);

    // Live dot inside the picker — on when the scoped run is live, or (for "all
    // runs") when any run is live. Same .dot.on used on the agent cards.
    const statsDot = $("stats-run-dot");
    if (statsDot)
        statsDot.classList.toggle("on", scope ? live.has(scope) : live.size > 0);

    // The run-history strip renders independently of the scoped analytics — it
    // works off the server's run index, so it shows even when the lanes are empty.
    renderRunHistory();

    // A non-live scoped run whose events only the sink archive holds in full —
    // fetch them once and aggregate those instead of the lanes. (scopeRun set above)
    const fromArchive =
        !!scopeRun &&
        !live.has(scope) &&
        (scopeRun.archived || archiveHasMore(scopeRun));
    if (fromArchive && !archivedEvents.has(scope)) {
        fetchArchivedRun(scope); // re-renders on arrival
        $("stats-axis").innerHTML = "loading archived run…";
        $("stats-empty").style.display = "none";
        $("stats-body").style.display = "none";
        return;
    }

    // "all runs" → tiles from per-run summaries; a single run → walk its events.
    // The detail cards always need events, so for all-runs they come from `det`
    // (a deep aggregation across the recent runs, fetched lazily).
    const a = scope ? collectAnalytics(scope, fromArchive) : summaryAggregate(runList);
    const det = scope ? a : collectAllRunsDetail(runList, live);
    const has = a.firstTs !== null && a.agents.size > 0;
    $("stats-empty").style.display = has ? "none" : "block";
    $("stats-body").style.display = has ? "" : "none";
    if (!has) {
        $("stats-axis").textContent = "";
        return;
    }

    const wall = a.summary ? a.wallSum : (a.lastTs || 0) - (a.firstTs || 0);
    $("stats-axis").innerHTML =
        "<b>" +
        a.agents.size +
        "</b> agents · " +
        (a.summary
            ? "<b>" + a.runCount + "</b> runs"
            : "<b>" + a.turns + "</b> turns") +
        " · wall <b>" +
        fmtDur(wall) +
        "</b>" +
        (a.summary && det.pending ? " · aggregating…" : "") +
        (scope ? verdictBadge(scope) : "");

    // headline tiles — with vs-previous-run deltas when scoped to one run
    // (the previous run = the latest archive-indexed run in the same project
    // that started earlier; its summary carries cost/duration/errors).
    let prev = null;
    if (scopeRun) {
        for (const s of archiveRuns.values()) {
            if (s.runId === scope) continue;
            if (projectName(s.cwd) !== scopeRun.project) continue;
            if (s.firstTs >= scopeRun.firstTs) continue;
            if (!prev || s.firstTs > prev.firstTs) prev = s;
        }
    }
    const tiles = $("stats-tiles");
    tiles.innerHTML = "";
    // turns / avg tok/s aren't in the run summaries — take them from the event
    // aggregation (`det`) for the all-runs view.
    const avgTps = det.turnMs > 0 ? Math.round((det.outTok / det.turnMs) * 1000) : 0;
    tile(tiles, "cost", fmtCost(a.cost), "ok", prev && deltaVs(a.cost, prev.costUsd));
    tile(tiles, "tokens", fmtTok(a.tokens));
    tile(tiles, "turns", det.turns || (a.summary ? "—" : 0));
    tile(tiles, "tool calls", a.toolCalls);
    tile(
        tiles,
        "errors",
        a.errors + a.toolErrors,
        a.errors + a.toolErrors ? "err" : "",
        prev && deltaVs(a.errors + a.toolErrors, prev.errors),
    );
    tile(tiles, "agents", a.agents.size);
    tile(
        tiles,
        "wall clock",
        fmtDur(wall),
        prev && deltaVs(wall, prev.lastTs - prev.firstTs),
    );
    tile(tiles, "avg tok/s", a.summary && !det.turns ? "—" : avgTps);

    // latency percentiles
    const dur = det.turnDur.slice().sort((x, y) => x - y);
    const pre = det.prefills.slice().sort((x, y) => x - y);
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
    const agentRows = [...det.perAgent.entries()].sort(
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
    const toolRows = [...det.perTool.entries()]
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
        makeSortable(toolBox.querySelector("table"));
    }

    // cost over time
    renderCostTimeline(det.costSeries, det.firstTs || a.firstTs, det.lastTs || a.lastTs);
}

// ── run history (regression strip over every recorded run) ──────────────────
// Works off the server's run index (archiveRuns) + the verdict map: "last N
// runs: X pass · Y fail · pass rate · median cost/duration", one row per run.
// This is the eval loop's payoff — score runs (the workflow auto-emits, or
// `obs-cli score`) and watch the pass rate and cost trend move.
function renderRunHistory() {
    const card = $("stats-runs-card");
    const box = $("stats-runs");
    if (!card || !box) return;
    const rows = [];
    for (const s of archiveRuns.values()) {
        const project = projectName(s.cwd);
        if (projectFilter && project !== projectFilter) continue;
        rows.push({ s, project });
    }
    rows.sort((x, y) => y.s.firstTs - x.s.firstTs);
    if (!rows.length) {
        card.style.display = "none";
        return;
    }
    card.style.display = "block"; // CSS default is none until runs exist
    const recent = rows.slice(0, 12);

    let pass = 0;
    let fail = 0;
    for (const { s } of recent) {
        const v = runVerdicts.get(s.runId);
        if (v && v.status === "pass") pass++;
        else if (v && v.status === "fail") fail++;
    }
    const costs = recent.map(({ s }) => s.costUsd || 0).sort((a, b) => a - b);
    const durs = recent
        .map(({ s }) => s.lastTs - s.firstTs)
        .sort((a, b) => a - b);
    const scored = pass + fail;
    let head = "last <b>" + recent.length + "</b> runs";
    if (scored)
        head +=
            ' · <b class="verd pass">' +
            pass +
            ' pass</b> · <b class="verd fail">' +
            fail +
            " fail</b> · pass rate <b>" +
            Math.round((pass / scored) * 100) +
            "%</b>";
    head +=
        " · median cost <b>" +
        fmtCost(percentile(costs, 50)) +
        "</b> · median duration <b>" +
        fmtDur(percentile(durs, 50)) +
        "</b>";

    const manyProjects = new Set(rows.map((r) => r.project)).size > 1;
    let html =
        '<div class="runhist-head">' +
        head +
        ' <canvas class="spark" title="cost across these runs (oldest → newest)"></canvas></div>';
    html +=
        '<table class="lead"><thead><tr><th>when</th>' +
        (manyProjects ? "<th>project</th>" : "") +
        '<th>run</th><th class="num">agents</th><th class="num">cost</th>' +
        '<th class="num">duration</th><th class="num">errors</th>' +
        "<th>verdict</th></tr></thead><tbody>";
    for (const { s, project } of recent) {
        const badge = verdictBadge(s.runId); // " · <span…>" or ""
        html +=
            '<tr class="runhist-row" data-run="' +
            escHtml(s.runId) +
            '"><td>' +
            fmtWhen(s.firstTs) +
            "</td>" +
            (manyProjects ? "<td>" + escHtml(project) + "</td>" : "") +
            '<td class="tool">' +
            escHtml(s.name || s.runId) +
            '</td><td class="num">' +
            (s.agents ? s.agents.length : 0) +
            '</td><td class="num">' +
            fmtCost(s.costUsd || 0) +
            '</td><td class="num">' +
            fmtDur(s.lastTs - s.firstTs) +
            '</td><td class="num' +
            (s.errors ? " err" : "") +
            '">' +
            (s.errors || "—") +
            "</td><td>" +
            (badge ? badge.slice(3) : '<span class="stats-muted">—</span>') +
            "</td></tr>";
    }
    box.innerHTML = html + "</tbody></table>";
    // header sparkline: cost across the shown runs, oldest → newest
    chartSpark(
        box.querySelector(".spark"),
        [...recent].reverse().map(({ s }) => s.costUsd || 0),
    );
    makeSortable(box.querySelector("table"));
    // row click → run summary in the drawer (+ compare-with-previous action)
    box.querySelectorAll(".runhist-row").forEach((tr) => {
        tr.addEventListener("click", () => {
            const id = tr.getAttribute("data-run");
            const s = archiveRuns.get(id);
            if (!s) return;
            // the run that started right before this one, same project
            let prev = null;
            for (const o of archiveRuns.values()) {
                if (o.runId === id) continue;
                if (projectName(o.cwd) !== projectName(s.cwd)) continue;
                if (o.firstTs >= s.firstTs) continue;
                if (!prev || o.firstTs > prev.firstTs) prev = o;
            }
            openRunDrawer(s, prev ? prev.runId : null);
        });
    });
}

// Run summary in the detail drawer; `prevId` powers "compare with previous".
function openRunDrawer(s, prevId) {
    $("insp-type").textContent = "run · " + (s.name || s.runId);
    $("insp-agent").textContent = projectName(s.cwd);
    $("insp-time").textContent =
        fmtWhen(s.firstTs) + " · " + fmtDur(s.lastTs - s.firstTs);
    $("insp-seq").textContent = s.runId;
    $("insp-typ2").textContent = s.verdict ? s.verdict.status : "unscored";
    $("insp-summary").textContent = [
        fmtCost(s.costUsd || 0) +
            " · " +
            s.events +
            " events · " +
            (s.agents || []).length +
            " agents",
        s.errors ? s.errors + " error(s)" : "no errors",
        s.verdict
            ? "verdict " +
              s.verdict.status +
              (s.verdict.source ? " (" + s.verdict.source + ")" : "") +
              (s.verdict.note ? " — " + s.verdict.note : "")
            : "unscored — `obs-cli score " + s.runId.slice(0, 12) + "… --pass`",
        "agents: " + (s.agents || []).join(", "),
    ].join("\n");
    $("insp-json").textContent = JSON.stringify(s, null, 2);
    const act = $("insp-action");
    if (prevId) {
        act.hidden = false;
        act.textContent = "compare with previous";
        act.onclick = () => {
            cmpA = prevId;
            cmpB = s.runId;
            setView("compare");
            syncHash();
        };
    } else {
        act.hidden = true;
    }
    $("inspector").classList.add("open");
}


// Run-scope picker (combobox — typing filters by name/time/id). Replaces the
// old <select> so every dropdown on the site shares one look + behavior.
const statsCombo = makeCombo({
    input: $("stats-run-q"),
    list: $("stats-run-list"),
    onPick: (v) => {
        statsRun = v;
        renderStats();
        syncHash();
    },
});
