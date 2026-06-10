// Phase 2 (live observability) — the canonical event model.
//
// Every pi process in a workflow (the orchestrator plus each spawned sub-agent)
// appends ObsEvent lines to a shared sink file; the obs-server tails that file
// and broadcasts to the dashboard over SSE. This module is the PURE core: the
// envelope, the per-session sequence factory, extractors that turn pi's native
// event payloads into ObsEvent payloads, and (de)serialization. No I/O — the
// collector extension (extensions/obs-live.ts) does the appending.

export const OBS_SCHEMA = 1;

export type ObsEventType =
    | "session_start"
    | "boot" // one-time snapshot: tools, skills, context files, system prompt
    | "session_end"
    | "turn_start"
    | "turn_end"
    | "message"
    | "tool_start"
    | "tool_end"
    | "model_change"
    | "compaction"
    | "error"
    | "custom";

export interface ObsEvent {
    v: number; // schema version
    seq: number; // per-session monotonic sequence
    ts: number; // epoch ms
    sessionId: string;
    agent: string; // "orchestrator", "scout", "implementer", ...
    cwd?: string;
    type: ObsEventType;
    payload: Record<string, unknown>;
}

export interface TokenUsageLite {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    costUsd: number;
}

// ── extractors (pure) ───────────────────────────────────────────────────────

// Normalize an AgentMessage's usage block (shape matches pi session JSONL:
// { input, output, cacheRead, cacheWrite, totalTokens, cost:{...,total} }).
export function usageFrom(message: any): TokenUsageLite | undefined {
    const u = message?.usage;
    if (!u || typeof u !== "object") return undefined;
    const cost = u.cost && typeof u.cost === "object" ? u.cost : {};
    return {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        total:
            u.totalTokens ??
            (u.input ?? 0) +
                (u.output ?? 0) +
                (u.cacheRead ?? 0) +
                (u.cacheWrite ?? 0),
        costUsd: cost.total ?? 0,
    };
}

// A short, safe one-line preview of tool arguments for the timeline.
export function argPreview(args: unknown, max = 120): string {
    if (args == null) return "";
    let s: string;
    if (typeof args === "string") s = args;
    else {
        const a = args as Record<string, unknown>;
        // Prefer the most informative single field when present.
        const pick =
            a.command ?? a.path ?? a.pattern ?? a.query ?? a.file ?? undefined;
        s = pick !== undefined ? String(pick) : JSON.stringify(args);
    }
    s = s.replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Short preview of a tool result for the timeline.
export function resultPreview(result: unknown, max = 160): string {
    let s: string;
    if (result == null) s = "";
    else if (typeof result === "string") s = result;
    else if (Array.isArray(result)) {
        s = result
            .map((b) =>
                b && typeof b === "object" && typeof (b as any).text === "string"
                    ? (b as any).text
                    : "",
            )
            .join("");
    } else if (typeof result === "object" && typeof (result as any).text === "string")
        s = (result as any).text;
    else s = JSON.stringify(result);
    s = s.replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Truncate preserving newlines (unlike argPreview, which collapses whitespace).
export function capText(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
}

// Extract the assistant's text and thinking from a message's content blocks
// (text: {type:"text",text}, thinking: {type:"thinking",thinking}). Each is
// length-capped. Returns empty strings when absent.
export function messageContent(
    message: any,
    max = 2000,
): { text: string; thinking: string } {
    const c = message?.content;
    let text = "";
    let thinking = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
        for (const b of c) {
            if (!b || typeof b !== "object") continue;
            if (b.type === "text" && typeof b.text === "string") text += b.text;
            else if (b.type === "thinking" && typeof b.thinking === "string")
                thinking += b.thinking;
        }
    }
    return { text: capText(text.trim(), max), thinking: capText(thinking.trim(), max) };
}

// ── per-session event factory (pure-ish: only Date.now for default ts) ───────

export interface EventFactory {
    next(
        type: ObsEventType,
        payload?: Record<string, unknown>,
        ts?: number,
    ): ObsEvent;
    readonly sessionId: string;
    readonly agent: string;
}

export function makeFactory(opts: {
    sessionId: string;
    agent: string;
    cwd?: string;
    startSeq?: number;
}): EventFactory {
    let seq = opts.startSeq ?? 0;
    return {
        sessionId: opts.sessionId,
        agent: opts.agent,
        next(type, payload = {}, ts = Date.now()): ObsEvent {
            const ev: ObsEvent = {
                v: OBS_SCHEMA,
                seq: seq++,
                ts,
                sessionId: opts.sessionId,
                agent: opts.agent,
                type,
                payload,
            };
            if (opts.cwd !== undefined) ev.cwd = opts.cwd;
            return ev;
        },
    };
}

// ── (de)serialization ────────────────────────────────────────────────────────

export function serializeEvent(ev: ObsEvent): string {
    return JSON.stringify(ev);
}

export function parseEventLine(line: string): ObsEvent | null {
    const s = line.trim();
    if (!s) return null;
    try {
        const o = JSON.parse(s);
        if (
            o &&
            typeof o === "object" &&
            typeof o.seq === "number" &&
            typeof o.sessionId === "string" &&
            typeof o.type === "string"
        ) {
            return o as ObsEvent;
        }
    } catch {
        /* ignore malformed lines */
    }
    return null;
}
