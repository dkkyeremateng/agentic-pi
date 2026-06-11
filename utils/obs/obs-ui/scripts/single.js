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
    $("single-agent").textContent = a ? a.label : "—";
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

