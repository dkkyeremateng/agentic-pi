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

import { appendFileSync, mkdirSync, writeFileSync, unlinkSync, utimesSync, chmodSync } from "fs";
import { join, dirname, resolve as resolvePath } from "path";
import { homedir } from "os";
import { createHash, randomBytes } from "crypto";
import { createServer, type Server, type Socket } from "net";
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
import {
    LiveChatControl,
    controlDir,
    sockPath,
    sidecarPath,
    HEARTBEAT_MS,
    type LiveSessionMeta,
} from "../obs/obs-chat-control";
import type { ChatEvent } from "../obs/obs-chat";
import { publishExternalSteer, publishHasUi } from "../utils/workflow/pane-mux";

// Cap (chars) for the full args/result captured for the expand-on-click view.
// Default caps each capture at 262144 chars (256 KB) to bound the sink size.
// Set PI_OBS_TOOL_MAX=<n> for a different cap, or 0/"full" for unlimited
// (tool args/results are the agent's working I/O — "full" keeps them whole).
function toolMax(): number {
    const v = process.env.PI_OBS_TOOL_MAX;
    if (v === "0" || v?.toLowerCase() === "full") return Infinity;
    if (!v) return 262_144;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 262_144 : Math.max(0, n);
}
function isTruncated(len: number, cap: number): boolean {
    return Number.isFinite(cap) && cap > 0 && len > cap;
}

function enabled(): boolean {
    return process.env.PI_OBS === "1" || process.env.PI_OBS === "true";
}

// (b) Message/thinking CONTENT is opt-in separately from structural events,
// because it can be large and may echo file contents or secrets. Off unless
// PI_OBS_CONTENT=1; each block capped to PI_OBS_CONTENT_MAX chars (default
// 2000, 0 = emit no content at all).
function contentEnabled(): boolean {
    return (
        process.env.PI_OBS_CONTENT === "1" ||
        process.env.PI_OBS_CONTENT === "true"
    );
}
// 0 = emit nothing (enforced at the emission sites — downstream capText treats
// <=0 as no-limit, so a 0 cap must never reach it).
function contentMax(): number {
    const n = parseInt(process.env.PI_OBS_CONTENT_MAX ?? "2000", 10);
    return Number.isNaN(n) ? 2000 : Math.max(0, n);
}

// A short, single-line run title from the root's first user prompt (metadata —
// like a window/tab title — so a list of same-project runs is distinguishable).
// On by default; set PI_OBS_TITLE=0 to suppress it if even the opening line is
// sensitive. Capped to PI_OBS_TITLE_MAX chars (default 100).
function titleEnabled(): boolean {
    return process.env.PI_OBS_TITLE !== "0" && process.env.PI_OBS_TITLE !== "false";
}
function shortTitle(s: string): string {
    const max = parseInt(process.env.PI_OBS_TITLE_MAX ?? "100", 10) || 100;
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
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
    // Live chat control: lets the dashboard steer THIS running agent (opt-out
    // with PI_OBS_CHAT=0). Best-effort throughout — never disrupt the agent.
    let control: LiveChatControl | undefined;
    let ctrlServer: Server | undefined;
    let liveSid = ""; // obs session id this process published a control channel for
    let liveMeta: LiveSessionMeta | undefined; // the published sidecar (re-written on boot)
    let liveCtx: any; // latest ExtensionContext, for ctx.abort() on a stop request
    let ctrlToken = ""; // shared secret required on control frames
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let ctrlCleaned = false;

    // HITL approval: when a steered turn opts in, these tools pause for a human
    // allow/deny over the control channel before they run.
    const approveTools = (process.env.PI_OBS_CHAT_APPROVE_TOOLS || "bash,edit,write")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const approveTimeoutMs = Number(process.env.PI_OBS_CHAT_APPROVE_TIMEOUT_MS) || 300_000;
    const pendingApprovals = new Map<string, (d: "allow" | "deny") => void>();

    // Refresh the control sidecar on disk (e.g. once the toolset is known at boot).
    const writeSidecar = (): void => {
        if (!liveMeta) return;
        try {
            // 0o600: the sidecar carries the control token (defense in depth on the 0700 dir)
            writeFileSync(sidecarPath(liveMeta.sessionId), JSON.stringify(liveMeta), { encoding: "utf-8", mode: 0o600 });
        } catch {}
    };

    const cleanupControl = (): void => {
        if (ctrlCleaned) return;
        ctrlCleaned = true;
        try {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
        } catch {}
        try {
            control?.fail("session ended");
        } catch {}
        try {
            ctrlServer?.close();
        } catch {}
        if (liveSid) {
            try {
                unlinkSync(sockPath(liveSid));
            } catch {}
            try {
                unlinkSync(sidecarPath(liveSid));
            } catch {}
        }
    };

    const setupControl = (meta: Omit<LiveSessionMeta, "pid" | "startedTs" | "sock">): void => {
        if (process.env.PI_OBS_CHAT === "0" || process.env.PI_OBS_CHAT === "false") return; // opt-out
        if (typeof pi.sendUserMessage !== "function") return; // not steerable in this mode
        try {
            mkdirSync(controlDir(), { recursive: true, mode: 0o700 }); // user-only
            try {
                chmodSync(controlDir(), 0o700); // enforce even if the dir pre-existed
            } catch {}
            control = new LiveChatControl();
            // Let the workflow pane layer see when THIS process is servicing an
            // externally-injected prompt (Telegram /attach or pi-obs chat), so it can
            // suppress viewer panes for those dispatches even on an interactive TTY.
            publishExternalSteer(() => control?.busy() ?? false);
            ctrlToken = randomBytes(18).toString("hex"); // shared secret for this session
            const sock = sockPath(meta.sessionId);
            try {
                // Defensive no-op: the sock path embeds this process's fresh
                // sessionId, so no crashed predecessor can already occupy it.
                unlinkSync(sock);
            } catch {}
            ctrlServer = createServer((conn: Socket) => {
                conn.unref?.(); // idle control connections must not pin the process
                let buf = "";
                const send = (f: ChatEvent): void => {
                    try {
                        conn.write(JSON.stringify(f) + "\n");
                    } catch {}
                    if (f.type === "done" || f.type === "error") {
                        try {
                            conn.end();
                        } catch {}
                    }
                };
                conn.on("data", (d: Buffer) => {
                    buf += d.toString();
                    let nl: number;
                    while ((nl = buf.indexOf("\n")) >= 0) {
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        if (!line.trim()) continue;
                        let req: { text?: string; deliverAs?: string; cmd?: string; approve?: boolean; toolCallId?: string; decision?: string; token?: string; images?: any[] };
                        try {
                            req = JSON.parse(line);
                        } catch {
                            send({ type: "error", error: "bad request" });
                            continue;
                        }
                        // every control frame must carry the session's shared secret
                        if (req.token !== ctrlToken) {
                            send({ type: "error", error: "unauthorized" });
                            continue;
                        }
                        // stop: interrupt the agent's current operation (pi's abort)
                        if (req.cmd === "abort") {
                            try {
                                liveCtx?.abort?.();
                            } catch {}
                            control?.fail("stopped by user");
                            continue;
                        }
                        // approval decision for a paused tool (may arrive on any connection)
                        if (req.cmd === "approve" && typeof req.toolCallId === "string") {
                            const resolve = pendingApprovals.get(req.toolCallId);
                            if (resolve) {
                                pendingApprovals.delete(req.toolCallId);
                                resolve(req.decision === "allow" ? "allow" : "deny");
                            }
                            continue;
                        }
                        const text = typeof req.text === "string" ? req.text.trim() : "";
                        const deliverAs = req.deliverAs === "steer" ? "steer" : "followUp";
                        if (!text) {
                            send({ type: "error", error: "empty prompt" });
                            continue;
                        }
                        if (!control || !control.beginPrompt(send, !!req.approve)) {
                            send({ type: "error", error: "agent busy with another chat turn" });
                            continue;
                        }
                        try {
                            const imgs = Array.isArray(req.images) ? req.images : [];
                            const content = imgs.length ? [{ type: "text", text }, ...imgs] : text;
                            pi.sendUserMessage(content, { deliverAs });
                        } catch (e: any) {
                            control.fail("inject failed: " + (e?.message || e));
                        }
                    }
                    // pre-auth memory bound: drop peers streaming an unframed >1 MB line
                    if (buf.length > 1_048_576) conn.destroy();
                });
                conn.on("error", () => {});
            });
            ctrlServer.on("error", () => {});
            ctrlServer.listen(sock, () => {
                try {
                    chmodSync(sock, 0o600); // user-only socket
                } catch {}
            });
            ctrlServer.unref(); // the control server must not keep the process alive
            liveMeta = { ...meta, pid: process.pid, startedTs: Date.now(), sock, token: ctrlToken };
            liveSid = meta.sessionId;
            writeSidecar();
            // heartbeat: bump the sidecar's mtime so the server can tell we're
            // still alive even if our pid is later reused by another process
            heartbeatTimer = setInterval(() => {
                try {
                    const t = Date.now() / 1000;
                    utimesSync(sidecarPath(liveSid), t, t);
                } catch {}
            }, HEARTBEAT_MS);
            heartbeatTimer.unref?.(); // don't keep the process alive for this
            // control teardown on exit is handled by the session-wide endSession()
            // exit hook (registered in session_start) — no separate hook needed here.
        } catch {
            // never let control setup break the run
        }
    };
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

    // Close the lane exactly once, then tear down the control channel. Called from
    // pi's session_shutdown (reload, and /quit's async dispose) AND from process
    // exit. The exit path is the safety net: /quit ends with process.exit(0), and
    // the async session_shutdown emit can lose the race with process death, so
    // without this the lane never gets a session_end and shows as stalled forever.
    // appendFileSync is legal inside an "exit" handler, so this lands reliably.
    let endEmitted = false;
    const endSession = (reason?: string): void => {
        if (!endEmitted && factory) {
            endEmitted = true;
            emit("session_end", { reason });
        }
        cleanupControl();
    };

    pi.on("session_start", async (_e: any, ctx: any) => {
        liveCtx = ctx; // for stop/abort over the control channel
        // pi re-fires session_start on /new, /resume, /fork and /reload within
        // the same process. Tear down the previous session's control channel and
        // re-arm the per-session one-shot latches so this session emits its own
        // boot + session_end and publishes a fresh control socket. The exit hook
        // stays double-emit safe: endEmitted only re-arms here, on a new session.
        cleanupControl();
        ctrlCleaned = false;
        endEmitted = false;
        bootEmitted = false;
        dead = false;
        // Tell the workflow pane layer whether THIS pi process is interactive
        // (ctx.hasUI) — the authoritative signal, unlike process.stdout.isTTY which
        // pi's TUI doesn't reliably keep. Sub-agents/headless runs report false.
        publishHasUi(() => (liveCtx as any)?.hasUI === true);
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
        // Safety net: guarantee a session_end even when pi's async session_shutdown
        // loses the race with process.exit(0) (e.g. /quit), or never fires at all
        // (hard exit). Runs before setupControl's own exit hook — endSession also
        // tears the control channel down, so that hook becomes a harmless no-op.
        process.once("exit", () => endSession("process_exit"));
        // Publish a control channel so the dashboard can steer this live agent.
        setupControl({ sessionId, agent, runId, parent, cwd, model: ctx?.model?.id });
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
        // surface the agent's real toolset on its control sidecar so the chat
        // attach UI can show what a live agent can actually do
        if (liveMeta && Array.isArray(o.selectedTools)) {
            liveMeta.tools = o.selectedTools as string[];
            writeSidecar();
        }
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
            // root's first prompt → a human title for the run (unnamed sessions
            // otherwise all collapse to the project name in the runs list)
            request: isRoot && titleEnabled() && typeof e?.prompt === "string" && e.prompt.trim() ? shortTitle(e.prompt) : undefined,
        });
        // (b) the user's prompt, when content capture is on (cap 0 = emit nothing).
        const cmax = contentMax();
        if (contentEnabled() && cmax > 0 && typeof e?.prompt === "string" && e.prompt.trim())
            emit("message", {
                role: "user",
                kind: "user",
                text: capText(e.prompt.trim(), cmax),
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
        // feed the live-chat capture: tally this turn's cost + tokens + model.
        // Split billable (fresh input+output) from cached (cacheRead+cacheWrite) so an
        // /attached run's Telegram footer reads the same as the spawned-chat path
        // (obs-chat.ts) — passing usage.total here conflated reused cache into "tok".
        try {
            control?.onTurnEnd(
                usage?.costUsd ?? 0,
                e?.message?.model ?? e?.message?.responseModel,
                (usage?.input ?? 0) + (usage?.output ?? 0),
                (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
            );
        } catch {}
        // reset per-turn timing so a turn without a provider call doesn't reuse
        // the previous turn's numbers
        reqSentTs = respStartTs = prefillMs = genTps = 0;
    });

    // Live-chat capture hooks — scope a steered reply to the agent run it triggers.
    // All best-effort: a throw here must never disrupt the agent.
    pi.on("agent_start", async () => {
        try {
            control?.onAgentStart();
        } catch {}
    });
    pi.on("agent_end", async () => {
        try {
            control?.onAgentEnd();
        } catch {}
    });
    pi.on("message_update", async (e: any) => {
        if (!control) return;
        try {
            control.onAssistantEvent(e?.assistantMessageEvent);
        } catch {}
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
        // (b) assistant text + thinking content (opt-in via PI_OBS_CONTENT;
        // cap 0 = emit nothing).
        if (!contentEnabled()) return;
        const cmax = contentMax();
        if (cmax === 0) return;
        const { text, thinking } = messageContent(msg, cmax);
        if (thinking)
            emit("message", { role: "assistant", kind: "thinking", text: thinking });
        if (text) emit("message", { role: "assistant", kind: "assistant", text });
    });

    // HITL approval gate: before a risky tool runs during an approval-enabled
    // steered turn, ask the human in chat and block on a deny. Async — pi awaits
    // this handler, so the tool can't run until a decision arrives. Best-effort:
    // any error here falls through to allowing the tool (never breaks the agent).
    pi.on("tool_call", async (e: any) => {
        try {
            if (!control || !control.wantsApproval()) return;
            const name = e?.toolName || "tool";
            if (!approveTools.includes(name)) return;
            const toolCallId = String(e?.toolCallId || `${name}-${Date.now()}`);
            const sent = control.emitToActive({ type: "approval", toolCallId, name, input: e?.input });
            if (!sent) return; // no chat consumer listening — don't stall the agent
            const decision = await new Promise<"allow" | "deny">((resolve) => {
                const timer = setTimeout(() => {
                    if (pendingApprovals.delete(toolCallId)) resolve("deny");
                }, approveTimeoutMs);
                timer.unref?.(); // an unanswered approval must not pin the event loop
                pendingApprovals.set(toolCallId, (d) => {
                    clearTimeout(timer);
                    resolve(d);
                });
            });
            if (decision === "deny") return { block: true, reason: "denied by human in chat" };
        } catch {
            /* never break the agent on approval errors */
        }
        return;
    });

    pi.on("tool_execution_start", async (e: any) => {
        try {
            control?.onTool("start", e?.toolName || "tool");
        } catch {}
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
        try {
            control?.onTool("end", e?.toolName || "tool");
        } catch {}
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

    // Context size just before a compaction, captured on session_before_compact
    // (ContextUsage.tokens is valid before compaction, null right after), so the
    // compaction event can report how full context got before it was reclaimed.
    let tokensBeforeCompact: number | null = null;
    pi.on("session_before_compact", async (_e: any, ctx: any) => {
        try {
            tokensBeforeCompact = ctx?.getContextUsage?.()?.tokens ?? null;
        } catch {
            tokensBeforeCompact = null;
        }
    });
    pi.on("session_compact", async (e: any) => {
        // reason: manual | threshold | overflow; willRetry: true on overflow
        // recovery (the aborted turn is retried after compacting). pi 0.79.8+
        // / 0.79.10.
        emit("compaction", {
            reason: e?.reason,
            willRetry: !!e?.willRetry,
            fromExtension: !!e?.fromExtension,
            ...(tokensBeforeCompact != null
                ? { tokensBefore: tokensBeforeCompact }
                : {}),
        });
        tokensBeforeCompact = null;
    });

    pi.on("session_shutdown", async (e: any) => {
        endSession(e?.reason);
    });
}
