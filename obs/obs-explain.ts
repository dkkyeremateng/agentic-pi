// Phase 3 (assistant) — the run-digest builder behind `obs-cli explain`.
//
// Distills one run's ObsEvent stream into a compact, LLM-ready digest: header
// facts (cost/tokens/wall/verdict), an agent timeline, a typed anomaly list
// (retries, truncations, tool/provider errors, slow tools/turns, cost
// outliers, compactions), per-agent and per-tool rollups, and the boot setup.
// The metrics skill feeds the formatted digest to pi so the model can answer
// "what happened / why was this run slow or expensive". Pure — no I/O.

import { type ObsEvent } from "./obs-events";

export interface AgentDigest {
    agent: string;
    instances: number;
    firstTs: number;
    lastTs: number;
    turns: number;
    costUsd: number;
    tokens: number;
    turnMs: number; // summed turn durations (excludes idle/dispatch gaps)
    toolCalls: number;
    toolErrors: number;
    errors: number;
    compactions: number;
    prefillAvgMs: number;
    maxContextPct: number | null;
    model?: string;
    boot?: { tools?: number; skills?: number; ctxFiles?: number; promptChars?: number };
}

export interface ToolDigest {
    tool: string;
    calls: number;
    totalMs: number;
    errors: number;
}

export interface Anomaly {
    kind:
        | "retry"
        | "dispatch-error"
        | "truncated"
        | "tool-error"
        | "provider-error"
        | "slow-tool"
        | "slow-turn"
        | "cost-outlier"
        | "compaction"
        | "context";
    agent?: string;
    detail: string;
}

export interface RunDigest {
    runId: string;
    name?: string;
    cwd?: string;
    startTs: number;
    endTs: number;
    wallMs: number;
    verdict?: { status: string; outcome?: string; note?: string; source?: string };
    // verdicts scoped to a single agent's run (keyed by agent name); separate
    // from the run-level `verdict` above.
    agentVerdicts?: Record<string, { status: string; outcome?: string; note?: string; source?: string }>;
    totals: {
        costUsd: number;
        tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
        turns: number;
        toolCalls: number;
        toolErrors: number;
        providerErrors: number;
        retries: number;
        compactions: number;
    };
    models: string[];
    agents: AgentDigest[];
    tools: ToolDigest[];
    anomalies: Anomaly[];
}

// Deterministic run-level verdict from the digest's own signals — used to
// auto-resolve runs that ended without a verdict (interactive sessions, or runs
// from before workflow auto-scoring). `null` = nothing to judge (an empty
// session that did no work). A run FAILS on a hard/infra failure (provider or
// dispatch error, a truncated turn); otherwise it ended cleanly → PASS. Routine
// tool errors do not fail a run on their own. A manual score always overrides.
export function runAutoVerdict(d: RunDigest): "pass" | "fail" | null {
    const worked = d.totals.turns > 0 || d.totals.toolCalls > 0;
    if (!worked) return null;
    const hardFail =
        d.totals.providerErrors > 0 ||
        d.anomalies.some(
            (a) =>
                a.kind === "provider-error" ||
                a.kind === "dispatch-error" ||
                a.kind === "truncated",
        );
    return hardFail ? "fail" : "pass";
}

const cap = (s: string, n: number): string =>
    s.length > n ? s.slice(0, n - 1) + "…" : s;

function median(sorted: number[]): number {
    if (!sorted.length) return 0;
    return sorted[Math.floor(sorted.length / 2)];
}

// Orchestration wrapper tools whose duration is an AGGREGATE of the child spans
// they block on (dispatch_agent → a whole sub-agent's lifetime; run_agent_workflow
// → the whole run). Flagging them as "slow tools" is tautological — that time is
// already represented by the children's own turns/tools and by the run wall-clock —
// so they're excluded from slow-tool detection. Agents that call them are tracked
// as orchestrators and excluded from slow-TURN detection too (their turns block on
// children rather than doing model work).
const ORCH_WRAPPER_TOOLS = new Set(["run_agent_workflow", "dispatch_agent", "dispatch_parallel"]);

// Slow-tool gating. A call is only flagged if it clears an absolute floor AND is a
// genuine outlier vs the SAME tool's median — so a tool that's routinely slow (a
// test/build that always takes ~30s) doesn't cry wolf, but the one call that runs
// 3× its peers does. When a tool has too few samples to establish a norm, the floor
// alone decides (a single long call still surfaces).
const SLOW_TOOL_FLOOR_MS = 30_000;
const SLOW_TOOL_REL = 3; // ≥3× the tool's own median
const SLOW_TOOL_MIN_SAMPLES = 3; // need this many calls before the relative gate applies

export function buildRunDigest(events: ObsEvent[]): RunDigest {
    const evs = [...events].sort((a, b) => a.ts - b.ts);
    const first = evs[0];

    const d: RunDigest = {
        runId: first?.runId ?? "",
        cwd: undefined,
        startTs: 0,
        endTs: 0,
        wallMs: 0,
        totals: {
            costUsd: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            turns: 0,
            toolCalls: 0,
            toolErrors: 0,
            providerErrors: 0,
            retries: 0,
            compactions: 0,
        },
        models: [],
        agents: [],
        tools: [],
        anomalies: [],
    };

    const agents = new Map<string, AgentDigest & { prefillSum: number; prefillN: number; sessions: Set<string> }>();
    const tools = new Map<string, ToolDigest>();
    const models = new Set<string>();
    const toolArgs = new Map<string, string>(); // toolCallId -> arg preview
    const turnRecs: { agent: string; idx: unknown; ms: number; cost: number }[] = [];
    const slowToolRecs: { agent: string; tool: string; ms: number; arg: string }[] = [];
    // All non-wrapper tool-call durations, grouped by tool name, so slow-tool can be
    // judged against each tool's OWN norm (a 40s test is normal if every test is 40s;
    // a 120s one among 5s peers is not) rather than a flat cutoff.
    const toolDur = new Map<string, number[]>();
    const anomalies: Anomaly[] = [];
    // Agents that invoked an orchestration wrapper tool (see ORCH_WRAPPER_TOOLS).
    // Their turn durations are dominated by BLOCKING on sub-agents, not by their own
    // model latency, so they're excluded from slow-turn detection (and from its
    // median) — otherwise every dispatch turn trips the flag and masks real leaf
    // outliers. Their per-turn COST is still their own work, so cost-outlier keeps them.
    const orchestratorAgents = new Set<string>();
    // Per-agent overflow-compaction detail (count + largest pre-compaction size),
    // used to enrich that agent's compaction anomaly below.
    const compactInfo = new Map<string, { overflow: number; tokensBefore: number }>();

    const agentOf = (ev: ObsEvent) => {
        let a = agents.get(ev.agent);
        if (!a) {
            a = {
                agent: ev.agent,
                instances: 0,
                firstTs: ev.ts,
                lastTs: ev.ts,
                turns: 0,
                costUsd: 0,
                tokens: 0,
                turnMs: 0,
                toolCalls: 0,
                toolErrors: 0,
                errors: 0,
                compactions: 0,
                prefillAvgMs: 0,
                maxContextPct: null,
                prefillSum: 0,
                prefillN: 0,
                sessions: new Set(),
            };
            agents.set(ev.agent, a);
        }
        a.sessions.add(ev.sessionId);
        if (ev.ts < a.firstTs) a.firstTs = ev.ts;
        if (ev.ts > a.lastTs) a.lastTs = ev.ts;
        return a;
    };

    for (const ev of evs) {
        const p = (ev.payload ?? {}) as any;
        // Run-level facts that don't belong to an agent.
        if (!d.cwd && ev.cwd) d.cwd = ev.cwd;
        if (ev.name) d.name = ev.name;
        if (ev.type === "verdict") {
            if (p.status) {
                const v = {
                    status: String(p.status),
                    outcome: p.outcome ? String(p.outcome) : undefined,
                    note: p.note ? String(p.note) : undefined,
                    source: p.source ? String(p.source) : undefined,
                };
                if (p.agent) {
                    // scoped to one agent's run — last verdict per agent wins
                    (d.agentVerdicts ??= {})[String(p.agent)] = v;
                } else {
                    d.verdict = v; // whole-run verdict
                }
            }
            continue; // never counts as agent activity / time bounds
        }
        if (!d.startTs || ev.ts < d.startTs) d.startTs = ev.ts;
        if (ev.ts > d.endTs) d.endTs = ev.ts;

        const a = agentOf(ev);
        switch (ev.type) {
            case "session_start":
                if (p.model) {
                    models.add(String(p.model));
                    a.model = String(p.model);
                }
                break;
            case "boot":
                a.boot = {
                    tools: Array.isArray(p.tools) ? p.tools.length : undefined,
                    skills: Array.isArray(p.skills) ? p.skills.length : undefined,
                    ctxFiles: Array.isArray(p.contextFiles)
                        ? p.contextFiles.length
                        : undefined,
                    promptChars:
                        typeof p.promptChars === "number" ? p.promptChars : undefined,
                };
                break;
            case "turn_end": {
                d.totals.turns++;
                a.turns++;
                const t = p.tokens;
                if (t) {
                    d.totals.tokens.input += t.input || 0;
                    d.totals.tokens.output += t.output || 0;
                    d.totals.tokens.cacheRead += t.cacheRead || 0;
                    d.totals.tokens.cacheWrite += t.cacheWrite || 0;
                    d.totals.tokens.total += t.total || 0;
                    a.tokens += t.total || 0;
                }
                d.totals.costUsd += p.costUsd || 0;
                a.costUsd += p.costUsd || 0;
                a.turnMs += p.durationMs || 0;
                if (p.prefillMs) {
                    a.prefillSum += p.prefillMs;
                    a.prefillN++;
                }
                if (p.context && p.context.percent != null)
                    a.maxContextPct = Math.max(
                        a.maxContextPct ?? 0,
                        Number(p.context.percent) || 0,
                    );
                if (p.model) {
                    models.add(String(p.model));
                    a.model = String(p.model);
                }
                turnRecs.push({
                    agent: ev.agent,
                    idx: p.turnIndex,
                    ms: p.durationMs || 0,
                    cost: p.costUsd || 0,
                });
                if (p.stopReason === "length" || p.stopReason === "max_tokens")
                    anomalies.push({
                        kind: "truncated",
                        agent: ev.agent,
                        detail: `${ev.agent} turn ${p.turnIndex ?? "?"} hit the output-token limit (stopReason ${p.stopReason})`,
                    });
                break;
            }
            case "tool_start":
                d.totals.toolCalls++;
                a.toolCalls++;
                if (p.toolCallId && p.arg)
                    toolArgs.set(String(p.toolCallId), String(p.arg));
                break;
            case "tool_end": {
                const name = String(p.toolName || "?");
                if (ORCH_WRAPPER_TOOLS.has(name)) orchestratorAgents.add(ev.agent);
                const t = tools.get(name) ?? { tool: name, calls: 0, totalMs: 0, errors: 0 };
                t.calls++;
                t.totalMs += p.durationMs || 0;
                if (p.isError) {
                    t.errors++;
                    d.totals.toolErrors++;
                    a.toolErrors++;
                    const arg = toolArgs.get(String(p.toolCallId)) || "";
                    anomalies.push({
                        kind: "tool-error",
                        agent: ev.agent,
                        detail:
                            `${name} failed in ${ev.agent}` +
                            (arg ? `: "${cap(arg, 80)}"` : "") +
                            (p.result ? ` → ${cap(String(p.result), 120)}` : ""),
                    });
                }
                tools.set(name, t);
                if (!ORCH_WRAPPER_TOOLS.has(name)) {
                    const durs = toolDur.get(name) ?? [];
                    durs.push(p.durationMs || 0);
                    toolDur.set(name, durs);
                    if ((p.durationMs || 0) >= SLOW_TOOL_FLOOR_MS)
                        slowToolRecs.push({
                            agent: ev.agent,
                            tool: name,
                            ms: p.durationMs,
                            arg: toolArgs.get(String(p.toolCallId)) || "",
                        });
                }
                break;
            }
            case "dispatch_retry":
                d.totals.retries++;
                anomalies.push({
                    kind: "retry",
                    agent: String(p.agent || ""),
                    detail: `${p.agent || "agent"} re-dispatched${p.reason ? ` (reason: ${p.reason})` : ""}`,
                });
                break;
            case "dispatch_end":
                if (p.status === "error" || p.reason === "truncated")
                    anomalies.push({
                        kind: "dispatch-error",
                        agent: String(p.agent || ""),
                        detail: `${p.agent || "agent"} dispatch ended ${p.status || ""}${p.reason ? ` (${p.reason})` : ""}${p.attempts > 1 ? ` after ${p.attempts} attempts` : ""}`,
                    });
                break;
            case "compaction":
                d.totals.compactions++;
                a.compactions++;
                // Track the overflow-recovery compactions (context overran and a
                // turn was retried) separately from routine threshold/manual ones,
                // so the per-agent compaction anomaly can call out the bad case.
                if (p.reason === "overflow" || p.willRetry) {
                    const ci = compactInfo.get(ev.agent) ?? {
                        overflow: 0,
                        tokensBefore: 0,
                    };
                    ci.overflow++;
                    if (typeof p.tokensBefore === "number")
                        ci.tokensBefore = Math.max(ci.tokensBefore, p.tokensBefore);
                    compactInfo.set(ev.agent, ci);
                }
                break;
            case "error":
                d.totals.providerErrors++;
                a.errors++;
                anomalies.push({
                    kind: "provider-error",
                    agent: ev.agent,
                    detail: `provider error in ${ev.agent}${p.status ? ` (status ${p.status})` : ""}`,
                });
                break;
            case "model_change":
                if (p.model) models.add(String(p.model));
                break;
        }
    }

    // Slow tools: of the calls over the floor, keep those that are also outliers
    // vs their own tool's median (sparse tools fall back to the floor). Worst 5.
    const slowTools = slowToolRecs.filter((r) => {
        const durs = toolDur.get(r.tool) ?? [];
        if (durs.length < SLOW_TOOL_MIN_SAMPLES) return true; // no norm yet → floor decides
        const med = median([...durs].sort((x, y) => x - y));
        return med <= 0 || r.ms >= SLOW_TOOL_REL * med;
    });
    slowTools.sort((x, y) => y.ms - x.ms);
    for (const r of slowTools.slice(0, 5))
        anomalies.push({
            kind: "slow-tool",
            agent: r.agent,
            detail:
                `${r.tool} took ${Math.round(r.ms / 1000)}s in ${r.agent}` +
                (r.arg ? `: "${cap(r.arg, 80)}"` : ""),
        });

    // Slow turns / cost outliers, judged against this run's own medians. Slow-turn
    // excludes orchestrator turns (they block on sub-agents, so their wall time is
    // not model latency) — both from the candidate set AND from the median, so a
    // blocking dispatch turn neither trips the flag nor inflates the baseline and
    // masks a real leaf outlier. Cost-outlier keeps every turn (cost is own work).
    const leafTurns = turnRecs.filter((t) => !orchestratorAgents.has(t.agent));
    const medMs = median(leafTurns.map((t) => t.ms).sort((x, y) => x - y));
    const medCost = median(turnRecs.map((t) => t.cost).sort((x, y) => x - y));
    for (const t of [...leafTurns].sort((x, y) => y.ms - x.ms).slice(0, 3))
        if (t.ms >= 60_000 && t.ms >= 2 * medMs)
            anomalies.push({
                kind: "slow-turn",
                agent: t.agent,
                detail: `${t.agent} turn ${t.idx ?? "?"} took ${Math.round(t.ms / 1000)}s (median turn ${Math.round(medMs / 1000)}s)`,
            });
    for (const t of [...turnRecs].sort((x, y) => y.cost - x.cost).slice(0, 3))
        if (t.cost >= 0.1 && t.cost >= 3 * medCost && medCost > 0)
            anomalies.push({
                kind: "cost-outlier",
                agent: t.agent,
                detail: `${t.agent} turn ${t.idx ?? "?"} cost $${t.cost.toFixed(2)} (median turn $${medCost.toFixed(2)})`,
            });

    for (const a of agents.values()) {
        if (a.compactions) {
            const ci = compactInfo.get(a.agent);
            anomalies.push({
                kind: "compaction",
                agent: a.agent,
                detail:
                    `${a.agent} compacted ${a.compactions}× (context pressure)` +
                    (ci?.overflow
                        ? ` — ${ci.overflow} from overflow, turn retried`
                        : "") +
                    (ci?.tokensBefore
                        ? ` (~${ci.tokensBefore.toLocaleString()} tokens before)`
                        : ""),
            });
        }
        if (a.maxContextPct != null && a.maxContextPct >= 70)
            anomalies.push({
                kind: "context",
                agent: a.agent,
                detail: `${a.agent} peaked at ${Math.round(a.maxContextPct)}% context`,
            });
    }

    d.wallMs = d.endTs - d.startTs;
    d.models = [...models];
    d.agents = [...agents.values()]
        .map((a) => ({
            agent: a.agent,
            instances: a.sessions.size,
            firstTs: a.firstTs,
            lastTs: a.lastTs,
            turns: a.turns,
            costUsd: a.costUsd,
            tokens: a.tokens,
            turnMs: a.turnMs,
            toolCalls: a.toolCalls,
            toolErrors: a.toolErrors,
            errors: a.errors,
            compactions: a.compactions,
            prefillAvgMs: a.prefillN ? Math.round(a.prefillSum / a.prefillN) : 0,
            maxContextPct: a.maxContextPct,
            model: a.model,
            boot: a.boot,
        }))
        .sort((x, y) => x.firstTs - y.firstTs);
    d.tools = [...tools.values()].sort((x, y) => y.totalMs - x.totalMs);
    d.anomalies = anomalies;
    return d;
}

// ── formatting ───────────────────────────────────────────────────────────────

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
function tok(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(Math.round(n));
}

export function formatRunDigest(d: RunDigest): string[] {
    const out: string[] = [];
    out.push(`# Run digest — ${d.runId}${d.name ? ` ("${d.name}")` : ""}`);
    const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);
    out.push(
        `${d.cwd ? `project ${d.cwd} · ` : ""}${when(d.startTs)} → ${when(d.endTs).slice(11)} · wall ${dur(d.wallMs)}`,
    );
    if (d.verdict)
        out.push(
            `verdict: ${d.verdict.status}` +
                (d.verdict.outcome ? ` (${d.verdict.outcome})` : "") +
                (d.verdict.source ? ` [${d.verdict.source}]` : "") +
                (d.verdict.note ? ` — ${d.verdict.note}` : ""),
        );
    const t = d.totals;
    out.push(
        `totals: ${usd(t.costUsd)} · ${tok(t.tokens.total)} tok ` +
            `(in ${tok(t.tokens.input)} / out ${tok(t.tokens.output)} / cache r ${tok(t.tokens.cacheRead)} w ${tok(t.tokens.cacheWrite)}) · ` +
            `${t.turns} turns · ${t.toolCalls} tools (${t.toolErrors} err) · ` +
            `${t.providerErrors} provider err · ${t.retries} retries · ${t.compactions} compactions`,
    );
    if (d.models.length) out.push(`models: ${d.models.join(", ")}`);

    out.push("", "## Timeline (agents by start)");
    for (const a of d.agents) {
        const off = a.firstTs - d.startTs;
        out.push(
            `${a.agent.padEnd(14)} +${dur(off).padStart(5)} → ${dur(a.lastTs - d.startTs).padStart(5)} ` +
                `(${dur(a.lastTs - a.firstTs)}) · ${a.turns} turns · ${usd(a.costUsd)}` +
                (a.instances > 1 ? ` · ${a.instances} instances` : ""),
        );
    }

    out.push("", "## Anomalies");
    if (!d.anomalies.length) out.push("(none detected)");
    for (const an of d.anomalies) out.push(`- [${an.kind}] ${an.detail}`);

    out.push("", "## Agents");
    for (const a of d.agents) {
        out.push(
            `${a.agent.padEnd(14)} ${dur(a.turnMs).padStart(6)} turn-time · ${usd(a.costUsd)} · ${tok(a.tokens)} tok · ` +
                `${a.toolCalls} tools (${a.toolErrors} err)` +
                (a.prefillAvgMs ? ` · prefill ~${a.prefillAvgMs}ms` : "") +
                (a.maxContextPct != null ? ` · ctx ≤${Math.round(a.maxContextPct)}%` : "") +
                (a.model ? ` · ${a.model}` : ""),
        );
    }

    if (d.tools.length) {
        out.push("", "## Tools (by total time)");
        for (const tl of d.tools.slice(0, 8)) {
            const avg = tl.calls ? Math.round(tl.totalMs / tl.calls) : 0;
            out.push(
                `${tl.tool.padEnd(14)} ${String(tl.calls).padStart(4)}× · total ${dur(tl.totalMs)} · avg ${avg < 1000 ? avg + "ms" : (avg / 1000).toFixed(1) + "s"}` +
                    (tl.errors ? ` · ${tl.errors} err` : ""),
            );
        }
    }

    const booted = d.agents.filter((a) => a.boot);
    if (booted.length) {
        out.push("", "## Setup (boot snapshots)");
        for (const a of booted) {
            const b = a.boot!;
            const parts: string[] = [];
            if (b.tools != null) parts.push(`${b.tools} tools`);
            if (b.skills != null) parts.push(`${b.skills} skills`);
            if (b.ctxFiles != null) parts.push(`${b.ctxFiles} ctx files`);
            if (b.promptChars != null) parts.push(`${tok(b.promptChars)}-char prompt`);
            out.push(`${a.agent.padEnd(14)} ${parts.join(" · ")}`);
        }
    }
    return out;
}
