// obs-chat.ts — server-spawned chat with pi (the "A" architecture). Each user
// message spawns `pi -p --mode json --session-id <chatId>`, reusing the session
// so the conversation keeps context across turns. pi's line-delimited JSON
// stream is parsed into small ChatEvents the server relays to the browser (SSE),
// so the reply streams token-by-token.
//
// Mirrors obs-llm's constraints: STDLIB ONLY, opt-in (gated by the caller), and
// the spawn resolves `pi` via PI_OBS_PI_BIN (the detached server's PATH may lack
// the version-manager bin dir).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { llmConfig, type LlmConfig } from "./obs-llm";

/** Base directory pi stores project sessions under (one file per session,
 *  named `<timestamp>_<sessionId>.jsonl`, bucketed by project-path folder). */
export function sessionsBaseDir(): string {
    return process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
}

/** Resolve a pi session id to its on-disk `.jsonl` file by scanning the session
 *  store for `*_<id>.jsonl`. Returns the newest match, or null if none exists.
 *  Used both to (a) fork a run's session and (b) tell first-turn from later
 *  turns (our own chat session file won't exist until pi writes it). */
export function resolveSessionFile(id: string, base: string = sessionsBaseDir()): string | null {
    if (!id || !existsSync(base)) return null;
    const suffix = `_${id}.jsonl`;
    let best: string | null = null;
    let projects: string[];
    try {
        projects = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return null;
    }
    for (const proj of projects) {
        const dir = join(base, proj);
        let files: string[];
        try {
            files = readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of files) {
            // exact id match, or the timestamp_<id> convention
            if (f === `${id}.jsonl` || f.endsWith(suffix)) {
                const full = join(dir, f);
                if (!best || f > best.slice(best.lastIndexOf("/") + 1)) best = full;
            }
        }
    }
    return best;
}

export type ChatEvent =
    | { type: "token"; text: string } // assistant reply delta
    | { type: "thinking"; text: string } // reasoning delta
    | { type: "tool"; phase: "start" | "end"; name: string; detail?: string }
    | { type: "done"; text: string; costUsd: number; model?: string }
    | { type: "error"; error: string };

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** Map ONE pi `assistantMessageEvent` (the payload of a `message_update` frame,
 *  whether read from `--mode json` output or an in-process extension event) into
 *  a streaming ChatEvent, or null when it isn't reply content. Shared by the
 *  stdout parser (parseChatLine) and the live in-process collector. */
export function assistantEventToChat(ev: Record<string, unknown> | undefined): ChatEvent | null {
    const et = str(ev?.type);
    if (et === "text_delta") return { type: "token", text: str(ev?.delta) };
    if (et === "thinking_delta") return { type: "thinking", text: str(ev?.delta) };
    if (et === "tool_start")
        return { type: "tool", phase: "start", name: str(ev?.tool) || str(ev?.name) || "tool" };
    if (et === "tool_end")
        return { type: "tool", phase: "end", name: str(ev?.tool) || str(ev?.name) || "tool" };
    return null;
}

/** Parse ONE line of pi's `--mode json` output into a ChatEvent (or null when the
 *  frame isn't relevant to the chat surface). Pure — unit-tested over fixtures. */
export function parseChatLine(line: string): ChatEvent | null {
    const t = line.trim();
    if (!t) return null;
    let o: Record<string, unknown>;
    try {
        o = JSON.parse(t) as Record<string, unknown>;
    } catch {
        return null;
    }
    const type = str(o.type);

    if (type === "message_update") {
        return assistantEventToChat(o.assistantMessageEvent as Record<string, unknown> | undefined);
    }

    // agent_end is the definitive end of the turn — carries every message, so we
    // can resolve the final assistant text + total cost.
    if (type === "agent_end") {
        const msgs = Array.isArray(o.messages) ? (o.messages as Record<string, unknown>[]) : [];
        let text = "";
        let costUsd = 0;
        let model: string | undefined;
        for (const m of msgs) {
            if (str(m.role) !== "assistant") continue;
            const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
            text = content.filter((c) => str(c.type) === "text").map((c) => str(c.text)).join("");
            const usage = m.usage as Record<string, unknown> | undefined;
            const cost = usage?.cost as Record<string, unknown> | undefined;
            if (typeof cost?.total === "number") costUsd += cost.total;
            if (str(m.responseModel)) model = str(m.responseModel);
        }
        return { type: "done", text, costUsd, model };
    }

    return null;
}

export interface ChatRequest {
    sessionId: string; // pi --session-id; stable per conversation for continuity
    text: string;
    model?: string; // overrides the configured model
    cwd?: string; // project scope (sessions are per-cwd); defaults to server cwd
    tools?: boolean; // v1 default false — a text assistant, no side effects
    // Attach-to-run: a run agent's pi session id to FORK on the first turn, so
    // this chat inherits that run's full context. Honoured only while our own
    // session (sessionId) doesn't exist yet; later turns just continue it. Fork
    // is a copy — it never writes back to the source/live run.
    forkFrom?: string;
}

export type SpawnFn = typeof spawn;

/** Spawn pi for one chat turn and stream parsed ChatEvents to `onEvent`.
 *  Resolves when pi exits; a spawn/exit failure surfaces as an `error` event
 *  (so the route can end the stream cleanly) and rejects. */
export function streamChat(
    req: ChatRequest,
    onEvent: (e: ChatEvent) => void,
    cfg: LlmConfig = llmConfig(),
    spawnImpl: SpawnFn = spawn,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const bin = process.env.PI_OBS_PI_BIN || "pi";
        const model = (req.model || cfg.model || "").trim();

        // Fork the attached run's session into ours on the FIRST turn only
        // (i.e. before our own session file exists). After that, plain continue.
        let forkPath: string | null = null;
        if (req.forkFrom && !resolveSessionFile(req.sessionId)) {
            forkPath = resolveSessionFile(req.forkFrom);
            if (!forkPath) {
                onEvent({
                    type: "error",
                    error: `attach failed — no session file found for '${req.forkFrom}' (the run may be too old or pruned)`,
                });
                resolve();
                return;
            }
        }

        const args = ["-p", "--mode", "json"];
        if (forkPath) args.push("--fork", forkPath);
        args.push("--session-id", req.sessionId, "--no-skills");
        if (!req.tools) args.push("--no-tools", "--no-extensions");
        if (model) args.push("--model", model);
        args.push(req.text);

        let proc: ChildProcessWithoutNullStreams;
        try {
            proc = spawnImpl(bin, args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env,
                cwd: req.cwd || process.cwd(),
            }) as ChildProcessWithoutNullStreams;
        } catch (e) {
            onEvent({ type: "error", error: String((e as Error)?.message || e) });
            reject(e);
            return;
        }

        let buf = "";
        let err = "";
        let sawDone = false;
        const timer = setTimeout(() => proc.kill("SIGTERM"), cfg.timeoutMs);

        proc.stdout.on("data", (d: Buffer) => {
            buf += d.toString();
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const ev = parseChatLine(line);
                if (ev) {
                    if (ev.type === "done") sawDone = true;
                    onEvent(ev);
                }
            }
        });
        proc.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
        proc.on("error", (e) => {
            clearTimeout(timer);
            const hint =
                (e as NodeJS.ErrnoException).code === "ENOENT"
                    ? ` — '${bin}' not on PATH; set PI_OBS_PI_BIN`
                    : "";
            onEvent({ type: "error", error: `spawn ${bin}: ${e.message}${hint}` });
            reject(e);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            // flush any trailing partial line
            const ev = parseChatLine(buf);
            if (ev) {
                if (ev.type === "done") sawDone = true;
                onEvent(ev);
            }
            if (code !== 0 && !sawDone) {
                onEvent({ type: "error", error: `pi exited ${code}${err ? `: ${err.slice(-300)}` : ""}` });
            }
            resolve();
        });
    });
}
