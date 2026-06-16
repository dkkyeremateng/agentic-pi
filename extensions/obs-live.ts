// Phase 2 (live observability) — the collector extension.
//
// Subscribes to pi lifecycle events and appends canonical ObsEvent lines to a
// per-project sink file (<cwd>/.agent/obs/events.jsonl). The obs-server tails
// that file and streams it to the dashboard. Every pi process in a workflow —
// the orchestrator and each spawned sub-agent — loads this and appends, so the
// whole pipeline shows up live.
//
// Inert unless PI_OBS=1. Load via -e; sub-agents get it injected by
// subagentExtArgs (workflow-core.ts) when PI_OBS=1.

import { appendFileSync, mkdirSync } from "fs";
import { join, dirname, resolve as resolvePath } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import {
    makeFactory,
    serializeEvent,
    setObsEmit,
    usageFrom,
    argPreview,
    resultPreview,
    flattenText,
    messageContent,
    capText,
    type EventFactory,
} from "../obs/obs-events";

// Cap (chars) for the full args/result captured for the expand-on-click view.
// Default is unlimited — tool args/results are the agent's working I/O and we
// want them whole. Set PI_OBS_TOOL_MAX=<n> to cap (e.g. to bound the sink size).
function toolMax(): number {
    const v = process.env.PI_OBS_TOOL_MAX;
    if (!v || v === "0" || v.toLowerCase() === "full") return Infinity;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? Infinity : Math.max(0, n);
}
function isTruncated(len: number, cap: number): boolean {
    return Number.isFinite(cap) && cap > 0 && len > cap;
}

function enabled(): boolean {
    return process.env.PI_OBS === "1" || process.env.PI_OBS === "true";
}

// (b) Message/thinking CONTENT is opt-in separately from structural events,
// because it can be large and may echo file contents or secrets. Off unless
// PI_OBS_CONTENT=1; each block capped to PI_OBS_CONTENT_MAX chars (default 2000).
function contentEnabled(): boolean {
    return (
        process.env.PI_OBS_CONTENT === "1" ||
        process.env.PI_OBS_CONTENT === "true"
    );
}
function contentMax(): number {
    const n = parseInt(process.env.PI_OBS_CONTENT_MAX ?? "2000", 10);
    return Number.isNaN(n) ? 2000 : Math.max(0, n);
}

function sinkPath(_cwd: string): string {
    if (process.env.PI_OBS_SINK)
        return resolvePath(
            process.env.PI_OBS_SINK.replace(/^~(?=$|\/)/, homedir()),
        );
    // Default to a SHARED global sink so every pi instance (across projects)
    // streams into one dashboard. Events carry cwd, so the UI separates them by
    // project. Set PI_OBS_SINK=$PWD/.agent/obs/events.jsonl for a per-project sink.
    return join(homedir(), ".pi", "agent", "obs", "events.jsonl");
}

// Guard against double-registration if this extension is loaded twice in one
// process (e.g. both auto-discovered and passed via -e) — that would duplicate
// every event. The flag lives on the module instance (shared across calls).
let registered = false;

export default function obsLive(pi: any): void {
    if (!enabled() || registered) return;
    registered = true;

    let factory: EventFactory | undefined;
    let sink = "";
    let dead = false;
    let isRoot = false; // the root orchestrator (no PI_OBS_PARENT) — owns the run name
    let lastName = ""; // last emitted session name, to emit only on change
    let bootEmitted = false;
    let turnStartTs = 0;
    const toolStartTs = new Map<string, number>();
    // Per-turn timing for prefill (request→response) and generation throughput.
    let reqSentTs = 0; // before_provider_request
    let respStartTs = 0; // after_provider_response (≈ first byte / headers)
    let prefillMs = 0; // respStart − reqSent
    let genTps = 0; // output tokens / (messageEnd − respStart)

    const shortHash = (s: string): string =>
        createHash("sha1").update(s).digest("hex").slice(0, 8);

    const append = (line: string): void => {
        if (dead) return;
        try {
            appendFileSync(sink, line + "\n", "utf-8");
        } catch {
            // If the sink can't be written, stop trying — never disrupt the run.
            dead = true;
        }
    };

    const emit = (type: any, payload: Record<string, unknown> = {}): void => {
        if (!factory) return;
        const ev = factory.next(type, payload);
        // Tag the run's name (root only) once it's set/changes. The workflow names
        // its session via pi.setSessionName AFTER session_start, so the name first
        // appears on a later event — emitted here on change, never per event.
        if (isRoot) {
            let nm = "";
            try {
                nm =
                    (typeof pi.getSessionName === "function" &&
                        pi.getSessionName()) ||
                    "";
            } catch {}
            if (nm && nm !== lastName) {
                ev.name = nm;
                lastName = nm;
            }
        }
        append(serializeEvent(ev));
    };

    pi.on("session_start", async (_e: any, ctx: any) => {
        const cwd: string = ctx?.cwd ?? process.cwd();
        sink = sinkPath(cwd);
        try {
            mkdirSync(dirname(sink), { recursive: true });
        } catch {
            dead = true;
        }
        // Sub-agents are labelled by PI_OBS_AGENT; the root is always
        // "orchestrator". We deliberately do NOT fall back to the session name —
        // that would put a named session's name on the agent lane. The session name
        // is surfaced separately as the run name (see `name` below).
        const agent = process.env.PI_OBS_AGENT || "orchestrator";
        // Unique per process so multiple agents never collide on (sessionId,seq).
        const sessionId = `${agent}-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 7)}`;
        // Trace linkage. A sub-agent inherits PI_OBS_RUN/PI_OBS_PARENT from its
        // spawn env (set by dispatchEnv). The ROOT orchestrator has neither, so it
        // mints a runId and writes it back to process.env so every agent it later
        // dispatches inherits the same trace id.
        let runId = process.env.PI_OBS_RUN;
        if (!runId) {
            runId = `run-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 7)}`;
            process.env.PI_OBS_RUN = runId;
        }
        const parent = process.env.PI_OBS_PARENT || undefined;
        isRoot = !parent; // only the root carries the run's display name
        factory = makeFactory({ sessionId, agent, cwd, runId, parent });
        // Publish the emit hook so orchestrator-core can append dispatch_* events
        // through this same factory/sink (no-op in processes without the collector).
        setObsEmit((type, payload) => emit(type, payload ?? {}));
        emit("session_start", {
            model: ctx?.model?.id,
            pid: process.pid,
            // The dispatch this process was spawned for — lets the dashboard bind
            // the orchestrator's dispatch_* annotations to THIS exact instance
            // (so parallel runs of the same agent stay distinct).
            dispatchId: process.env.PI_OBS_DISPATCH_ID || undefined,
        });
    });

    // (a) Boot snapshot — once per session, on the first user prompt. Captures
    // what this agent was configured with: tools, skills, context files (+hashes),
    // and the system prompt size/hash. The richest "what is this agent" signal.
    pi.on("before_agent_start", async (e: any) => {
        if (bootEmitted) return;
        bootEmitted = true;
        const o = e?.systemPromptOptions ?? {};
        const sys: string = e?.systemPrompt ?? "";
        const ctxFiles = Array.isArray(o.contextFiles) ? o.contextFiles : [];
        emit("boot", {
            tools: Array.isArray(o.selectedTools) ? o.selectedTools : undefined,
            skills: Array.isArray(o.skills)
                ? o.skills.map((s: any) => s?.name ?? s?.id ?? String(s))
                : undefined,
            contextFiles: ctxFiles.map((f: any) => ({
                path: f?.path,
                bytes: typeof f?.content === "string" ? f.content.length : 0,
                hash:
                    typeof f?.content === "string"
                        ? shortHash(f.content)
                        : undefined,
            })),
            promptChars: sys.length,
            promptHash: sys ? shortHash(sys) : undefined,
        });
        // (b) the user's prompt, when content capture is on.
        if (contentEnabled() && typeof e?.prompt === "string" && e.prompt.trim())
            emit("message", {
                role: "user",
                kind: "user",
                text: capText(e.prompt.trim(), contentMax()),
            });
    });

    pi.on("turn_start", async (e: any) => {
        turnStartTs = Date.now();
        emit("turn_start", { turnIndex: e?.turnIndex });
    });

    // (d) prefill = request→response latency. before/after_provider_request fire
    // in all modes (they wrap the HTTP call), so this works for headless
    // sub-agents too — unlike token-streaming events.
    pi.on("before_provider_request", async () => {
        reqSentTs = Date.now();
    });

    pi.on("turn_end", async (e: any, ctx: any) => {
        const usage = usageFrom(e?.message);
        // (d) latency + throughput for this turn.
        const durationMs = turnStartTs ? Date.now() - turnStartTs : 0;
        const out = usage?.output ?? 0;
        // Prefer true generation throughput (set on message_end); fall back to
        // turn-duration throughput when the streaming window wasn't observed.
        const tps =
            genTps ||
            (durationMs > 0 && out > 0
                ? Math.round((out / durationMs) * 1000)
                : 0);
        let context: Record<string, unknown> | undefined;
        try {
            const cu = ctx?.getContextUsage?.();
            if (cu)
                context = {
                    tokens: cu.tokens,
                    window: cu.contextWindow,
                    percent: cu.percent,
                };
        } catch {
            /* ignore */
        }
        emit("turn_end", {
            turnIndex: e?.turnIndex,
            tokens: usage,
            costUsd: usage?.costUsd ?? 0,
            durationMs,
            tps,
            prefillMs: prefillMs || undefined,
            context,
            model: e?.message?.model ?? e?.message?.responseModel,
            stopReason: e?.message?.stopReason,
            toolResults: Array.isArray(e?.toolResults)
                ? e.toolResults.length
                : 0,
        });
        // reset per-turn timing so a turn without a provider call doesn't reuse
        // the previous turn's numbers
        reqSentTs = respStartTs = prefillMs = genTps = 0;
    });

    pi.on("message_end", async (e: any) => {
        const msg = e?.message;
        if (!msg || msg.role !== "assistant") return;
        // (d) generation throughput: output tokens over the response→done window
        // (excludes prefill and tool time). Always computed, even without content.
        if (respStartTs) {
            const genMs = Date.now() - respStartTs;
            const out = usageFrom(msg)?.output ?? 0;
            genTps = genMs > 0 && out > 0 ? Math.round((out / genMs) * 1000) : 0;
        }
        // (b) assistant text + thinking content (opt-in via PI_OBS_CONTENT).
        if (!contentEnabled()) return;
        const { text, thinking } = messageContent(msg, contentMax());
        if (thinking)
            emit("message", { role: "assistant", kind: "thinking", text: thinking });
        if (text) emit("message", { role: "assistant", kind: "assistant", text });
    });

    pi.on("tool_execution_start", async (e: any) => {
        if (e?.toolCallId) toolStartTs.set(e.toolCallId, Date.now());
        // Full args (pretty JSON, capped) power the expand-on-click view.
        let argsRaw = "";
        try {
            argsRaw = JSON.stringify(e?.args ?? {}, null, 2);
        } catch {
            argsRaw = String(e?.args ?? "");
        }
        const cap = toolMax();
        emit("tool_start", {
            toolCallId: e?.toolCallId,
            toolName: e?.toolName,
            arg: argPreview(e?.args),
            argsText: capText(argsRaw, cap),
            argsTruncated: isTruncated(argsRaw.length, cap),
        });
    });

    pi.on("tool_execution_end", async (e: any) => {
        // (d) tool execution latency.
        const started = e?.toolCallId ? toolStartTs.get(e.toolCallId) : undefined;
        const durationMs = started ? Date.now() - started : 0;
        if (e?.toolCallId) toolStartTs.delete(e.toolCallId);
        const full = flattenText(e?.result);
        const cap = toolMax();
        emit("tool_end", {
            toolCallId: e?.toolCallId,
            toolName: e?.toolName,
            isError: !!e?.isError,
            durationMs,
            result: resultPreview(e?.result),
            resultText: capText(full, cap),
            resultTruncated: isTruncated(full.length, cap),
        });
    });

    // (d) response received (≈ first byte): prefill = time since request sent.
    // (c) also surface provider errors here.
    pi.on("after_provider_response", async (e: any) => {
        respStartTs = Date.now();
        if (reqSentTs) prefillMs = respStartTs - reqSentTs;
        const status = Number(e?.status);
        if (status >= 400) {
            emit("error", {
                source: "provider",
                status,
                message: `provider responded ${status}`,
            });
        }
    });

    pi.on("model_select", async (e: any) => {
        emit("model_change", {
            model: e?.model?.id,
            previous: e?.previousModel?.id,
            source: e?.source,
        });
    });

    pi.on("session_compact", async () => {
        emit("compaction", {});
    });

    pi.on("session_shutdown", async (e: any) => {
        emit("session_end", { reason: e?.reason });
    });
}
