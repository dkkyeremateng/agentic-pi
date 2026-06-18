// obs-chat-control.ts — the in-process state machine that turns a "steer the
// live agent" request into a streamed reply. Lives on the agent side (driven by
// obs-live's pi event hooks); kept pure here so it can be unit-tested without pi.
//
// Flow for one prompt:
//   beginPrompt(send)  → registers a reply sink (rejects if one's in flight)
//   <caller calls pi.sendUserMessage(text, {deliverAs})>
//   onAgentStart()     → the agent run our message triggered begins → bind
//   onAssistantEvent() → forward token/thinking/tool frames, accumulate text
//   onTurnEnd(cost,m)  → tally cost + model across the run's turns
//   onAgentEnd()       → emit the terminal `done` frame, release
// A socket close / session end calls fail() to emit a terminal `error`.

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assistantEventToChat, type ChatEvent } from "./obs-chat";

export type SendFrame = (f: ChatEvent) => void;

/** Metadata an agent publishes so the server can list/route to it while alive. */
export interface LiveSessionMeta {
    sessionId: string; // the obs session id (what the dashboard knows)
    agent: string;
    runId?: string;
    parent?: string;
    cwd: string;
    model?: string;
    tools?: string[]; // the agent's active tools (filled in on first turn / boot)
    pid: number;
    startedTs: number;
    sock: string; // unix socket path for the control channel
}

/** Directory holding one `<sessionId>.sock` + `<sessionId>.json` per live agent. */
export function controlDir(): string {
    return process.env.PI_OBS_CONTROL_DIR || join(homedir(), ".pi", "agent", "obs", "control");
}
export function sockPath(sessionId: string): string {
    return join(controlDir(), `${sessionId}.sock`);
}
export function sidecarPath(sessionId: string): string {
    return join(controlDir(), `${sessionId}.json`);
}

/** Is a process still running? (signal 0 = existence check; EPERM means alive.) */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
}

/** Live, attachable sessions: sidecars whose owning process is still alive.
 *  Dead ones are pruned (their socket + sidecar removed) so the list stays clean. */
export function listLiveSessions(prune = true): LiveSessionMeta[] {
    const dir = controlDir();
    if (!existsSync(dir)) return [];
    const out: LiveSessionMeta[] = [];
    let files: string[];
    try {
        files = readdirSync(dir);
    } catch {
        return [];
    }
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const p = join(dir, f);
        let meta: LiveSessionMeta;
        try {
            meta = JSON.parse(readFileSync(p, "utf-8")) as LiveSessionMeta;
        } catch {
            continue;
        }
        if (typeof meta?.pid === "number" && isPidAlive(meta.pid)) {
            out.push(meta);
        } else if (prune) {
            try {
                unlinkSync(p);
            } catch {}
            try {
                if (meta?.sock) unlinkSync(meta.sock);
            } catch {}
        }
    }
    out.sort((a, b) => b.startedTs - a.startedTs);
    return out;
}

interface Capture {
    send: SendFrame;
    buf: string; // accumulated assistant text (the reply)
    cost: number; // summed turn cost across the run
    tokens: number; // summed turn tokens across the run
    model?: string;
    done: boolean;
}

export class LiveChatControl {
    private pending: Capture | null = null; // prompt sent, its agent run not yet started
    private active: Capture | null = null; // bound to the running agent cycle

    /** True while a prompt is mid-flight — we serialize to one reply at a time. */
    busy(): boolean {
        return !!(this.pending || this.active);
    }

    /** Register a reply sink for a new prompt. Returns false if one is already in
     *  flight (caller should reject with a "busy" error and not inject). */
    beginPrompt(send: SendFrame): boolean {
        if (this.busy()) return false;
        this.pending = { send, buf: "", cost: 0, tokens: 0, model: undefined, done: false };
        return true;
    }

    /** The agent run triggered by our prompt has begun — bind the capture so we
     *  only collect text produced for THIS message (not unrelated prior output). */
    onAgentStart(): void {
        if (this.pending && !this.active) {
            this.active = this.pending;
            this.pending = null;
        }
    }

    onAssistantEvent(ame: Record<string, unknown> | undefined): void {
        const c = this.active;
        if (!c) return;
        const ev = assistantEventToChat(ame);
        if (!ev) return;
        if (ev.type === "token") c.buf += ev.text;
        c.send(ev); // token | thinking | tool — all stream straight through
    }

    /** A tool started/ended during the captured run — stream it to the client. */
    onTool(phase: "start" | "end", name: string): void {
        const c = this.active;
        if (!c) return;
        c.send({ type: "tool", phase, name });
    }

    onTurnEnd(costUsd: number, model?: string, tokens?: number): void {
        const c = this.active;
        if (!c) return;
        if (costUsd) c.cost += costUsd;
        if (tokens) c.tokens += tokens;
        if (model) c.model = model;
    }

    onAgentEnd(): void {
        const c = this.active;
        if (!c || c.done) return;
        c.done = true;
        c.send({ type: "done", text: c.buf, costUsd: c.cost, model: c.model, ...(c.tokens ? { tokens: c.tokens } : {}) });
        this.active = null;
    }

    /** Abort any in-flight reply (socket dropped, session ending, inject failed). */
    fail(error: string): void {
        const c = this.active || this.pending;
        if (c && !c.done) {
            c.done = true;
            c.send({ type: "error", error });
        }
        this.active = null;
        this.pending = null;
    }
}
