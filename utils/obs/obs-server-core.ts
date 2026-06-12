// Phase 2 (live observability) — the PURE server core.
//
// The obs-server (utils/obs/obs-server.ts) tails the sink file and serves the
// dashboard; this module holds the parts worth testing in isolation: an event
// store with a bounded ring buffer + (sessionId,seq) dedupe, SSE frame
// formatting, and a live rollup the dashboard header uses. No I/O, no http.

import { type ObsEvent } from "./obs-events";

export interface AgentRollup {
    agent: string;
    events: number;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    errors: number; // provider/agent-level error events
    tokens: number;
    costUsd: number;
    lastType: string;
    lastTs: number;
    active: boolean; // started a turn/tool that hasn't ended, or session open
}

export interface LiveSummary {
    sessions: number;
    totalEvents: number;
    totalTokens: number;
    totalCostUsd: number;
    totalErrors: number;
    agents: AgentRollup[];
    firstTs?: number;
    lastTs?: number;
}

// Bounded in-memory store. Dedupes by `${sessionId}#${seq}` so a re-read of the
// tail (after truncation/rotation) never double-counts.
export class EventStore {
    private buf: ObsEvent[] = [];
    private seen = new Set<string>();
    constructor(private cap = 5000) {}

    private key(ev: ObsEvent): string {
        return `${ev.sessionId}#${ev.seq}`;
    }

    // Returns true if the event was new (and stored), false if a duplicate.
    add(ev: ObsEvent): boolean {
        const k = this.key(ev);
        if (this.seen.has(k)) return false;
        this.seen.add(k);
        this.buf.push(ev);
        if (this.buf.length > this.cap) {
            const dropped = this.buf.shift();
            if (dropped) this.seen.delete(this.key(dropped));
        }
        return true;
    }

    recent(limit?: number): ObsEvent[] {
        if (!limit || limit >= this.buf.length) return [...this.buf];
        return this.buf.slice(this.buf.length - limit);
    }

    size(): number {
        return this.buf.length;
    }

    summary(): LiveSummary {
        return summarize(this.buf);
    }
}

// Roll the event stream up into per-agent stats for the dashboard header.
export function summarize(events: ObsEvent[]): LiveSummary {
    const byAgent = new Map<string, AgentRollup>();
    const sessions = new Set<string>();
    let totalTokens = 0;
    let totalCost = 0;
    let totalErrors = 0;
    let firstTs: number | undefined;
    let lastTs: number | undefined;

    for (const ev of events) {
        sessions.add(ev.sessionId);
        if (firstTs === undefined || ev.ts < firstTs) firstTs = ev.ts;
        if (lastTs === undefined || ev.ts > lastTs) lastTs = ev.ts;

        const a =
            byAgent.get(ev.agent) ??
            ({
                agent: ev.agent,
                events: 0,
                turns: 0,
                toolCalls: 0,
                toolErrors: 0,
                errors: 0,
                tokens: 0,
                costUsd: 0,
                lastType: "",
                lastTs: 0,
                active: false,
            } satisfies AgentRollup);

        a.events++;
        a.lastType = ev.type;
        a.lastTs = ev.ts;

        switch (ev.type) {
            case "session_start":
                a.active = true;
                break;
            case "session_end":
                a.active = false;
                break;
            case "turn_end": {
                a.turns++;
                const tok = Number((ev.payload as any)?.tokens?.total ?? 0);
                const cost = Number((ev.payload as any)?.costUsd ?? 0);
                a.tokens += tok;
                a.costUsd += cost;
                totalTokens += tok;
                totalCost += cost;
                break;
            }
            case "tool_start":
                a.toolCalls++;
                a.active = true;
                break;
            case "tool_end":
                if ((ev.payload as any)?.isError) a.toolErrors++;
                break;
            case "error":
                a.errors++;
                totalErrors++;
                break;
        }
        byAgent.set(ev.agent, a);
    }

    return {
        sessions: sessions.size,
        totalEvents: events.length,
        totalTokens,
        totalCostUsd: totalCost,
        totalErrors,
        agents: [...byAgent.values()].sort((x, y) => x.lastTs - y.lastTs),
        firstTs,
        lastTs,
    };
}

// ── run-list filtering (the /api/runs query params) ──────────────────────────

export interface RunFilter {
    project?: string; // matches the basename of the run's cwd
    since?: number; // epoch ms — keep runs that STARTED at/after this
    limit?: number; // newest N (input is expected latest-first)
}

export function projectOf(cwd: string | undefined): string {
    if (!cwd) return "local";
    const parts = String(cwd).split("/").filter(Boolean);
    return parts[parts.length - 1] || "local";
}

export function filterRuns<T extends { cwd?: string; firstTs: number }>(
    runs: T[],
    f: RunFilter,
): T[] {
    let out = runs;
    if (f.project) out = out.filter((r) => projectOf(r.cwd) === f.project);
    if (f.since !== undefined && Number.isFinite(f.since))
        out = out.filter((r) => r.firstTs >= (f.since as number));
    if (f.limit && f.limit > 0) out = out.slice(0, f.limit);
    return out;
}

// ── SSE framing ──────────────────────────────────────────────────────────────

export function sseFrame(ev: ObsEvent): string {
    return `event: obs\ndata: ${JSON.stringify(ev)}\n\n`;
}

export function sseComment(text: string): string {
    return `: ${text}\n\n`;
}
