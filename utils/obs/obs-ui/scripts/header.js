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

