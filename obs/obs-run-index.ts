// Phase 2.5 (run history) — the sink-file run index.
//
// The shared sink grows without bound across runs, but the live server keeps
// only a bounded in-memory ring (and primes from the file's tail) — older runs
// silently vanish from the dashboard. This module turns the JSONL file itself
// into the archive: a byte-accurate line scanner plus a per-run index (time
// bounds, agents, cost, and the byte range covering the run's lines) so the
// server can list every run ever recorded (/runs) and seek straight to one
// run's slice of the file (/events?run=). Pure — no I/O; obs-server feeds it
// sequential buffers.

import { parseEventLine } from "./obs-events";

// Orchestration wrapper tools whose duration is an AGGREGATE of the child spans
// they block on (dispatch_agent → a whole sub-agent's lifetime; run_agent_workflow
// → the whole run). Excluded from active-time so a run's makespan reflects real
// leaf work rather than the blocking wrappers — which, if counted, would re-absorb
// exactly the idle/child time active-time exists to remove. Shared with the digest.
export const ORCH_WRAPPER_TOOLS = new Set(["run_agent_workflow", "dispatch_agent", "dispatch_parallel"]);

// Length of the union of a set of [start, end] intervals: concurrent work counted
// once, idle gaps between intervals excluded. The basis for a run's "active" time —
// the wall-clock actually spanned by work, as opposed to lastTs - firstTs, which
// also counts idle waits and an abandoned/lingering tail.
export function intervalUnionMs(spans: Array<[number, number]>): number {
    const sorted = spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    if (!sorted.length) return 0;
    let total = 0;
    let curS = sorted[0][0];
    let curE = sorted[0][1];
    for (let i = 1; i < sorted.length; i++) {
        const [s, e] = sorted[i];
        if (s > curE) {
            total += curE - curS;
            curS = s;
            curE = e;
        } else if (e > curE) {
            curE = e;
        }
    }
    return total + (curE - curS);
}

// Newline-delimited scanner over sequentially-fed Buffers. Reports each line
// with its absolute byte range [start, end) where `end` is just past the
// newline. Splitting happens on raw bytes (not decoded strings), so UTF-8
// sequences straddling a chunk boundary never mangle and offsets stay exact.
// A trailing partial line is held until its newline arrives.
export class LineScanner {
    private leftover: Buffer = Buffer.alloc(0);
    private base: number; // file offset of leftover[0]

    constructor(
        private onLine: (line: string, start: number, end: number) => void,
        base = 0,
    ) {
        this.base = base;
    }

    // Total bytes consumed so far — the next file offset to read from.
    get offset(): number {
        return this.base + this.leftover.length;
    }

    push(chunk: Buffer): void {
        const buf = this.leftover.length
            ? Buffer.concat([this.leftover, chunk])
            : chunk;
        let start = 0;
        for (;;) {
            const nl = buf.indexOf(0x0a, start);
            if (nl < 0) break;
            this.onLine(
                buf.toString("utf-8", start, nl),
                this.base + start,
                this.base + nl + 1,
            );
            start = nl + 1;
        }
        // Copy the tail — `chunk` is often a reused read buffer.
        this.leftover = Buffer.from(buf.subarray(start));
        this.base += start;
    }

    reset(base = 0): void {
        this.leftover = Buffer.alloc(0);
        this.base = base;
    }
}

export interface RunVerdict {
    status: string; // "pass" | "fail" | "open"
    outcome?: string; // the precise workflow status ("shipped", "error", …)
    note?: string;
    source?: string; // "workflow" | "cli"
    ts: number;
}

export interface RunSummary {
    runId: string;
    firstTs: number;
    lastTs: number;
    // Active makespan: union of leaf turn/tool span durations (idle gaps and the
    // abandoned tail removed, concurrent work counted once). The meaningful
    // "latency" of a run — lastTs - firstTs over-reports idle/lingering time.
    activeMs: number;
    events: number;
    agents: string[];
    cwd?: string; // first seen — runs are per-project in practice
    name?: string; // the run's display name (root session name), if it was named
    request?: string; // the root agent's first user prompt (short), for a title fallback
    costUsd: number;
    tokens: number; // total tokens across turns
    toolCalls: number; // tool invocations (tool_start count)
    models: string[]; // distinct models used in the run (sorted)
    modelCost: Record<string, number>; // turn cost attributed to each model
    errors: number; // error events + tool errors
    verdict?: RunVerdict; // last verdict wins (re-scoring overrides)
    // Byte range in the sink covering all of this run's lines. Runs interleave
    // in a shared sink, so the range may contain other runs' lines too — readers
    // filter by runId after seeking.
    startOffset: number;
    endOffset: number;
}

interface RunRec {
    runId: string;
    firstTs: number;
    lastTs: number;
    events: number;
    agents: Set<string>;
    cwd?: string;
    name?: string;
    request?: string;
    costUsd: number;
    tokens: number;
    toolCalls: number;
    models: Set<string>;
    sessionModel: Map<string, string>; // sessionId -> its session_start model
    modelCost: Map<string, number>;
    errors: number;
    verdict?: RunVerdict;
    // Leaf work intervals [start, end] for the active-makespan union: non-wrapper
    // tool spans plus turn spans from non-orchestrator agents (an orchestrator's
    // turns block on sub-agents, so their wall time isn't its own work). Both
    // reconstructed from *_end.durationMs, so no start/end pairing is needed.
    spans: Array<[number, number]>;
    orchestrators: Set<string>; // agents that issued a wrapper tool (turns excluded)
    startOffset: number;
    endOffset: number;
}

// Incremental per-run index over the sink. Feed it the file's bytes in order
// (full scan once, then just the tail deltas); `reset()` after truncation or
// rotation and re-feed from the top. Legacy v1 lines (no runId) are skipped —
// they carry no trace linkage to group by.
export class RunIndexer {
    private byRun = new Map<string, RunRec>();
    private scanner = new LineScanner((line, start, end) =>
        this.line(line, start, end),
    );

    // Next file offset to feed from (everything before it is indexed).
    get scannedTo(): number {
        return this.scanner.offset;
    }

    feed(chunk: Buffer): void {
        this.scanner.push(chunk);
    }

    reset(): void {
        this.byRun.clear();
        this.scanner.reset();
    }

    private line(line: string, start: number, end: number): void {
        const ev = parseEventLine(line);
        if (!ev || !ev.runId) return;
        let r = this.byRun.get(ev.runId);
        if (!r) {
            r = {
                runId: ev.runId,
                firstTs: ev.ts,
                lastTs: ev.ts,
                events: 0,
                agents: new Set(),
                costUsd: 0,
                tokens: 0,
                toolCalls: 0,
                models: new Set(),
                sessionModel: new Map(),
                modelCost: new Map(),
                errors: 0,
                spans: [],
                orchestrators: new Set(),
                startOffset: start,
                endOffset: end,
            };
            this.byRun.set(ev.runId, r);
        }
        r.events++;
        r.endOffset = end; // lines arrive in file order — the last one wins
        const p = ev.payload as any;
        // Verdicts are run-level annotations, possibly appended LONG after the
        // run (obs-cli score) by a synthetic "user" session — they must not join
        // the agents list or stretch the run's time bounds.
        if (ev.type === "verdict") {
            // agent-scoped verdicts annotate one agent's run, not the whole run —
            // they must not become the run-level verdict shown on run cards.
            if (p?.agent) return;
            if (p?.status)
                r.verdict = {
                    status: String(p.status),
                    outcome: p.outcome ? String(p.outcome) : undefined,
                    note: p.note ? String(p.note) : undefined,
                    source: p.source ? String(p.source) : undefined,
                    ts: ev.ts,
                };
            return;
        }
        if (ev.ts < r.firstTs) r.firstTs = ev.ts;
        if (ev.ts > r.lastTs) r.lastTs = ev.ts;
        r.agents.add(ev.agent);
        if (!r.cwd && ev.cwd) r.cwd = ev.cwd;
        if (ev.name) r.name = ev.name; // root-only; last named value wins
        // the root agent's first prompt → a title fallback for unnamed sessions
        if (ev.type === "boot" && !r.request && typeof p?.request === "string" && p.request) r.request = p.request;
        // Map each session to its model (from session_start) so turn cost can be
        // attributed to the right model even across sub-agents on different models.
        if (ev.type === "session_start" && typeof p?.model === "string") {
            r.models.add(p.model);
            r.sessionModel.set(ev.sessionId, p.model);
        }
        if (ev.type === "turn_end") {
            const cost = Number(p?.costUsd ?? 0);
            r.costUsd += cost;
            r.tokens += Number(p?.tokens?.total ?? 0);
            const m = r.sessionModel.get(ev.sessionId) ?? (typeof p?.model === "string" ? p.model : "");
            if (m) {
                r.models.add(m);
                r.modelCost.set(m, (r.modelCost.get(m) ?? 0) + cost);
            }
            // Leaf model-work span, unless this agent is an orchestrator whose turns
            // block on sub-agents. A dispatch turn's wrapper tool_end always precedes
            // its own turn_end (tools finish before the turn does), so the agent is
            // already flagged by the time its dispatch turns arrive — only genuine
            // pre-dispatch work turns are counted.
            const dur = Number(p?.durationMs ?? 0);
            if (dur > 0 && !r.orchestrators.has(ev.agent)) r.spans.push([ev.ts - dur, ev.ts]);
        }
        if (ev.type === "tool_start") r.toolCalls++;
        if (ev.type === "tool_end") {
            const name = String(p?.toolName ?? "");
            if (ORCH_WRAPPER_TOOLS.has(name)) {
                r.orchestrators.add(ev.agent);
            } else {
                const dur = Number(p?.durationMs ?? 0);
                if (dur > 0) r.spans.push([ev.ts - dur, ev.ts]);
            }
        }
        if (ev.type === "error" || (ev.type === "tool_end" && p?.isError))
            r.errors++;
    }

    get(runId: string): RunSummary | undefined {
        const r = this.byRun.get(runId);
        return r ? toSummary(r) : undefined;
    }

    // All known runs, latest-first.
    runs(): RunSummary[] {
        return [...this.byRun.values()]
            .map(toSummary)
            .sort((a, b) => b.firstTs - a.firstTs);
    }
}

function toSummary(r: RunRec): RunSummary {
    return {
        runId: r.runId,
        firstTs: r.firstTs,
        lastTs: r.lastTs,
        activeMs: intervalUnionMs(r.spans),
        events: r.events,
        agents: [...r.agents],
        cwd: r.cwd,
        name: r.name,
        request: r.request,
        costUsd: r.costUsd,
        tokens: r.tokens,
        toolCalls: r.toolCalls,
        models: [...r.models].sort(),
        modelCost: Object.fromEntries(r.modelCost),
        errors: r.errors,
        verdict: r.verdict,
        startOffset: r.startOffset,
        endOffset: r.endOffset,
    };
}
