// obs-bridge-telegram.ts — the Telegram transport for the obs bridge. Long-polls
// the Telegram Bot API (no inbound webhook, so the obs-server stays on loopback),
// maps each message onto the obs API via the pure helpers in obs-bridge-core, and
// streams the chat assistant's reply back by EDITING one message as tokens land.
//
// STDLIB ONLY (node:http/https). All the decision logic lives in obs-bridge-core
// (pure, unit-tested); this file is the I/O glue: HTTP, SSE parsing, the poll
// loop, and the throttled edit-stream.

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import type { ChatEvent } from "./obs-chat";
import {
    type BridgeConfig,
    chatSessionId,
    chunk,
    formatAttachable,
    formatLive,
    formatRuns,
    helpText,
    initStreamState,
    isAllowed,
    type LiveView,
    orchestrators,
    parseCommand,
    reduceChatEvent,
    renderStream,
    resolveAttachTarget,
    type RunView,
    shortId,
    usageText,
} from "./obs-bridge-core";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface HttpResult {
    status: number;
    text: string;
}

/** One buffered HTTP(S) request → {status, text}. Picks the module by protocol so
 *  it serves both the loopback obs API (http) and Telegram (https). */
function doRequest(urlStr: string, opts: { method?: string; headers?: Record<string, string>; timeoutMs?: number }, body?: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const mod = u.protocol === "https:" ? https : http;
        const req = mod.request(u, { method: opts.method || "GET", headers: opts.headers || {} }, (res) => {
            res.setEncoding("utf8");
            let text = "";
            res.on("data", (d) => (text += d));
            res.on("end", () => resolve({ status: res.statusCode || 0, text }));
        });
        req.on("error", reject);
        const tmo = opts.timeoutMs || 20_000;
        req.setTimeout(tmo, () => req.destroy(new Error(`request timed out after ${tmo}ms`)));
        if (body) req.write(body);
        req.end();
    });
}

// ── Telegram Bot API ─────────────────────────────────────────────────────────

/** Call a Telegram Bot API method (POST JSON). Throws on a non-ok response. */
async function tg(cfg: BridgeConfig, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    const url = `https://api.telegram.org/bot${cfg.token}/${method}`;
    const { status, text } = await doRequest(url, { method: "POST", headers: { "content-type": "application/json" }, timeoutMs }, JSON.stringify(params));
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`telegram ${method}: HTTP ${status} (unparseable response)`);
    }
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description || `HTTP ${status}`}`);
    return data.result;
}

const send = (cfg: BridgeConfig, chatId: number, text: string) => tg(cfg, "sendMessage", { chat_id: chatId, text });

/** Send a (possibly long) message as one or more Telegram-sized parts. */
async function sendChunked(cfg: BridgeConfig, chatId: number, text: string): Promise<void> {
    for (const part of chunk(text)) await send(cfg, chatId, part);
}

// ── obs API client ───────────────────────────────────────────────────────────

function apiHeaders(cfg: BridgeConfig): Record<string, string> {
    return cfg.apiToken ? { authorization: `Bearer ${cfg.apiToken}` } : {};
}

async function apiGetText(cfg: BridgeConfig, path: string): Promise<{ status: number; text: string }> {
    return doRequest(cfg.apiBase + path, { method: "GET", headers: apiHeaders(cfg) });
}
async function apiGetJson<T = any>(cfg: BridgeConfig, path: string): Promise<T> {
    const { status, text } = await apiGetText(cfg, path);
    if (status >= 400) throw new Error(`obs ${path}: HTTP ${status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
}
async function apiPostJson<T = any>(cfg: BridgeConfig, path: string, body: unknown): Promise<{ status: number; data: T }> {
    const { status, text } = await doRequest(cfg.apiBase + path, { method: "POST", headers: { ...apiHeaders(cfg), "content-type": "application/json" } }, JSON.stringify(body));
    let data: any = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        /* leave null */
    }
    return { status, data: data as T };
}

/** Stream an obs SSE endpoint (/api/chat or /api/chat-live), calling onEvent for
 *  each ChatEvent frame and resolving when the stream ends. The token rides as a
 *  query param (the EventSource transport rule the server mirrors). */
function streamSSE(cfg: BridgeConfig, path: string, params: Record<string, string>, onEvent: (e: ChatEvent) => void): Promise<void> {
    const u = new URL(cfg.apiBase + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    if (cfg.apiToken) u.searchParams.set("token", cfg.apiToken);

    return new Promise((resolve, reject) => {
        const mod = u.protocol === "https:" ? https : http;
        const req = mod.get(u, (res) => {
            if ((res.statusCode || 0) >= 400) {
                res.resume();
                reject(new Error(`obs ${path}: HTTP ${res.statusCode}`));
                return;
            }
            res.setEncoding("utf8");
            let buf = "";
            res.on("data", (d) => {
                buf += d;
                let idx: number;
                // SSE frames are separated by a blank line.
                while ((idx = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    for (const line of frame.split("\n")) {
                        const t = line.trim();
                        if (!t.startsWith("data:")) continue; // skip ": connected" comments
                        const json = t.slice(5).trim();
                        if (!json) continue;
                        try {
                            onEvent(JSON.parse(json) as ChatEvent);
                        } catch {
                            /* ignore a malformed frame */
                        }
                    }
                }
            });
            res.on("end", () => resolve());
        });
        req.on("error", reject);
        // Generous ceiling: the server kills its pi spawn on its own timeout well
        // before this. We just don't want to cut a long, healthy reply short.
        req.setTimeout(300_000, () => req.destroy(new Error("chat stream timed out")));
    });
}

// ── per-chat runtime state ─────────────────────────────────────────────────

interface BridgeState {
    /** /reset bumps a chat's salt so chatSessionId() yields a fresh pi session. */
    salt: Map<number, number>;
    /** Chats with a chat turn in flight — we serialize to one reply at a time. */
    busy: Set<number>;
    /** Chats currently /attached to a live run: their plain messages route into
     *  that run's orchestrator instead of the standalone assistant. */
    attached: Map<number, { runId: string; sessionId: string }>;
}

function newState(): BridgeState {
    return { salt: new Map(), busy: new Set(), attached: new Map() };
}

// ── search result formatting (transport-local; trivial) ──────────────────────

function formatSearch(events: any[], q: string): string {
    if (!events.length) return `no matches for "${q}".`;
    const lines = events.slice(0, 10).map((e) => {
        const p = (e?.payload || {}) as Record<string, unknown>;
        const bit = String(p.toolName || p.message || p.reason || p.status || p.text || e?.type || "").replace(/\s+/g, " ").slice(0, 80);
        const run = e?.runId ? ` · ${shortId(String(e.runId))}` : "";
        return `• ${e?.agent || "?"} ${e?.type || ""}${run}\n  ${bit}`;
    });
    return `matches for "${q}" (newest ${Math.min(events.length, 10)}):\n${lines.join("\n")}`;
}

// ── edit-streamed reply (shared by the assistant and an attached run) ─────────

/** Render a streamed ChatEvent reply into Telegram by editing one message as
 *  tokens land. `runStream` produces the SSE (assistant chat or a live run).
 *  Serialized to one reply per chat at a time. */
async function streamReply(cfg: BridgeConfig, state: BridgeState, chatId: number, runStream: (onEvent: (e: ChatEvent) => void) => Promise<void>): Promise<void> {
    if (state.busy.has(chatId)) {
        await send(cfg, chatId, "still working on your previous message — one at a time.");
        return;
    }
    state.busy.add(chatId);
    try {
        await tg(cfg, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
        const placeholder = await tg(cfg, "sendMessage", { chat_id: chatId, text: "..." });
        const messageId = placeholder.message_id as number;

        const s = initStreamState();
        let lastSent = "...";
        let lastEditAt = 0; // 0 ⇒ the first update edits immediately
        // Serialize every edit through one chain so they never overlap or land
        // out of order, and so the final edit is GUARANTEED to run (awaiting the
        // chain below) instead of being dropped while an intermediate edit is in
        // flight — that race is what truncated replies to the last partial frame.
        let editChain: Promise<void> = Promise.resolve();

        const enqueueEdit = (force: boolean): void => {
            const now = Date.now();
            if (!force && now - lastEditAt < cfg.editThrottleMs) return; // throttle the cadence, not the final edit
            lastEditAt = now;
            editChain = editChain.then(async () => {
                const body = chunk(renderStream(s))[0] ?? renderStream(s); // live-edit only the first Telegram-sized part
                if (body === lastSent) return; // skip "message is not modified"
                lastSent = body;
                try {
                    await tg(cfg, "editMessageText", { chat_id: chatId, message_id: messageId, text: body });
                } catch {
                    /* rate limit / transient — best effort, the final edit reconciles */
                }
            });
        };

        await runStream((ev) => {
            reduceChatEvent(s, ev);
            if (ev.type === "token" || ev.type === "tool") enqueueEdit(false);
        });

        enqueueEdit(true); // final edit: the complete text + cost footer, throttle-bypassed
        await editChain; // wait for it (and any queued edit) to actually land
        // Anything past the first Telegram-sized part goes as follow-up messages.
        const parts = chunk(renderStream(s));
        for (let i = 1; i < parts.length; i++) await send(cfg, chatId, parts[i]);
    } finally {
        state.busy.delete(chatId);
    }
}

/** Free text -> the standalone obs assistant (per-chat session for continuity). */
function runChat(cfg: BridgeConfig, state: BridgeState, chatId: number, text: string): Promise<void> {
    const params: Record<string, string> = { sessionId: chatSessionId(chatId, state.salt.get(chatId) || 0), text };
    if (cfg.model) params.model = cfg.model;
    if (cfg.cwd) params.cwd = cfg.cwd;
    if (cfg.chatTools) params.tools = "1";
    return streamReply(cfg, state, chatId, (onEvent) => streamSSE(cfg, "/api/chat", params, onEvent));
}

/** Free text while /attached -> inject into the live run's orchestrator and
 *  stream its reply. Auto-detaches if the run has since ended. */
async function runAttachedChat(cfg: BridgeConfig, state: BridgeState, chatId: number, att: { runId: string; sessionId: string }, text: string): Promise<void> {
    const live = await apiGetJson<LiveView[]>(cfg, `/api/live-sessions`);
    if (!live.some((srv) => srv.sessionId === att.sessionId)) {
        state.attached.delete(chatId);
        await send(cfg, chatId, `run ${shortId(att.runId)} is no longer live — detached. your message wasn't sent.`);
        return;
    }
    // followUp: queued as a normal user message (reliable whether the agent is
    // idle or mid-turn). approve stays off, so the run keeps its own tool policy.
    await streamReply(cfg, state, chatId, (onEvent) => streamSSE(cfg, "/api/chat-live", { sessionId: att.sessionId, text, deliverAs: "followUp" }, onEvent));
}

/** /attach <run-id> -> bind this chat to a live run so subsequent messages drive it. */
async function runAttach(cfg: BridgeConfig, state: BridgeState, chatId: number, runArg: string): Promise<void> {
    const live = await apiGetJson<LiveView[]>(cfg, `/api/live-sessions`);
    const target = resolveAttachTarget(live, runArg);
    if (target.kind === "ambiguous") {
        await sendChunked(cfg, chatId, `"${runArg}" matches several live runs — be more specific:\n${formatAttachable(target.options, Date.now())}`);
        return;
    }
    if (target.kind === "none") {
        const orch = orchestrators(live);
        await sendChunked(cfg, chatId, orch.length ? `no live run matches "${runArg}". live runs:\n${formatAttachable(orch, Date.now())}` : "no live runs right now. start one with PI_OBS=1 (e.g. ./run.sh --obs).");
        return;
    }
    const runId = target.target.runId || runArg;
    state.attached.set(chatId, { runId, sessionId: target.target.sessionId });
    await send(cfg, chatId, `attached to ${shortId(runId)} — your messages now drive this live run. /detach to stop.`);
}

// ── command dispatch ─────────────────────────────────────────────────────────

async function handleMessage(cfg: BridgeConfig, state: BridgeState, chatId: number, text: string): Promise<void> {
    const cmd = parseCommand(text);
    switch (cmd.kind) {
        case "help":
            await send(cfg, chatId, helpText());
            return;
        case "usage":
            await send(cfg, chatId, usageText(cmd.cmd));
            return;
        case "reset": {
            state.salt.set(chatId, (state.salt.get(chatId) || 0) + 1);
            const wasAttached = state.attached.delete(chatId);
            await send(cfg, chatId, wasAttached ? "detached and started a fresh conversation." : "started a fresh conversation.");
            return;
        }
        case "runs": {
            const runs = await apiGetJson<RunView[]>(cfg, `/api/runs?limit=${cmd.limit}`);
            await sendChunked(cfg, chatId, formatRuns(runs, Date.now()));
            return;
        }
        case "last": {
            const runs = await apiGetJson<RunView[]>(cfg, `/api/runs?limit=1`);
            if (!runs.length) {
                await send(cfg, chatId, "no runs recorded yet.");
                return;
            }
            const { status, text: digest } = await apiGetText(cfg, `/api/runs/${encodeURIComponent(runs[0].runId)}/digest?format=text`);
            await sendChunked(cfg, chatId, status >= 400 ? `could not load the run digest (HTTP ${status}).` : digest);
            return;
        }
        case "digest": {
            const { status, text: digest } = await apiGetText(cfg, `/api/runs/${encodeURIComponent(cmd.id)}/digest?format=text`);
            if (status === 404) {
                await send(cfg, chatId, `no run matches "${cmd.id}". try /runs for ids.`);
                return;
            }
            await sendChunked(cfg, chatId, status >= 400 ? `could not load that digest (HTTP ${status}).` : digest);
            return;
        }
        case "search": {
            const events = await apiGetJson<any[]>(cfg, `/api/search?q=${encodeURIComponent(cmd.q)}&limit=10`);
            await sendChunked(cfg, chatId, formatSearch(events, cmd.q));
            return;
        }
        case "live": {
            const live = await apiGetJson<LiveView[]>(cfg, `/api/live-sessions`);
            await sendChunked(cfg, chatId, formatLive(live, Date.now()));
            return;
        }
        case "verdict": {
            const { status, data } = await apiPostJson(cfg, `/api/runs/${encodeURIComponent(cmd.id)}/verdict`, { status: cmd.status, ...(cmd.note ? { note: cmd.note } : {}) });
            if (status === 404) {
                await send(cfg, chatId, `no run matches "${cmd.id}". try /runs for ids.`);
                return;
            }
            await send(cfg, chatId, status < 400 && (data as any)?.ok ? `scored ${shortId(cmd.id)} → ${cmd.status}.` : `could not score that run (HTTP ${status}).`);
            return;
        }
        case "attach":
            await runAttach(cfg, state, chatId, cmd.runArg);
            return;
        case "detach": {
            const had = state.attached.delete(chatId);
            await send(cfg, chatId, had ? "detached — messages go to the obs assistant again." : "you're not attached to a run.");
            return;
        }
        case "chat": {
            if (!cmd.text) return;
            const att = state.attached.get(chatId);
            if (att) await runAttachedChat(cfg, state, chatId, att, cmd.text);
            else await runChat(cfg, state, chatId, cmd.text);
            return;
        }
    }
}

// ── poll loop ────────────────────────────────────────────────────────────────

/** Long-poll Telegram and dispatch messages. Runs until the process exits. */
export async function runBridge(cfg: BridgeConfig): Promise<void> {
    const state = newState();
    let offset = 0;
    for (;;) {
        let updates: any[];
        try {
            updates = await tg(cfg, "getUpdates", { offset, timeout: cfg.pollTimeoutS, allowed_updates: ["message"] }, (cfg.pollTimeoutS + 15) * 1000);
        } catch (e) {
            console.error("obs-bridge: getUpdates failed:", String((e as Error)?.message || e));
            await sleep(3000);
            continue;
        }
        for (const u of updates) {
            offset = Math.max(offset, (u.update_id || 0) + 1);
            const msg = u.message;
            if (!msg || typeof msg.text !== "string") continue;
            const chatId = msg.chat?.id;
            if (typeof chatId !== "number") continue;

            if (!isAllowed(cfg, chatId)) {
                // Reveal only the user's own chat id — it's what they need to get
                // themselves added, and it leaks nothing about anyone else.
                await send(cfg, chatId, `not authorized. your chat id is ${chatId} — add it to PI_OBS_TG_ALLOW to enable the bridge.`).catch(() => {});
                continue;
            }
            try {
                await handleMessage(cfg, state, chatId, msg.text);
            } catch (e) {
                console.error("obs-bridge: handler error:", String((e as Error)?.message || e));
                await send(cfg, chatId, `sorry — something went wrong handling that. (${String((e as Error)?.message || e).slice(0, 200)})`).catch(() => {});
            }
        }
    }
}
