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

