// Phase 2 (live observability) — the canonical event model.
//
// Every pi process in a workflow (the orchestrator plus each spawned sub-agent)
// appends ObsEvent lines to a shared sink file; the obs-server tails that file
// and broadcasts to the dashboard over SSE. This module is the PURE core: the
// envelope, the per-session sequence factory, extractors that turn pi's native
// event payloads into ObsEvent payloads, and (de)serialization. No I/O — the
// collector extension (extensions/obs-live.ts) does the appending.

// Schema 2 adds runId/parent (trace linkage) and the dispatch_* lifecycle events.
// Older (v1) lines lack runId/parent and simply don't appear in the trace view.
export const OBS_SCHEMA = 2;

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
    // Orchestrator-side dispatch lifecycle (Tier 1 trace linkage). Emitted by the
    // ORCHESTRATOR process about a CHILD agent (payload.agent), so the dashboard can
    // show why a sub-agent re-ran (empty/truncated) without that intel being trapped
    // in the orchestrator.
    | "dispatch_start"
    | "dispatch_retry"
    | "dispatch_end"
    // Run-level outcome: { status: "pass"|"fail"|"open", outcome?, note?, source:
    // "workflow"|"cli", prUrl? }. Emitted by the orchestrator when a run reaches a
    // terminal state, or appended later by `obs-cli score` (manual scoring; the
    // last verdict for a run wins). Powers the dashboard's run-history view.
    | "verdict"
    | "custom";

export interface ObsEvent {
    v: number; // schema version
    seq: number; // per-session monotonic sequence
    ts: number; // epoch ms
    sessionId: string;
    agent: string; // "orchestrator", "scout", "implementer", ...
    cwd?: string;
    // Trace linkage (schema 2). runId groups every agent in one workflow invocation
    // into a single trace; parent is the agent name that dispatched this one (unset
    // on the root orchestrator). Both ride down through the spawn env (PI_OBS_RUN /
    // PI_OBS_PARENT) so each sub-agent process tags its own events.
    runId?: string;
    parent?: string;
    // The run's display name (the root orchestrator session's name, if it was
    // named via pi.setSessionName). Emitted by the root only, once it's set, so the
    // dashboard can label a run by name instead of its timestamp.
    name?: string;
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

// Flatten a tool result (string, text-block array, {text}, or arbitrary object)
// to its full text WITHOUT collapsing whitespace — for the expand-on-click view.
export function flattenText(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value))
        return value
            .map((b) =>
                typeof b === "string"
                    ? b
                    : b && typeof b === "object" && typeof (b as any).text === "string"
                      ? (b as any).text
                      : "",
            )
            .join("");
    if (typeof value === "object" && typeof (value as any).text === "string")
        return (value as any).text;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
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
// A non-finite or non-positive `max` means "no limit" (return the full string).
export function capText(s: string, max: number): string {
    if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
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
    runId?: string;
    parent?: string;
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
            if (opts.runId !== undefined) ev.runId = opts.runId;
            if (opts.parent !== undefined) ev.parent = opts.parent;
            return ev;
        },
    };
}

// ── cross-extension emit hook ────────────────────────────────────────────────
// The collector (obs-live.ts) owns the sink + factory; orchestrator-core.ts needs
// to emit dispatch_* events from the SAME orchestrator process without knowing any
// of that. The collector publishes its emit function here; orchestrator-core calls
// obsEmit(). Anchored on globalThis (not a module-level var) because pi loads each
// -e extension in its own module graph — a plain export would be a different copy
// in the collector vs. the importer. No-op when the collector isn't loaded
// (PI_OBS off), so callers never need to guard.

export type ObsEmit = (
    type: ObsEventType,
    payload?: Record<string, unknown>,
) => void;

const OBS_EMIT_KEY = Symbol.for("pi.obs.emit");

export function setObsEmit(fn: ObsEmit | undefined): void {
    (globalThis as any)[OBS_EMIT_KEY] = fn;
}

export function obsEmit(
    type: ObsEventType,
    payload?: Record<string, unknown>,
): void {
    const fn = (globalThis as any)[OBS_EMIT_KEY] as ObsEmit | undefined;
    if (!fn) return;
    try {
        fn(type, payload);
    } catch {
        /* never let observability disrupt the run */
    }
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
