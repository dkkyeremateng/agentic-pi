// Phase 3 (interop) — OpenTelemetry GenAI exporter.
//
// Pure transform from our ObsEvent stream to an OTLP/JSON trace payload that
// follows the OpenTelemetry GenAI semantic conventions, so the same sink can feed
// any OTel-aware backend (Datadog, Phoenix, Langfuse, Honeycomb, …). No I/O — the
// server endpoint and the obs-export CLI do the reading/writing.
//
// Span tree per run (shared runId): the orchestrator is an `invoke_agent` root;
// each dispatched agent is a child `invoke_agent` span linked via the event's
// `parent`; each turn is a `chat` span; each tool call is an `execute_tool` span.
// Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
//
// NOTE the GenAI semconv is still in Development status (1.40 as of 2026-04);
// cache-token usage has no standard attribute yet, so we use the Anthropic-style
// `gen_ai.usage.cache_{read,creation}_input_tokens`, and anything pi-specific
// (verdicts) is namespaced `pi.*`.
//
// We model 64-bit times as decimal STRINGS (BigInt) — OTLP/JSON requires fixed64
// fields (…UnixNano) to be strings, and ms·1e6 overflows Number.MAX_SAFE_INTEGER.

import { createHash } from "crypto";
import { type ObsEvent } from "./obs-events";

export interface OtlpExport {
    resourceSpans: any[];
}

// ── OTLP attribute helpers ───────────────────────────────────────────────────

function sAttr(key: string, value: string) {
    return { key, value: { stringValue: value } };
}
function iAttr(key: string, value: number) {
    // intValue is a 64-bit field → string form in OTLP/JSON.
    return { key, value: { intValue: String(Math.round(value)) } };
}
function dAttr(key: string, value: number) {
    return { key, value: { doubleValue: value } };
}
function arrAttr(key: string, values: string[]) {
    return {
        key,
        value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } },
    };
}

// ms (epoch) → nanoseconds as a decimal string, the OTLP fixed64 wire form.
// A non-finite ms (a sink line missing/with a bad `ts`) would make BigInt() throw
// a RangeError — and since this runs inside the server's route handlers, one such
// line would otherwise take the whole process down. Coerce to 0 instead.
function nanos(ms: number): string {
    return (BigInt(Number.isFinite(ms) ? Math.round(ms) : 0) * 1_000_000n).toString();
}

function capStr(s: string, max = 2000): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// OTLP span event ({ timeUnixNano, name, attributes }).
function spanEvent(ts: number, name: string, attrs: any[] = []) {
    return { timeUnixNano: nanos(ts), name, attributes: attrs };
}

// Deterministic, well-formed trace/span ids (hex of the right length) derived from
// stable keys so re-exporting the same events yields identical ids (idempotent).
function traceIdFor(key: string): string {
    return createHash("sha1").update("trace:" + key).digest("hex").slice(0, 32);
}
function spanIdFor(key: string): string {
    return createHash("sha1").update("span:" + key).digest("hex").slice(0, 16);
}

// pi model strings are "[provider/]id" (the first slash-segment is the provider,
// e.g. "anthropic" in "anthropic/claude-…", "gfr_prt" in "gfr_prt/anthropic/…").
function providerOf(model: string | undefined): string {
    if (!model) return "unknown";
    const i = model.indexOf("/");
    return i > 0 ? model.slice(0, i) : "unknown";
}

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_ERROR = 2;

interface PerSession {
    sessionId: string;
    agent: string;
    parentAgent?: string;
    model?: string;
    startTs: number;
    endTs: number;
    events: ObsEvent[];
}

// Group a single run's events into per-session buckets, tracking time bounds.
// Verdict events never set the bounds — a CLI score can arrive days later and
// must not stretch (or, for its synthetic session, define) a span.
function bucketSessions(events: ObsEvent[]): Map<string, PerSession> {
    const sessions = new Map<string, PerSession>();
    for (const ev of events) {
        const isVerdict = ev.type === "verdict";
        let s = sessions.get(ev.sessionId);
        if (!s) {
            s = {
                sessionId: ev.sessionId,
                agent: ev.agent,
                parentAgent: ev.parent,
                startTs: isVerdict ? Infinity : ev.ts,
                endTs: isVerdict ? -Infinity : ev.ts,
                events: [],
            };
            sessions.set(ev.sessionId, s);
        }
        if (!isVerdict) {
            if (ev.ts < s.startTs) s.startTs = ev.ts;
            if (ev.ts > s.endTs) s.endTs = ev.ts;
        }
        if (ev.parent && !s.parentAgent) s.parentAgent = ev.parent;
        const model = (ev.payload as any)?.model;
        if (typeof model === "string" && model && !s.model) s.model = model;
        s.events.push(ev);
    }
    return sessions;
}

// Pair start/end events by a key into {start?, end?} rows in first-seen order.
function pairBy(
    events: ObsEvent[],
    startType: string,
    endType: string,
    keyOf: (e: ObsEvent) => string,
): { key: string; start?: ObsEvent; end?: ObsEvent }[] {
    const order: string[] = [];
    const byKey = new Map<string, { key: string; start?: ObsEvent; end?: ObsEvent }>();
    const get = (k: string) => {
        let r = byKey.get(k);
        if (!r) {
            r = { key: k };
            byKey.set(k, r);
            order.push(k);
        }
        return r;
    };
    for (const ev of events) {
        if (ev.type === startType) get(keyOf(ev)).start = ev;
        else if (ev.type === endType) get(keyOf(ev)).end = ev;
    }
    return order.map((k) => byKey.get(k)!);
}

// Build the spans for one run (all events share the same trace).
function spansForRun(traceKey: string, events: ObsEvent[]): any[] {
    const traceId = traceIdFor(traceKey);
    const sessions = bucketSessions(events);

    // Sessions that carry only verdicts (the CLI's synthetic "score-*" session)
    // are annotations, not agents — they must not become invoke_agent spans.
    const real = (s: PerSession) => Number.isFinite(s.startTs);

    // agent NAME → its invoke_agent span id, so a child can find its parent. When a
    // name has several sessions (parallel same-name agents) the first wins.
    const agentSpanByName = new Map<string, string>();
    for (const s of sessions.values()) {
        if (!real(s)) continue;
        const id = spanIdFor(traceKey + "/agent:" + s.sessionId);
        if (!agentSpanByName.has(s.agent)) agentSpanByName.set(s.agent, id);
    }

    const spans: any[] = [];
    const agentSpanObjByName = new Map<string, any>(); // for second-pass annotations
    for (const s of sessions.values()) {
        if (!real(s)) continue;
        const agentSpanId = spanIdFor(traceKey + "/agent:" + s.sessionId);
        const parentSpanId =
            s.parentAgent && agentSpanByName.has(s.parentAgent)
                ? agentSpanByName.get(s.parentAgent)
                : undefined;

        // invoke_agent (root for the orchestrator, child for dispatched agents)
        const agentSpan: any = {
            traceId,
            spanId: agentSpanId,
            name: "invoke_agent " + s.agent,
            kind: SPAN_KIND_INTERNAL,
            startTimeUnixNano: nanos(s.startTs),
            endTimeUnixNano: nanos(s.endTs),
            attributes: [
                sAttr("gen_ai.operation.name", "invoke_agent"),
                sAttr("gen_ai.agent.name", s.agent),
            ],
        };
        if (parentSpanId) agentSpan.parentSpanId = parentSpanId;
        if (s.model) {
            agentSpan.attributes.push(sAttr("gen_ai.provider.name", providerOf(s.model)));
            agentSpan.attributes.push(sAttr("gen_ai.request.model", s.model));
        }
        // Compactions mark context pressure — surfaced as span events.
        for (const ev of s.events)
            if (ev.type === "compaction") {
                if (!agentSpan.events) agentSpan.events = [];
                agentSpan.events.push(spanEvent(ev.ts, "compaction"));
            }
        spans.push(agentSpan);
        if (!agentSpanObjByName.has(s.agent))
            agentSpanObjByName.set(s.agent, agentSpan);

        // Provider-error timestamps mark the chat span they fall inside.
        const errorTs = s.events
            .filter((e) => e.type === "error")
            .map((e) => e.ts);

        // chat spans — one per turn (turn_start..turn_end paired by turnIndex).
        const turns = pairBy(
            s.events,
            "turn_start",
            "turn_end",
            (e) => String((e.payload as any)?.turnIndex ?? ""),
        );
        for (const t of turns) {
            const ref = t.end ?? t.start;
            if (!ref) continue;
            const p = (t.end?.payload ?? {}) as any;
            const start = t.start?.ts ?? ref.ts;
            const end = t.end?.ts ?? ref.ts;
            const model = p.model || s.model;
            const chat: any = {
                traceId,
                spanId: spanIdFor(traceKey + "/chat:" + s.sessionId + ":" + t.key),
                parentSpanId: agentSpanId,
                name: "chat " + (model || s.agent),
                kind: SPAN_KIND_CLIENT,
                startTimeUnixNano: nanos(start),
                endTimeUnixNano: nanos(end),
                attributes: [sAttr("gen_ai.operation.name", "chat")],
            };
            if (model) {
                chat.attributes.push(sAttr("gen_ai.provider.name", providerOf(model)));
                chat.attributes.push(sAttr("gen_ai.request.model", model));
            }
            const tok = p.tokens;
            if (tok) {
                if (tok.input != null)
                    chat.attributes.push(iAttr("gen_ai.usage.input_tokens", tok.input));
                if (tok.output != null)
                    chat.attributes.push(iAttr("gen_ai.usage.output_tokens", tok.output));
                // No standard cache attrs yet (semconv in Development) —
                // Anthropic-style names, which several backends already read.
                if (tok.cacheRead)
                    chat.attributes.push(
                        iAttr("gen_ai.usage.cache_read_input_tokens", tok.cacheRead),
                    );
                if (tok.cacheWrite)
                    chat.attributes.push(
                        iAttr(
                            "gen_ai.usage.cache_creation_input_tokens",
                            tok.cacheWrite,
                        ),
                    );
            }
            if (p.stopReason)
                chat.attributes.push(
                    arrAttr("gen_ai.response.finish_reasons", [String(p.stopReason)]),
                );
            if (p.costUsd != null) chat.attributes.push(dAttr("gen_ai.usage.cost_usd", p.costUsd));
            // A provider error inside this turn's window fails the chat span.
            if (errorTs.some((ts) => ts >= start && ts <= end))
                chat.status = { code: STATUS_ERROR, message: "provider error" };
            spans.push(chat);
        }

        // execute_tool spans — one per tool call (paired by toolCallId).
        const tools = pairBy(
            s.events,
            "tool_start",
            "tool_end",
            (e) => String((e.payload as any)?.toolCallId ?? ""),
        );
        for (const t of tools) {
            const ref = t.start ?? t.end;
            if (!ref) continue;
            const sp = (t.start?.payload ?? {}) as any;
            const ep = (t.end?.payload ?? {}) as any;
            const name = sp.toolName || ep.toolName || "tool";
            const start = t.start?.ts ?? ref.ts;
            const end = t.end?.ts ?? ref.ts;
            const tool: any = {
                traceId,
                spanId: spanIdFor(
                    traceKey + "/tool:" + s.sessionId + ":" + (t.key || name + ":" + start),
                ),
                parentSpanId: agentSpanId,
                name: "execute_tool " + name,
                kind: SPAN_KIND_INTERNAL,
                startTimeUnixNano: nanos(start),
                endTimeUnixNano: nanos(end),
                attributes: [
                    sAttr("gen_ai.operation.name", "execute_tool"),
                    sAttr("gen_ai.tool.name", name),
                ],
            };
            if (t.key) tool.attributes.push(sAttr("gen_ai.tool.call.id", t.key));
            // Arguments when the collector captured them (argsText is the full
            // pretty JSON; arg is the one-line preview) — capped for sanity.
            const args = sp.argsText || sp.arg;
            if (args)
                tool.attributes.push(
                    sAttr("gen_ai.tool.call.arguments", capStr(String(args))),
                );
            if (ep.isError)
                tool.status = {
                    code: STATUS_ERROR,
                    message: capStr(
                        String(ep.result || ep.resultText || "tool error"),
                        300,
                    ),
                };
            spans.push(tool);
        }
    }

    // Second pass — annotations that live in one session but describe another:
    // dispatch_retry/dispatch_end (orchestrator about a child) and the run
    // verdict (often a synthetic CLI session) land on the right spans.
    let rootSpan: any;
    for (const sp of agentSpanObjByName.values())
        if (!sp.parentSpanId) {
            rootSpan = sp;
            break;
        }
    let verdictTs = -Infinity; // the LAST verdict (by ts) wins
    for (const s of sessions.values()) {
        for (const ev of s.events) {
            const p = (ev.payload ?? {}) as any;
            if (ev.type === "dispatch_retry") {
                const target =
                    agentSpanObjByName.get(String(p.agent)) ||
                    agentSpanObjByName.get(ev.agent);
                if (target) {
                    if (!target.events) target.events = [];
                    target.events.push(
                        spanEvent(
                            ev.ts,
                            "dispatch_retry",
                            p.reason ? [sAttr("reason", String(p.reason))] : [],
                        ),
                    );
                }
            } else if (ev.type === "dispatch_end" && p.status === "error") {
                const target = agentSpanObjByName.get(String(p.agent));
                if (target)
                    target.status = {
                        code: STATUS_ERROR,
                        message: capStr(String(p.reason || "dispatch error"), 300),
                    };
            } else if (
                ev.type === "verdict" &&
                p.status &&
                rootSpan &&
                ev.ts >= verdictTs
            ) {
                verdictTs = ev.ts;
                rootSpan.attributes = rootSpan.attributes.filter(
                    (a: any) => !a.key.startsWith("pi.run.verdict"),
                );
                rootSpan.attributes.push(sAttr("pi.run.verdict", String(p.status)));
                if (p.source)
                    rootSpan.attributes.push(
                        sAttr("pi.run.verdict.source", String(p.source)),
                    );
                if (p.note)
                    rootSpan.attributes.push(
                        sAttr("pi.run.verdict.note", capStr(String(p.note), 300)),
                    );
            }
        }
    }
    return spans;
}

// Convert ObsEvents to an OTLP/JSON trace export. Events are grouped into traces
// by runId (falling back to sessionId for legacy v1 lines without one). `runId`
// scopes the export to a single run; `serviceName` sets resource service.name.
export function eventsToOtlp(
    events: ObsEvent[],
    opts: { runId?: string; serviceName?: string } = {},
): OtlpExport {
    const serviceName = opts.serviceName || "pi-agent-workflow";
    const byTrace = new Map<string, ObsEvent[]>();
    for (const ev of events) {
        const key = ev.runId || ev.sessionId;
        if (opts.runId && ev.runId !== opts.runId) continue;
        if (!byTrace.has(key)) byTrace.set(key, []);
        byTrace.get(key)!.push(ev);
    }

    const spans: any[] = [];
    for (const [key, evs] of byTrace) spans.push(...spansForRun(key, evs));

    return {
        resourceSpans: [
            {
                resource: {
                    attributes: [sAttr("service.name", serviceName)],
                },
                scopeSpans: [
                    {
                        scope: { name: "pi.agent.obs", version: "1" },
                        spans,
                    },
                ],
            },
        ],
    };
}

export function toOtlpString(events: ObsEvent[], opts?: { runId?: string; serviceName?: string }): string {
    return JSON.stringify(eventsToOtlp(events, opts), null, 2);
}
