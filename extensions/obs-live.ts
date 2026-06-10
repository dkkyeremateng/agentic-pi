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
    usageFrom,
    argPreview,
    resultPreview,
    messageContent,
    capText,
    type EventFactory,
} from "../utils/obs-events";

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

function sinkPath(cwd: string): string {
    if (process.env.PI_OBS_SINK)
        return resolvePath(
            process.env.PI_OBS_SINK.replace(/^~(?=$|\/)/, homedir()),
        );
    return join(cwd, ".agent", "obs", "events.jsonl");
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
    let bootEmitted = false;
    let turnStartTs = 0;
    const toolStartTs = new Map<string, number>();

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
        append(serializeEvent(factory.next(type, payload)));
    };

    pi.on("session_start", async (_e: any, ctx: any) => {
        const cwd: string = ctx?.cwd ?? process.cwd();
        sink = sinkPath(cwd);
        try {
            mkdirSync(dirname(sink), { recursive: true });
        } catch {
            dead = true;
        }
        const agent =
            process.env.PI_OBS_AGENT ||
            (typeof pi.getSessionName === "function" && pi.getSessionName()) ||
            "orchestrator";
        // Unique per process so multiple agents never collide on (sessionId,seq).
        const sessionId = `${agent}-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 7)}`;
        factory = makeFactory({ sessionId, agent, cwd });
        emit("session_start", {
            model: ctx?.model?.id,
            pid: process.pid,
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

    pi.on("turn_end", async (e: any) => {
        const usage = usageFrom(e?.message);
        // (d) latency + throughput for this turn.
        const durationMs = turnStartTs ? Date.now() - turnStartTs : 0;
        const out = usage?.output ?? 0;
        const tps =
            durationMs > 0 && out > 0
                ? Math.round((out / durationMs) * 1000)
                : 0;
        emit("turn_end", {
            turnIndex: e?.turnIndex,
            tokens: usage,
            costUsd: usage?.costUsd ?? 0,
            durationMs,
            tps,
            model: e?.message?.model ?? e?.message?.responseModel,
            stopReason: e?.message?.stopReason,
            toolResults: Array.isArray(e?.toolResults)
                ? e.toolResults.length
                : 0,
        });
    });

    // (b) assistant text + thinking content (opt-in via PI_OBS_CONTENT).
    pi.on("message_end", async (e: any) => {
        if (!contentEnabled()) return;
        const msg = e?.message;
        if (!msg || msg.role !== "assistant") return;
        const { text, thinking } = messageContent(msg, contentMax());
        if (thinking)
            emit("message", { role: "assistant", kind: "thinking", text: thinking });
        if (text) emit("message", { role: "assistant", kind: "assistant", text });
    });

    pi.on("tool_execution_start", async (e: any) => {
        if (e?.toolCallId) toolStartTs.set(e.toolCallId, Date.now());
        emit("tool_start", {
            toolCallId: e?.toolCallId,
            toolName: e?.toolName,
            arg: argPreview(e?.args),
        });
    });

    pi.on("tool_execution_end", async (e: any) => {
        // (d) tool execution latency.
        const started = e?.toolCallId ? toolStartTs.get(e.toolCallId) : undefined;
        const durationMs = started ? Date.now() - started : 0;
        if (e?.toolCallId) toolStartTs.delete(e.toolCallId);
        emit("tool_end", {
            toolCallId: e?.toolCallId,
            toolName: e?.toolName,
            isError: !!e?.isError,
            durationMs,
            result: resultPreview(e?.result),
        });
    });

    // (c) Provider/API errors (429, 5xx, etc.) as a first-class error stream.
    pi.on("after_provider_response", async (e: any) => {
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
