// obs-bridge-core.ts — pure, transport-agnostic logic for the messaging bridge
// that lets you talk to the obs API from a chat app (Telegram first). NO I/O
// lives here: config, allowlist, chat-id → pi-session mapping, command parsing,
// the streaming ChatEvent → display-text reducer, edit-stream throttling, and
// message formatting/chunking. The transport (obs-bridge-telegram.ts) does the
// actual HTTP/SSE + Telegram Bot API calls and drives these helpers.
//
// Design constraints (mirrors the rest of obs-*):
//   - STDLIB ONLY (this file has zero imports beyond a type).
//   - OFF BY DEFAULT — the bridge runs only when PI_OBS_TG_TOKEN is set, and a
//     message is acted on only when its chat id is on PI_OBS_TG_ALLOW.
//   - PURE + UNIT-TESTED — every function here is deterministic given its args.

import type { ChatEvent } from "./obs-chat";

// ── config ───────────────────────────────────────────────────────────────────

export interface BridgeConfig {
    /** True once a bot token is present — nothing polls Telegram without it. */
    enabled: boolean;
    /** Telegram Bot API token (from @BotFather). */
    token: string;
    /** Allowed Telegram chat ids. Empty ⇒ nobody is allowed (fail closed). */
    allow: number[];
    /** obs-server base URL the bridge calls (loopback by default). */
    apiBase: string;
    /** Shared secret for the obs API (PI_OBS_TOKEN), or "" when the API is open. */
    apiToken: string;
    /** Optional model override forwarded to /api/chat. */
    model: string;
    /** Optional project dir scope forwarded to /api/chat (sessions are per-cwd). */
    cwd: string;
    /** Allow the chat assistant to use tools (default false — text-only, no side
     *  effects). Steering a live agent is a separate, explicit surface. */
    chatTools: boolean;
    /** Recognise the bare "<agent>, <prompt>" form (else only /dispatch works).
     *  Off by default — opt-in to avoid mistaking a normal message for a dispatch. */
    dispatchBare: boolean;
    /** Long-poll timeout (seconds) handed to Telegram getUpdates. */
    pollTimeoutS: number;
    /** Minimum gap between live message edits while a reply streams (ms). */
    editThrottleMs: number;
}

/** Telegram's hard limit on a single message's text length. */
export const TG_LIMIT = 4096;

function intList(raw: string | undefined): number[] {
    if (!raw) return [];
    return raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n));
}

export function bridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
    const token = (env.PI_OBS_TG_TOKEN || "").trim();
    // Build the obs API base the same way run.sh / the server resolve host+port,
    // so the bridge talks to the local server with no extra config. An explicit
    // PI_OBS_BRIDGE_API always wins (e.g. a remote/containerised server).
    const host = (env.PI_OBS_HOST || "127.0.0.1").trim();
    // 0.0.0.0 is a bind address, not a dial address — reach it over loopback.
    const dial = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const port = Number(env.PI_OBS_PORT) || 7616;
    const apiBase = (env.PI_OBS_BRIDGE_API || `http://${dial}:${port}`).replace(/\/+$/, "");
    return {
        enabled: !!token,
        token,
        allow: intList(env.PI_OBS_TG_ALLOW),
        apiBase,
        apiToken: (env.PI_OBS_TOKEN || "").trim(),
        model: (env.PI_OBS_TG_MODEL || "").trim(),
        cwd: (env.PI_OBS_TG_CWD || "").trim(),
        chatTools: env.PI_OBS_TG_TOOLS === "1" || env.PI_OBS_TG_TOOLS === "true",
        dispatchBare: env.PI_OBS_TG_BARE_DISPATCH === "1" || env.PI_OBS_TG_BARE_DISPATCH === "true",
        pollTimeoutS: Number(env.PI_OBS_TG_POLL_S) || 50,
        editThrottleMs: Number(env.PI_OBS_TG_EDIT_MS) || 1200,
    };
}

/** Is this chat id allowed to use the bridge? Fail closed: an empty allowlist
 *  means nobody (you must opt people in explicitly). */
export function isAllowed(cfg: BridgeConfig, chatId: number): boolean {
    return cfg.allow.includes(chatId);
}

/** Stable pi session id for a Telegram chat, so the conversation keeps context
 *  across turns. `salt` rotates the session on /reset (a fresh conversation).
 *  Stays within the server's `^[\w.-]{1,64}$` sessionId rule. */
export function chatSessionId(chatId: number, salt = 0): string {
    return `tg-${chatId}${salt ? `-${salt}` : ""}`;
}

/** Stable pi session id for a chat's dispatches to one agent, so follow-ups
 *  (`seeker, …` again) continue that agent's context. Rotated by the same salt as
 *  the chat session, so /reset clears it too. Stays within `^[\w.-]{1,64}$`. */
export function dispatchSessionId(chatId: number, agent: string, salt = 0): string {
    const key = agent.toLowerCase().replace(/[^\w.-]/g, "-").slice(0, 24);
    return `tg-d-${chatId}-${key}${salt ? `-${salt}` : ""}`;
}

// ── command parsing ────────────────────────────────────────────────────────

export type Command =
    | { kind: "chat"; text: string }
    | { kind: "help" }
    | { kind: "runs"; limit: number }
    | { kind: "last" }
    | { kind: "digest"; id: string }
    | { kind: "search"; q: string }
    | { kind: "verdict"; status: "pass" | "fail" | "open"; id: string; note: string }
    | { kind: "live" }
    | { kind: "attach"; runArg: string }
    | { kind: "detach" }
    | { kind: "agents" }
    | { kind: "dispatch"; agent: string; text: string }
    | { kind: "do"; text: string }
    | { kind: "reset" }
    | { kind: "usage"; cmd: string }; // recognised command, wrong/missing args

/** Split "<agent>, <text>" (or "<agent> <text>") into its parts, preferring a
 *  comma/colon separator. Returns null when either side is empty. */
function splitAgentText(rest: string): { agent: string; text: string } | null {
    const s = rest.trim();
    if (!s) return null;
    const sep = s.search(/[,:]/);
    const ws = s.search(/\s/);
    let agent: string, text: string;
    if (sep !== -1 && (ws === -1 || sep < ws)) {
        agent = s.slice(0, sep).trim();
        text = s.slice(sep + 1).trim();
    } else if (ws !== -1) {
        agent = s.slice(0, ws).trim();
        text = s.slice(ws + 1).trim();
    } else {
        return null; // only an agent name, no prompt
    }
    return agent && text ? { agent, text } : null;
}

/** Recognise the bare "<agent>, <prompt>" / "<agent>: <prompt>" form (opt-in via
 *  PI_OBS_TG_BARE_DISPATCH). Strict: a comma/colon separator AND the leading word
 *  must be a known agent — otherwise it's just a normal chat message. Pure. */
export function parseBareDispatch(text: string, agentNames: string[]): { agent: string; text: string } | null {
    const m = (text || "").trim().match(/^([A-Za-z0-9_.-]+)\s*[,:]\s+([\s\S]+)$/);
    if (!m) return null;
    const agent = m[1];
    const prompt = m[2].trim();
    if (!prompt) return null;
    return agentNames.some((n) => n.toLowerCase() === agent.toLowerCase()) ? { agent, text: prompt } : null;
}

/** Map a raw message into a Command. A leading "/" is a slash command (Telegram
 *  may suffix it with @botname in groups — stripped); anything else is free-text
 *  routed to the chat assistant. */
export function parseCommand(raw: string): Command {
    const text = (raw || "").trim();
    if (!text.startsWith("/")) return { kind: "chat", text };

    const sp = text.indexOf(" ");
    let cmd = (sp === -1 ? text : text.slice(0, sp)).slice(1).toLowerCase();
    const at = cmd.indexOf("@"); // /help@MyBot → help
    if (at !== -1) cmd = cmd.slice(0, at);
    const rest = sp === -1 ? "" : text.slice(sp + 1).trim();

    switch (cmd) {
        case "start":
        case "help":
            return { kind: "help" };
        case "reset":
        case "new":
            return { kind: "reset" };
        case "runs": {
            const n = Number(rest);
            return { kind: "runs", limit: Number.isInteger(n) && n > 0 ? Math.min(n, 20) : 5 };
        }
        case "last":
            return { kind: "last" };
        case "live":
            return { kind: "live" };
        case "attach":
            return rest ? { kind: "attach", runArg: rest.split(/\s+/)[0] } : { kind: "usage", cmd: "attach" };
        case "detach":
            return { kind: "detach" };
        case "agents":
            return { kind: "agents" };
        case "dispatch":
        case "run": {
            const r = splitAgentText(rest);
            return r ? { kind: "dispatch", agent: r.agent, text: r.text } : { kind: "usage", cmd: "dispatch" };
        }
        case "do":
            return rest ? { kind: "do", text: rest } : { kind: "usage", cmd: "do" };
        case "digest":
            return rest ? { kind: "digest", id: rest.split(/\s+/)[0] } : { kind: "usage", cmd: "digest" };
        case "search":
            return rest ? { kind: "search", q: rest } : { kind: "usage", cmd: "search" };
        case "pass":
        case "fail":
        case "open": {
            if (!rest) return { kind: "usage", cmd };
            const m = rest.split(/\s+/);
            const id = m[0];
            const note = rest.slice(id.length).trim();
            return { kind: "verdict", status: cmd as "pass" | "fail" | "open", id, note };
        }
        default:
            // Unknown slash command — don't silently feed "/foo" to the model.
            return { kind: "usage", cmd };
    }
}

// ── streaming reduce (ChatEvent → display text) ──────────────────────────────

export interface StreamState {
    text: string; // accumulated assistant reply
    activeTool?: string; // a tool currently running (shown as a status line)
    done: boolean;
    error?: string;
    costUsd: number;
    tokens?: number; // billable (input+output) tokens
    cachedTokens?: number; // reused cached context (cacheRead+cacheWrite)
    model?: string;
}

export function initStreamState(): StreamState {
    return { text: "", done: false, costUsd: 0 };
}

/** Fold one streamed ChatEvent into the running display state (in place). Tokens
 *  accumulate the reply; tool start/end drive a transient status line; `done`
 *  carries the authoritative final text + cost/tokens/model. Reasoning frames
 *  are dropped (we surface the answer, not the model's thinking). */
export function reduceChatEvent(s: StreamState, ev: ChatEvent): StreamState {
    switch (ev.type) {
        case "token":
            s.text += ev.text;
            break;
        case "thinking":
            break; // not surfaced in chat
        case "tool":
            s.activeTool = ev.phase === "start" ? ev.name : undefined;
            break;
        case "approval":
            // Tools are off by default, so this is rare. Surface it rather than
            // hang — the bridge can't approve from here in v1.
            s.activeTool = undefined;
            s.error = `the agent paused for tool approval (${ev.name}); approve it from the dashboard`;
            s.done = true;
            break;
        case "done":
            s.done = true;
            if (ev.text) s.text = ev.text; // authoritative final text
            s.costUsd = ev.costUsd || 0;
            s.tokens = ev.tokens;
            s.cachedTokens = ev.cachedTokens;
            s.model = ev.model;
            s.activeTool = undefined;
            break;
        case "error":
            s.error = ev.error;
            s.done = true;
            s.activeTool = undefined;
            break;
    }
    return s;
}

// ── formatting ───────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
    if (!usd) return "$0";
    return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
function fmtTok(n: number | undefined): string {
    if (!n) return "0 tok";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}
/** Compact count without a unit suffix — for the cached parenthetical. */
function fmtNum(n: number | undefined): string {
    if (!n) return "0";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
export function fmtAge(ms: number, now: number): string {
    const d = Math.max(0, now - ms);
    const s = Math.round(d / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

/** Render the streaming state into the text shown in Telegram. While a reply is
 *  in flight an ellipsis / running-tool line signals progress; once done a small
 *  cost footer is appended. */
export function renderStream(s: StreamState): string {
    if (s.error && !s.text) return `error: ${s.error}`;
    let body = s.text || (s.done ? "(no reply)" : "...");
    if (!s.done && s.activeTool) body += `\n\n... running ${s.activeTool}`;
    if (s.done) {
        if (s.error) body += `\n\n(interrupted: ${s.error})`;
        const cache = s.cachedTokens ? ` (+${fmtNum(s.cachedTokens)} cached)` : "";
        const foot = `${fmtCost(s.costUsd)} · ${fmtTok(s.tokens)}${cache}${s.model ? ` · ${s.model}` : ""}`;
        if (s.costUsd || s.tokens || s.cachedTokens) body += `\n\n— ${foot}`;
    }
    return body;
}

// Minimal structural views of the obs API responses the bridge reads — keeps
// this module free of server-internal type imports.
export interface RunView {
    runId: string;
    name?: string;
    cwd?: string;
    costUsd?: number;
    tokens?: number;
    toolCalls?: number;
    errors?: number;
    lastTs?: number;
    agents?: string[];
    verdict?: { status?: string };
}
export interface LiveView {
    sessionId: string;
    agent: string;
    runId?: string;
    cwd?: string;
    model?: string;
    startedTs?: number;
}

function projectOf(cwd: string | undefined): string {
    if (!cwd) return "—";
    const parts = cwd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
}
/** Short, recognisable run id (the unique-prefix the API accepts on :id). */
export function shortId(runId: string): string {
    // run-mqa9m2kb-z027y → mqa9m2kb-z027y is plenty unique; keep the run- off for
    // brevity but the API matches on the full or any unique prefix either way.
    return runId.replace(/^run-/, "");
}

export function formatRuns(runs: RunView[], now: number): string {
    if (!runs.length) return "no runs recorded yet.";
    const lines = runs.map((r) => {
        const v = r.verdict?.status ? ` · ${r.verdict.status}` : "";
        const errs = r.errors ? ` · ${r.errors} err` : "";
        const when = r.lastTs ? ` · ${fmtAge(r.lastTs, now)}` : "";
        return (
            `• ${shortId(r.runId)} — ${projectOf(r.cwd)}` +
            (r.name ? ` · "${r.name}"` : "") +
            `\n  ${fmtCost(r.costUsd || 0)} · ${fmtTok(r.tokens)} · ${r.toolCalls || 0} tools${errs}${when}${v}`
        );
    });
    return lines.join("\n");
}

export function formatLive(sessions: LiveView[], now: number): string {
    if (!sessions.length) return "no agents are running right now.";
    return sessions
        .map(
            (s) =>
                `• ${s.agent} — ${projectOf(s.cwd)}` +
                (s.model ? ` · ${s.model}` : "") +
                (s.startedTs ? ` · started ${fmtAge(s.startedTs, now)}` : "") +
                `\n  session ${s.sessionId}`,
        )
        .join("\n");
}

/** Root-orchestrator live sessions (the attachable ones). obs-live publishes the
 *  root agent as "orchestrator"; sub-agents carry their own names. */
export function orchestrators(sessions: LiveView[]): LiveView[] {
    return sessions.filter((s) => s.agent === "orchestrator");
}

export type AttachTarget =
    | { kind: "none" } // no live run matches
    | { kind: "ambiguous"; options: LiveView[] } // prefix matched several
    | { kind: "ok"; target: LiveView };

/** Resolve `/attach <runArg>` to a single live orchestrator. Matches the run id
 *  (full or prefix, with or without the `run-` prefix) against live root agents.
 *  Pure. */
export function resolveAttachTarget(sessions: LiveView[], runArg: string): AttachTarget {
    const orch = orchestrators(sessions);
    const q = runArg.replace(/^run-/, "").trim();
    if (!q) return { kind: "none" };
    const matches = orch.filter((s) => (s.runId || "").replace(/^run-/, "").startsWith(q));
    if (matches.length === 1) return { kind: "ok", target: matches[0] };
    if (matches.length === 0) return { kind: "none" };
    return { kind: "ambiguous", options: matches };
}

/** List attachable live runs by run id (what /attach takes), newest detail first. */
export function formatAttachable(sessions: LiveView[], now: number): string {
    if (!sessions.length) return "no live runs right now.";
    return sessions
        .map((s) => `• ${shortId(s.runId || "?")} — ${projectOf(s.cwd)}${s.model ? ` · ${s.model}` : ""}${s.startedTs ? ` · started ${fmtAge(s.startedTs, now)}` : ""}`)
        .join("\n");
}

export interface AgentInfo {
    name: string;
    description?: string;
    model?: string;
    readOnly?: boolean;
}

/** Render the /agents reply. Every agent is dispatchable (confined to the cwd);
 *  write-capable ones are tagged so the extra blast radius is visible. */
export function formatAgents(agents: AgentInfo[]): string {
    if (!agents.length) return "no agents found.";
    const line = (a: AgentInfo) => `• ${a.name}${a.readOnly ? "" : " (writes)"}${a.description ? ` — ${a.description}` : ""}`;
    return "agents (all dispatchable, confined to the project dir):\n" + agents.map(line).join("\n") + "\n\nuse: /dispatch <agent>, <prompt>";
}

/** One bridge command. Single source of truth for BOTH the `/help` listing and
 *  the Telegram command menu (setMyCommands → the `/` autocomplete popup).
 *  `args` is the human arg hint shown after the command; Telegram's menu shows
 *  `command` + `description` (we fold `args` into the description so the popup is
 *  self-documenting). Only user-facing commands belong here — hidden aliases
 *  (/start, /new, /run) stay recognised by parseCommand but out of the menu. */
export interface BotCommand {
    command: string; // no leading slash; Telegram requires 1–32 chars of [a-z0-9_]
    args?: string; // e.g. "[n]", "<id>", "<agent>, <prompt>"
    description: string; // Telegram allows 1–256 chars
}

export const BOT_COMMANDS: BotCommand[] = [
    { command: "runs", args: "[n]", description: "recent runs (default 5)" },
    { command: "last", description: "the most recent run's digest" },
    { command: "digest", args: "<id>", description: "what happened in a run" },
    { command: "search", args: "<text>", description: "search across all runs" },
    { command: "live", description: "agents running right now" },
    { command: "pass", args: "<id> [note]", description: "score a run pass" },
    { command: "fail", args: "<id> [note]", description: "score a run fail" },
    { command: "open", args: "<id> [note]", description: "mark a run needs-review" },
    { command: "agents", description: "list dispatchable agents" },
    { command: "do", args: "<task>", description: "auto-pick the best agent for a task (or just answer)" },
    { command: "dispatch", args: "<agent>, <prompt>", description: "run a specific agent in the project dir" },
    { command: "attach", args: "<run-id>", description: "route your messages into a live run (drive it)" },
    { command: "detach", description: "stop routing; back to the assistant" },
    { command: "reset", description: "fresh conversation (also detaches)" },
    { command: "help", description: "show the command list" },
];

/** The setMyCommands payload — validated/clamped to Telegram's constraints
 *  (command ∈ [1..32] of [a-z0-9_], description ∈ [1..256]). Just the plain
 *  description: Telegram already renders the `/command` and its own separator,
 *  so folding the arg hint in here would double up ("/runs — [n] — recent…").
 *  Arg syntax stays in /help, where there's room for it. */
export function telegramCommands(): { command: string; description: string }[] {
    return BOT_COMMANDS.map((c) => ({
        command: c.command,
        description: c.description.slice(0, 256),
    }));
}

export function helpText(): string {
    return [
        "pi obs bridge — talk to your agent observability.",
        "",
        "Send any message to chat with the obs assistant (it knows your runs).",
        "",
        "Commands:",
        ...BOT_COMMANDS.map((c) => `/${c.command}${c.args ? ` ${c.args}` : ""} — ${c.description}`),
    ].join("\n");
}

export function usageText(cmd: string): string {
    switch (cmd) {
        case "digest":
            return "usage: /digest <run-id>  (get an id from /runs)";
        case "search":
            return "usage: /search <text>";
        case "attach":
            return "usage: /attach <run-id>  (a live run — see /runs or /live)";
        case "dispatch":
            return "usage: /dispatch <agent>, <prompt>  (see /agents)";
        case "do":
            return "usage: /do <task>  (auto-selects an agent, or answers if it's a question)";
        case "pass":
        case "fail":
        case "open":
            return `usage: /${cmd} <run-id> [note]`;
        default:
            return `unknown command /${cmd}. send /help for the list.`;
    }
}

/** Split text into Telegram-sized pieces, preferring line/paragraph boundaries
 *  and hard-splitting only when a single line exceeds the limit. */
export function chunk(text: string, limit = TG_LIMIT): string[] {
    if (text.length <= limit) return [text];
    const out: string[] = [];
    let cur = "";
    for (const line of text.split("\n")) {
        if (line.length > limit) {
            // flush what we have, then hard-split the long line
            if (cur) {
                out.push(cur);
                cur = "";
            }
            for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
            continue;
        }
        const add = cur ? `${cur}\n${line}` : line;
        if (add.length > limit) {
            out.push(cur);
            cur = line;
        } else {
            cur = add;
        }
    }
    if (cur) out.push(cur);
    return out;
}
