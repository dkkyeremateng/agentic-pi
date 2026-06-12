// ── header ───────────────────────────────────────────────────────────────────
// Header totals reflect the selected project (or all projects when none).

// Lane health, evaluated on the header tick (so it moves without new events):
// an ACTIVE lane gone quiet for 3× its own average turn time (min 60s) is
// "stalled" — usually a hung tool or a stuck provider call worth looking at.
function laneStalled(a, now) {
    const r = a.rollup;
    if (!r.active || a.lastTs == null) return false;
    const avgTurn = r.turns > 0 ? r.turnMs / r.turns : 0;
    return now - a.lastTs > Math.max(60_000, 3 * avgTurn);
}

function renderHeader() {
    let agents = 0,
        count = 0,
        tok = 0,
        cost = 0,
        out = 0,
        turnMs = 0,
        errs = 0,
        first = null,
        last = null,
        stalled = 0,
        trouble = 0;
    const now = Date.now();
    for (const a of lanes.values()) {
        if (!laneVisible(a)) {
            if (a.card) a.card.el.classList.remove("stalled");
            continue;
        }
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
        // health: amber = active but quiet too long; red = provider errors
        const isStalled = laneStalled(a, now);
        if (isStalled) stalled++;
        if (r.errors > 0) trouble++;
        if (a.card) {
            a.card.el.classList.toggle("stalled", isStalled);
            if (isStalled)
                a.card.el.title =
                    a.label + " — no events for " + fmtDur(now - a.lastTs);
            else a.card.el.removeAttribute("title");
        }
    }
    $("s-agents").textContent = agents;
    $("s-events").textContent = count;
    $("s-tokens").textContent = fmtTok(tok);
    $("s-cost").textContent = fmtCost(cost);
    $("s-tps").textContent = turnMs > 0 ? Math.round((out / turnMs) * 1000) : 0;
    $("s-errors").textContent = errs;
    $("s-elapsed").textContent = first && last ? fmtDur(last - first) : "0s";

    // health chip: worst signal wins (red errors > amber stalls > ok)
    const health = $("s-health");
    if (health) {
        if (trouble) {
            health.textContent = "✗ " + trouble + " erroring";
            health.className = "err";
        } else if (stalled) {
            health.textContent = "⚠ " + stalled + " stalled";
            health.className = "warn";
        } else {
            health.textContent = "ok";
            health.className = "";
        }
    }
}

