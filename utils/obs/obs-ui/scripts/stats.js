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

// Walk events into aggregates — the visible lanes (optionally scoped to a
// runId), or a fetched archive run's events when `fromArchive` is set.
function collectAnalytics(runId, fromArchive) {
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
    // Shared per-event accumulator — fed from the live lanes or, for a run
    // that only the sink archive still holds, from its fetched events.
    const add = (agent, ev) => {
        if (a.firstTs === null || ev.ts < a.firstTs) a.firstTs = ev.ts;
        if (a.lastTs === null || ev.ts > a.lastTs) a.lastTs = ev.ts;
        a.agents.add(agent);
        const p = ev.payload || {};
        const ag =
            a.perAgent.get(agent) || { cost: 0, tokens: 0, turns: 0, tools: 0 };
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
        a.perAgent.set(agent, ag);
    };
    if (fromArchive) {
        for (const ev of archivedEvents.get(runId) || []) add(ev.agent, ev);
    } else {
        for (const lane of lanes.values()) {
            if (!laneInProject(lane)) continue;
            for (const ev of lane.events) {
                if (runId && ev.runId !== runId) continue;
                add(lane.agent, ev);
            }
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

    sel.innerHTML = "";
    if (!single) {
        const allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "all runs";
        sel.appendChild(allOpt);
    }
    runList.forEach((r) => {
        const o = document.createElement("option");
        o.value = r.id;
        const isLive = live.has(r.id);
        if (isLive) o.style.color = "var(--ok)";
        o.textContent =
            (r.name || fmtWhen(r.firstTs)) +
            " · " +
            r.agents.size +
            " agents" +
            (isLive ? " · live" : r.archived ? " · archived" : "");
        sel.appendChild(o);
    });
    sel.value = scope;

    // Live dot inside the picker — on when the scoped run is live, or (for "all
    // runs") when any run is live. Same .dot.on used on the agent cards.
    const statsDot = $("stats-run-dot");
    if (statsDot)
        statsDot.classList.toggle("on", scope ? live.has(scope) : live.size > 0);

    // A non-live scoped run whose events only the sink archive holds in full —
    // fetch them once and aggregate those instead of the lanes.
    const scopeRun = scope ? runs.get(scope) : null;
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

    const a = collectAnalytics(scope, fromArchive);
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

