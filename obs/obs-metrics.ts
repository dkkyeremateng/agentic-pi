// Phase 1 of agent observability: a pure, offline analyzer over pi session logs.
//
// Every agent (orchestrator AND each spawned sub-agent) writes a JSONL session
// file. This module turns those logs into the metrics we care about: the
// "trifecta" (cost / speed / tokens) plus pipeline-specific facts (phases,
// ship outcome, context-prune savings). It does NO filesystem or network I/O —
// callers pass in the raw JSONL lines and the `.agent/` facts; that keeps it
// unit-testable and decoupled from where the logs live. See obs-cli.ts for the
// I/O layer that locates the files and renders these reports.
//
// Wire shape we read (pi session v3 JSONL), one JSON object per line:
//   { type:"session", id, cwd, timestamp }
//   { type:"message", timestamp, message:{ role, content, usage?, model?,
//        responseModel?, stopReason?, toolCallId?, toolName?, isError? } }
//      role "assistant": content[] may hold { type:"toolCall", id, name, arguments }
//      role "toolResult": top-level toolCallId/toolName/isError, content[] is text
//   { type:"model_change", modelId, provider, timestamp }
//   { type:"branch_summary", timestamp, summary }  (compaction)
//   { type:"custom_message", customType, details, timestamp }
//      customType "context-prune-summary": details.toolCallRefs[].toolCallId

export interface CostBreakdown {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

export interface SessionMetrics {
    agent: string;
    sessionId?: string;
    cwd?: string;
    startedAt?: string; // ISO of first in-window entry
    endedAt?: string; // ISO of last in-window entry
    durationMs: number;
    // Trifecta — cost (USD) and tokens
    cost: CostBreakdown;
    tokens: CostBreakdown;
    // Trifecta — speed
    turns: number; // assistant messages (model turns)
    toolCalls: number;
    toolErrors: number;
    tps: number; // output tokens per second over the session span (0 if unknown)
    // Detail
    toolBreakdown: Record<string, number>;
    models: string[];
    modelChanges: number;
    stopReasons: Record<string, number>;
    // Context management
    pruneEvents: number;
    prunedOutputs: number; // tool outputs compacted by pi-context-prune
    estPruneTokensReclaimed: number; // ~chars/4 of the pruned originals
    compactions: number; // pi built-in branch_summary entries
}

export interface PipelineFacts {
    team?: string;
    request?: string;
    phasesTotal?: number;
    phasesDone?: number;
    phaseLabels?: { label: string; done: boolean }[];
    shipOutcome?: ShipOutcome;
}

export type ShipOutcome = "shipped" | "paused" | "failed" | "unknown";

export interface RunReport {
    cwd?: string;
    team?: string;
    request?: string;
    agents: SessionMetrics[];
    totals: {
        costTotal: number;
        tokensTotal: number;
        wallclockMs: number; // earliest start → latest end across agents
        activeMs: number; // sum of per-agent spans (overlaps double-counted)
        turns: number;
        toolCalls: number;
        toolErrors: number;
        pruneEvents: number;
        estPruneTokensReclaimed: number;
    };
    costliestAgent?: { agent: string; cost: number };
    slowestAgent?: { agent: string; durationMs: number };
    pipeline: {
        phasesDone?: number;
        phasesTotal?: number;
        shipOutcome: ShipOutcome;
        phaseLabels?: { label: string; done: boolean }[];
    };
}

// ── helpers ──────────────────────────────────────────────────────────────

// Rough token estimate from raw text (pi/Anthropic average ~4 chars/token).
// Used only where the log records no token count (prune originals).
export function estTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function emptyCost(): CostBreakdown {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function tsMs(v: unknown): number | undefined {
    if (typeof v !== "string") return undefined;
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
}

function blockText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let out = "";
    for (const b of content) {
        if (b && typeof b === "object" && typeof (b as any).text === "string") {
            out += (b as any).text;
        }
    }
    return out;
}

export interface ParseOptions {
    agent?: string;
    // Inclusive window (ISO strings or epoch ms). Entries outside are ignored —
    // lets a reused/continued session file be sliced to a single run.
    window?: { start?: string | number; end?: string | number };
}

function inWindow(ms: number | undefined, win?: ParseOptions["window"]): boolean {
    if (!win || ms === undefined) return true;
    const lo = typeof win.start === "string" ? Date.parse(win.start) : win.start;
    const hi = typeof win.end === "string" ? Date.parse(win.end) : win.end;
    if (lo !== undefined && !Number.isNaN(lo) && ms < lo) return false;
    if (hi !== undefined && !Number.isNaN(hi) && ms > hi) return false;
    return true;
}

// ── core parse ───────────────────────────────────────────────────────────

// Parse one session's JSONL lines into metrics. `lines` is the file split on
// "\n" (blank/invalid lines are skipped). Pass `opts.window` to scope a
// continued session file to a single run.
export function parseSession(
    lines: string[],
    opts: ParseOptions = {},
): SessionMetrics {
    const m: SessionMetrics = {
        agent: opts.agent ?? "unknown",
        durationMs: 0,
        cost: emptyCost(),
        tokens: emptyCost(),
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        tps: 0,
        toolBreakdown: {},
        models: [],
        modelChanges: 0,
        stopReasons: {},
        pruneEvents: 0,
        prunedOutputs: 0,
        estPruneTokensReclaimed: 0,
        compactions: 0,
    };

    const modelSet = new Set<string>();
    // toolCallId -> estimated tokens of its result, to value prune savings.
    const resultTokens = new Map<string, number>();
    const prunedIds = new Set<string>();
    let minTs: number | undefined;
    let maxTs: number | undefined;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let o: any;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = tsMs(o.timestamp);
        if (!inWindow(ts, opts.window)) continue;
        if (ts !== undefined) {
            if (minTs === undefined || ts < minTs) minTs = ts;
            if (maxTs === undefined || ts > maxTs) maxTs = ts;
        }

        switch (o.type) {
            case "session":
                m.sessionId = o.id ?? m.sessionId;
                m.cwd = o.cwd ?? m.cwd;
                break;
            case "model_change":
                m.modelChanges++;
                if (o.modelId) modelSet.add(o.modelId);
                break;
            case "branch_summary":
                m.compactions++;
                break;
            case "custom_message":
                if (o.customType === "context-prune-summary") {
                    m.pruneEvents++;
                    const refs = o.details?.toolCallRefs;
                    if (Array.isArray(refs)) {
                        m.prunedOutputs += refs.length;
                        for (const r of refs) {
                            if (r?.toolCallId) prunedIds.add(r.toolCallId);
                        }
                    }
                }
                break;
            case "message": {
                const msg = o.message;
                if (!msg || typeof msg !== "object") break;
                if (msg.model) modelSet.add(msg.model);
                if (msg.responseModel) modelSet.add(msg.responseModel);
                if (msg.role === "assistant") {
                    m.turns++;
                    if (msg.stopReason) {
                        m.stopReasons[msg.stopReason] =
                            (m.stopReasons[msg.stopReason] ?? 0) + 1;
                    }
                    const u = msg.usage;
                    if (u && typeof u === "object") {
                        const inTok = u.input ?? 0;
                        const outTok = u.output ?? 0;
                        const cacheR = u.cacheRead ?? 0;
                        const cacheW = u.cacheWrite ?? 0;
                        m.tokens.input += inTok;
                        m.tokens.output += outTok;
                        m.tokens.cacheRead += cacheR;
                        m.tokens.cacheWrite += cacheW;
                        // Fall back to the component sum when totalTokens is absent —
                        // otherwise the total silently undercounts (stays 0) for
                        // payloads that carry only the split fields.
                        m.tokens.total += u.totalTokens ?? inTok + outTok + cacheR + cacheW;
                        const c = u.cost;
                        if (c && typeof c === "object") {
                            m.cost.input += c.input ?? 0;
                            m.cost.output += c.output ?? 0;
                            m.cost.cacheRead += c.cacheRead ?? 0;
                            m.cost.cacheWrite += c.cacheWrite ?? 0;
                            m.cost.total += c.total ?? 0;
                        }
                    }
                    if (Array.isArray(msg.content)) {
                        for (const b of msg.content) {
                            if (b?.type === "toolCall") {
                                m.toolCalls++;
                                const name = b.name ?? "unknown";
                                m.toolBreakdown[name] =
                                    (m.toolBreakdown[name] ?? 0) + 1;
                            }
                        }
                    }
                } else if (msg.role === "toolResult") {
                    if (msg.isError) m.toolErrors++;
                    if (msg.toolCallId) {
                        resultTokens.set(
                            msg.toolCallId,
                            estTokens(blockText(msg.content)),
                        );
                    }
                }
                break;
            }
        }
    }

    for (const id of prunedIds) {
        m.estPruneTokensReclaimed += resultTokens.get(id) ?? 0;
    }

    m.models = [...modelSet];
    if (minTs !== undefined && maxTs !== undefined) {
        m.startedAt = new Date(minTs).toISOString();
        m.endedAt = new Date(maxTs).toISOString();
        m.durationMs = maxTs - minTs;
    }
    const secs = m.durationMs / 1000;
    m.tps = secs > 0 ? m.tokens.output / secs : 0;
    return m;
}

// ── aggregate a run across its agents ──────────────────────────────────────

export function aggregateRun(
    sessions: SessionMetrics[],
    facts: PipelineFacts = {},
): RunReport {
    const totals = {
        costTotal: 0,
        tokensTotal: 0,
        wallclockMs: 0,
        activeMs: 0,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        pruneEvents: 0,
        estPruneTokensReclaimed: 0,
    };
    let minStart: number | undefined;
    let maxEnd: number | undefined;
    let costliest: { agent: string; cost: number } | undefined;
    let slowest: { agent: string; durationMs: number } | undefined;

    for (const s of sessions) {
        totals.costTotal += s.cost.total;
        totals.tokensTotal += s.tokens.total;
        totals.activeMs += s.durationMs;
        totals.turns += s.turns;
        totals.toolCalls += s.toolCalls;
        totals.toolErrors += s.toolErrors;
        totals.pruneEvents += s.pruneEvents;
        totals.estPruneTokensReclaimed += s.estPruneTokensReclaimed;
        const st = tsMs(s.startedAt);
        const en = tsMs(s.endedAt);
        if (st !== undefined && (minStart === undefined || st < minStart))
            minStart = st;
        if (en !== undefined && (maxEnd === undefined || en > maxEnd))
            maxEnd = en;
        if (!costliest || s.cost.total > costliest.cost)
            costliest = { agent: s.agent, cost: s.cost.total };
        if (!slowest || s.durationMs > slowest.durationMs)
            slowest = { agent: s.agent, durationMs: s.durationMs };
    }
    if (minStart !== undefined && maxEnd !== undefined)
        totals.wallclockMs = maxEnd - minStart;

    return {
        cwd: sessions.find((s) => s.cwd)?.cwd,
        team: facts.team,
        request: facts.request,
        agents: [...sessions].sort(
            (a, b) => (tsMs(a.startedAt) ?? 0) - (tsMs(b.startedAt) ?? 0),
        ),
        totals,
        costliestAgent: costliest,
        slowestAgent: slowest,
        pipeline: {
            phasesDone: facts.phasesDone,
            phasesTotal: facts.phasesTotal,
            shipOutcome: facts.shipOutcome ?? "unknown",
            phaseLabels: facts.phaseLabels,
        },
    };
}

// ── workflow-report.md (authoritative per-run record) ──────────────────────
//
// The workflow writes a report per run with a header it computed in-process:
// authoritative single-run totals (no cross-run accumulation), a per-phase
// breakdown, the attempt count (retries), and the outcome. We parse that header
// as the source of truth and use the session logs only to enrich it with detail
// the report summarizes away (per-tool counts, prune savings, errors).

export interface ReportPhase {
    name: string;
    durationMs: number;
    tokens: number;
    costUsd: number;
}

export interface WorkflowReportSummary {
    request?: string;
    outcome?: string; // free-text Outcome: line
    result?: string; // machine-ish Result: code (e.g. "paused-no-remote")
    shipOutcome: ShipOutcome;
    verdict?: string;
    attempts?: number;
    attemptsMax?: number;
    wallclockMs?: number;
    toolCalls?: number;
    tokens?: { input: number; output: number; cache: number; total: number };
    costUsd?: number;
    phases: ReportPhase[];
}

// "10m 38s" / "6m18s" / "51s" / "1m" / "500ms" -> ms
export function parseDuration(s: string): number {
    let ms = 0;
    // Match a bare "ms" first, and require the minute "m" NOT be the "m" in "ms"
    // (else "500ms" was read as 500 MINUTES). Seconds "s" must follow a digit.
    const milli = s.match(/(\d+)\s*ms\b/);
    const m = s.match(/(\d+)\s*m(?!s)/);
    const sec = s.match(/(\d+)\s*s\b/);
    if (milli) ms += parseInt(milli[1], 10);
    if (m) ms += parseInt(m[1], 10) * 60_000;
    if (sec) ms += parseInt(sec[1], 10) * 1000;
    return ms;
}

// "472.7k" / "11.0k" / "590,978" / "1.5m" -> number
export function parseTokenCount(s: string): number {
    const m = s.trim().match(/([\d.,]+)\s*([km])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1].replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k") return Math.round(n * 1_000);
    if (unit === "m") return Math.round(n * 1_000_000);
    return Math.round(n);
}

function reportShipOutcome(s: WorkflowReportSummary): ShipOutcome {
    const hay = `${s.result ?? ""} ${s.outcome ?? ""}`.toLowerCase();
    if (/paused/.test(hay)) return "paused";
    if (/shipped/.test(hay)) return "shipped";
    if (/fail|blocked|abort/.test(hay)) return "failed";
    return "unknown";
}

export function parseWorkflowReport(text: string): WorkflowReportSummary {
    const out: WorkflowReportSummary = { shipOutcome: "unknown", phases: [] };
    const line = (label: string) =>
        text.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, "m"))?.[1].trim();

    out.request = line("Request");
    out.outcome = line("Outcome");
    const result = line("Result");
    if (result) {
        out.result = result.split("·")[0].trim();
        out.verdict = result.match(/verdict\s+(\w+)/i)?.[1];
        const att = result.match(/(\d+)\s+attempt\(s\)\s+of\s+(\d+)/i);
        if (att) {
            out.attempts = parseInt(att[1], 10);
            out.attemptsMax = parseInt(att[2], 10);
        }
    }
    const totals = line("Totals");
    if (totals) {
        const wc = totals.match(/([\dms\s]+?)\s*wall-clock/);
        if (wc) out.wallclockMs = parseDuration(wc[1]);
        const tc = totals.match(/([\d,]+)\s+tool call/);
        if (tc) out.toolCalls = parseInt(tc[1].replace(/,/g, ""), 10);
        const tok = totals.match(
            /([\d,]+)\s+tokens\s*\(([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out\s*\/\s*([\d,]+)\s*cache\)/,
        );
        if (tok) {
            const n = (x: string) => parseInt(x.replace(/,/g, ""), 10);
            out.tokens = {
                total: n(tok[1]),
                input: n(tok[2]),
                output: n(tok[3]),
                cache: n(tok[4]),
            };
        }
        const cost = totals.match(/\$([\d.]+)/);
        if (cost) out.costUsd = parseFloat(cost[1]);
    }

    // Per-phase summary lines: "- **Scout** (19s, 11.0k tokens, $0.022) — ..."
    const phaseRe = /^-\s*\*\*([^*]+)\*\*\s*\(([^)]*)\)/gm;
    let pm: RegExpExecArray | null;
    while ((pm = phaseRe.exec(text))) {
        const name = pm[1].trim();
        const inner = pm[2];
        const dur = inner.match(/^[^,]+/)?.[0] ?? "";
        const tok = inner.match(/([\d.,]+\s*[km]?)\s*tokens/i)?.[1] ?? "0";
        const cost = inner.match(/\$([\d.]+)/)?.[1] ?? "0";
        out.phases.push({
            name,
            durationMs: parseDuration(dur),
            tokens: parseTokenCount(tok),
            costUsd: parseFloat(cost),
        });
    }

    out.shipOutcome = reportShipOutcome(out);
    return out;
}

export function formatReportSummary(s: WorkflowReportSummary): string[] {
    const out: string[] = [];
    out.push("Agent Workflow — Run Metrics");
    out.push("============================");
    if (s.request) out.push(`request   ${s.request}`);
    if (s.outcome) out.push(`outcome   ${s.outcome}`);
    out.push("");
    out.push("Trifecta (authoritative — single run)");
    if (s.costUsd !== undefined) out.push(`  cost      ${usd(s.costUsd)}`);
    if (s.tokens)
        out.push(
            `  tokens    ${num(s.tokens.total)}  (${num(s.tokens.input)} in / ${num(
                s.tokens.output,
            )} out / ${num(s.tokens.cache)} cache)`,
        );
    if (s.wallclockMs !== undefined || s.toolCalls !== undefined)
        out.push(
            `  speed     ${dur(s.wallclockMs ?? 0)} wall-clock` +
                (s.toolCalls !== undefined ? `, ${s.toolCalls} tool calls` : ""),
        );
    out.push(
        `  ship      ${s.shipOutcome}` +
            (s.verdict ? ` (verdict ${s.verdict})` : "") +
            (s.attempts !== undefined
                ? `, ${s.attempts}/${s.attemptsMax ?? "?"} attempt(s)`
                : ""),
    );
    out.push("");
    if (s.phases.length) {
        out.push("Per phase (from report)");
        for (const p of s.phases) {
            out.push(
                `  ${p.name.padEnd(14)} ${dur(p.durationMs).padStart(6)}  ${usd(
                    p.costUsd,
                ).padStart(8)}  ${num(p.tokens).padStart(9)} tok`,
            );
        }
        out.push("");
    }
    return out;
}

// ── formatting ─────────────────────────────────────────────────────────────

function usd(n: number): string {
    return "$" + n.toFixed(n < 1 ? 4 : 2);
}

function dur(ms: number): string {
    if (ms <= 0) return "0s";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m${r}s` : `${m}m`;
}

function num(n: number): string {
    return n.toLocaleString("en-US");
}

function topTools(b: Record<string, number>, n = 4): string {
    const e = Object.entries(b).sort((a, c) => c[1] - a[1]);
    if (!e.length) return "-";
    return e
        .slice(0, n)
        .map(([k, v]) => `${k}×${v}`)
        .join(" ");
}

export function formatSessionLine(s: SessionMetrics): string[] {
    const head = `  ${s.agent.padEnd(14)} ${dur(s.durationMs).padStart(6)}  ${usd(
        s.cost.total,
    ).padStart(8)}  ${num(s.tokens.total).padStart(9)} tok  ${String(
        s.turns,
    ).padStart(3)} turns  ${String(s.toolCalls).padStart(3)} tools`;
    const detail = `      tools: ${topTools(s.toolBreakdown)}${
        s.toolErrors ? `  | errors: ${s.toolErrors}` : ""
    }${s.pruneEvents ? `  | pruned ${s.prunedOutputs} (~${num(s.estPruneTokensReclaimed)} tok)` : ""}${
        s.compactions ? `  | compactions: ${s.compactions}` : ""
    }`;
    return [head, detail];
}

// ── cross-run trends (--all) ───────────────────────────────────────────────
//
// Normalized per-run input for trend aggregation. WorkflowMetrics (from a
// .agent/metrics.jsonl line) satisfies this structurally once the caller tags it
// with its project; keeping a local shape avoids coupling this module to the
// workflow producer.

export interface TrendPhase {
    label: string;
    elapsedMs: number;
    costUsd: number;
    attempt: number;
}

export interface TrendRun {
    project: string;
    startedAt?: string;
    shipOutcome: ShipOutcome;
    passed: boolean;
    passes: number;
    maxLoops: number;
    costUsd: number;
    tokensTotal: number;
    wallclockMs: number;
    phases: TrendPhase[];
}

export interface TrendReport {
    runs: number;
    firstRun?: string;
    lastRun?: string;
    cost: { total: number; mean: number };
    tokens: { total: number; mean: number };
    wallclock: { totalMs: number; meanMs: number };
    ship: Record<ShipOutcome, number>;
    validatorPassRate: number; // passed / runs
    meanAttempts: number;
    retryRate: number; // runs that looped (passes>1 or a phase re-ran) / runs
    byPhase: {
        label: string;
        runs: number;
        meanMs: number;
        meanCost: number;
        meanAttempt: number;
    }[];
    byProject: {
        project: string;
        runs: number;
        totalCost: number;
        meanWallclockMs: number;
        shipped: number;
    }[];
    slowestPhase?: { label: string; meanMs: number };
    costliestPhase?: { label: string; meanCost: number };
}

export function aggregateTrends(runs: TrendRun[]): TrendReport {
    const ship: Record<ShipOutcome, number> = {
        shipped: 0,
        paused: 0,
        failed: 0,
        unknown: 0,
    };
    let costTotal = 0;
    let tokensTotal = 0;
    let wallTotal = 0;
    let passedCount = 0;
    let attemptsSum = 0;
    let retried = 0;
    let firstRun: string | undefined;
    let lastRun: string | undefined;

    const phaseAcc = new Map<
        string,
        { runs: number; ms: number; cost: number; attempt: number }
    >();
    const projAcc = new Map<
        string,
        { runs: number; cost: number; wall: number; shipped: number }
    >();

    for (const r of runs) {
        ship[r.shipOutcome]++;
        costTotal += r.costUsd;
        tokensTotal += r.tokensTotal;
        wallTotal += r.wallclockMs;
        if (r.passed) passedCount++;
        attemptsSum += r.passes;
        const maxPhaseAttempt = r.phases.reduce(
            (m, p) => Math.max(m, p.attempt),
            0,
        );
        if (r.passes > 1 || maxPhaseAttempt > 1) retried++;
        if (r.startedAt) {
            if (!firstRun || r.startedAt < firstRun) firstRun = r.startedAt;
            if (!lastRun || r.startedAt > lastRun) lastRun = r.startedAt;
        }
        for (const p of r.phases) {
            const a = phaseAcc.get(p.label) ?? {
                runs: 0,
                ms: 0,
                cost: 0,
                attempt: 0,
            };
            a.runs++;
            a.ms += p.elapsedMs;
            a.cost += p.costUsd;
            a.attempt += p.attempt;
            phaseAcc.set(p.label, a);
        }
        const pr = projAcc.get(r.project) ?? {
            runs: 0,
            cost: 0,
            wall: 0,
            shipped: 0,
        };
        pr.runs++;
        pr.cost += r.costUsd;
        pr.wall += r.wallclockMs;
        if (r.shipOutcome === "shipped") pr.shipped++;
        projAcc.set(r.project, pr);
    }

    const n = runs.length || 1;
    const byPhase = [...phaseAcc.entries()]
        .map(([label, a]) => ({
            label,
            runs: a.runs,
            meanMs: a.ms / a.runs,
            meanCost: a.cost / a.runs,
            meanAttempt: a.attempt / a.runs,
        }))
        .sort((x, y) => y.meanMs - x.meanMs);
    const byProject = [...projAcc.entries()]
        .map(([project, a]) => ({
            project,
            runs: a.runs,
            totalCost: a.cost,
            meanWallclockMs: a.wall / a.runs,
            shipped: a.shipped,
        }))
        .sort((x, y) => y.totalCost - x.totalCost);

    return {
        runs: runs.length,
        firstRun,
        lastRun,
        cost: { total: costTotal, mean: costTotal / n },
        tokens: { total: tokensTotal, mean: tokensTotal / n },
        wallclock: { totalMs: wallTotal, meanMs: wallTotal / n },
        ship,
        validatorPassRate: passedCount / n,
        meanAttempts: attemptsSum / n,
        retryRate: retried / n,
        byPhase,
        byProject,
        slowestPhase: byPhase[0]
            ? { label: byPhase[0].label, meanMs: byPhase[0].meanMs }
            : undefined,
        costliestPhase: [...byPhase].sort((a, b) => b.meanCost - a.meanCost)[0]
            ? (() => {
                  const c = [...byPhase].sort(
                      (a, b) => b.meanCost - a.meanCost,
                  )[0];
                  return { label: c.label, meanCost: c.meanCost };
              })()
            : undefined,
    };
}

function pct(x: number): string {
    return `${(x * 100).toFixed(0)}%`;
}

export function formatTrendReport(t: TrendReport): string[] {
    const out: string[] = [];
    out.push("");
    out.push("Agent Workflow — Cross-Run Trends");
    out.push("=================================");
    out.push(
        `runs      ${t.runs}` +
            (t.firstRun && t.lastRun
                ? `   (${t.firstRun.slice(0, 10)} → ${t.lastRun.slice(0, 10)})`
                : ""),
    );
    out.push("");
    out.push("Aggregate");
    out.push(
        `  cost      ${usd(t.cost.total)} total · ${usd(t.cost.mean)}/run`,
    );
    out.push(
        `  tokens    ${num(Math.round(t.tokens.total))} total · ${num(
            Math.round(t.tokens.mean),
        )}/run`,
    );
    out.push(
        `  speed     ${dur(t.wallclock.totalMs)} total · ${dur(
            t.wallclock.meanMs,
        )}/run`,
    );
    out.push("");
    out.push("Outcomes");
    out.push(
        `  ship      ${t.ship.shipped} shipped · ${t.ship.paused} paused · ${t.ship.failed} failed · ${t.ship.unknown} unknown`,
    );
    out.push(`  pass rate ${pct(t.validatorPassRate)} (validator passed)`);
    out.push(
        `  retries   ${pct(t.retryRate)} of runs looped · ${t.meanAttempts.toFixed(
            1,
        )} attempt(s)/run avg`,
    );
    if (t.slowestPhase)
        out.push(
            `  slowest   ${t.slowestPhase.label} (${dur(t.slowestPhase.meanMs)}/run avg)`,
        );
    if (t.costliestPhase)
        out.push(
            `  costliest ${t.costliestPhase.label} (${usd(t.costliestPhase.meanCost)}/run avg)`,
        );
    out.push("");
    out.push("By phase (avg/run)");
    for (const p of t.byPhase) {
        out.push(
            `  ${p.label.padEnd(14)} ${dur(p.meanMs).padStart(6)}  ${usd(
                p.meanCost,
            ).padStart(8)}  ${p.runs} run(s)${
                p.meanAttempt > 1.05 ? `  (${p.meanAttempt.toFixed(1)} attempts)` : ""
            }`,
        );
    }
    out.push("");
    out.push("By project");
    for (const p of t.byProject) {
        out.push(
            `  ${p.project.padEnd(28)} ${String(p.runs).padStart(3)} run(s)  ${usd(
                p.totalCost,
            ).padStart(8)}  ${dur(p.meanWallclockMs).padStart(6)}/run  ${p.shipped} shipped`,
        );
    }
    out.push("");
    return out;
}

export function formatRunReport(r: RunReport): string[] {
    const out: string[] = [];
    out.push("");
    out.push("Agent Workflow — Run Metrics");
    out.push("============================");
    if (r.cwd) out.push(`project   ${r.cwd}`);
    if (r.team) out.push(`team      ${r.team}`);
    if (r.request) out.push(`request   ${r.request}`);
    out.push("");

    // Pipeline facts
    const p = r.pipeline;
    if (p.phasesTotal !== undefined || p.phasesDone !== undefined) {
        out.push(
            `phases    ${p.phasesDone ?? "?"}/${p.phasesTotal ?? "?"} done   ship: ${p.shipOutcome}`,
        );
    } else {
        out.push(`ship      ${p.shipOutcome}`);
    }
    if (p.phaseLabels?.length) {
        for (const ph of p.phaseLabels) {
            out.push(`   [${ph.done ? "x" : " "}] ${ph.label}`);
        }
    }
    out.push("");

    // Trifecta rollup
    const t = r.totals;
    out.push("Trifecta");
    out.push(`  cost      ${usd(t.costTotal)}`);
    out.push(
        `  tokens    ${num(t.tokensTotal)}  (in/out across all agents)`,
    );
    out.push(
        `  speed     ${dur(t.wallclockMs)} wall  /  ${dur(t.activeMs)} active  ` +
            `(${t.turns} turns, ${t.toolCalls} tool calls${t.toolErrors ? `, ${t.toolErrors} errors` : ""})`,
    );
    if (t.pruneEvents) {
        out.push(
            `  pruning   ${t.pruneEvents} events, ~${num(t.estPruneTokensReclaimed)} tokens reclaimed`,
        );
    }
    if (r.costliestAgent)
        out.push(
            `  costliest ${r.costliestAgent.agent} (${usd(r.costliestAgent.cost)})`,
        );
    if (r.slowestAgent)
        out.push(
            `  slowest   ${r.slowestAgent.agent} (${dur(r.slowestAgent.durationMs)})`,
        );
    out.push("");

    // Per-agent breakdown
    out.push("Per agent");
    for (const s of r.agents) {
        out.push(...formatSessionLine(s));
    }
    out.push("");
    return out;
}
