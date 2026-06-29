// obs-dispatch.ts — spawn a single named workflow agent headless and stream its
// reply, with NO active run/orchestrator required. The obs-server exposes this
// via /api/dispatch + /api/agents; the Telegram bridge drives it (e.g.
// "seeker, ping https://google.com").
//
// Design (mirrors obs-chat/obs-llm):
//   - Reuses the workflow's own spawn recipe (loadAgents, subagentExtArgs,
//     spawnModelArg, …) so a dispatched agent is identical to one the orchestrator
//     would spawn — same prompt, tools, model, guards.
//   - STDLIB + workflow-core only; resolves pi via PI_OBS_PI_BIN.
//   - OFF BY DEFAULT (the route is gated on PI_OBS_DISPATCH=1). ANY agent may be
//     dispatched.
//   - CONFINED TO THE cwd: cwd-guard is FORCED on (PI_CONFINE_CWD), so the agent's
//     FILE tools (read/write/edit/grep/find/ls) cannot escape the caller-provided
//     cwd. CAVEAT: `bash` is NOT confined in-process — a shell command can still
//     reach outside the cwd; hard isolation needs an OS sandbox/container.
//   - The agent runs as its OWN root run, so it shows on the dashboard.

import { spawn } from "node:child_process";
import { parseChatLine, type ChatEvent } from "./obs-chat";
import {
    type AgentDef,
    loadAgents,
    shouldApproveProjectForSpawn,
    spawnModelArg,
    spawnSessionName,
    subagentExtArgs,
    TRIVIAL_PING_RULE,
} from "../utils/workflow/workflow-core";

/** A read-only agent has no file-mutating tool (no `write`/`edit`) — the same
 *  `canWrite` test subagentExtArgs uses. These are the only dispatchable agents:
 *  they read/search/query, never change state. Excludes implementer, shipper, and
 *  the plan-writers (planner/refiner, which write .agent/plan.md). */
export function isReadOnlyAgent(def: AgentDef): boolean {
    return !/\b(write|edit)\b/.test(def.tools || "");
}

export interface AgentInfo {
    name: string;
    description: string;
    model: string;
    readOnly: boolean;
}

/** All known agents (project `.pi/agents/` then bundled), each flagged read-only. */
export function listAgents(cwd: string): AgentInfo[] {
    const out: AgentInfo[] = [];
    for (const def of loadAgents(cwd).values())
        out.push({ name: def.name, description: def.description || "", model: def.model || "", readOnly: isReadOnlyAgent(def) });
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve an agent by name or alias (case-insensitive). */
export function resolveAgent(cwd: string, name: string): AgentDef | null {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    for (const def of loadAgents(cwd).values()) {
        if (def.name.toLowerCase() === want) return def;
        if (def.aliases?.some((a) => a.toLowerCase() === want)) return def;
    }
    return null;
}

export interface DispatchRequest {
    agent: string;
    text: string;
    cwd: string;
    model?: string;
    sessionId?: string; // continuity across follow-ups (per chat+agent)
    signal?: AbortSignal; // abort kills the spawned pi (client disconnect / stop)
}

export interface DispatchConfig {
    timeoutMs: number;
}
export function dispatchConfig(env: NodeJS.ProcessEnv = process.env): DispatchConfig {
    return { timeoutMs: Number(env.PI_OBS_DISPATCH_TIMEOUT_MS) || 300_000 };
}

export type SpawnFn = typeof spawn;

/** Spawn the named agent for one task and stream parsed ChatEvents to onEvent.
 *  Validation failures (unknown agent / not read-only) surface as an `error`
 *  event then resolve (so the SSE route ends cleanly). Resolves when pi exits. */
export function dispatchStream(
    req: DispatchRequest,
    onEvent: (e: ChatEvent) => void,
    cfg: DispatchConfig = dispatchConfig(),
    spawnImpl: SpawnFn = spawn,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const def = resolveAgent(req.cwd, req.agent);
        if (!def) {
            onEvent({ type: "error", error: `unknown agent "${req.agent}". send /agents for the list.` });
            resolve();
            return;
        }

        const bin = process.env.PI_OBS_PI_BIN || "pi";
        const args = [
            "--mode",
            "json",
            "-p",
            "--tools",
            def.tools,
            "--append-system-prompt",
            def.systemPrompt + TRIVIAL_PING_RULE,
            "--name",
            spawnSessionName(req.cwd, def.name),
        ];
        if (req.sessionId) args.push("--session-id", req.sessionId);
        if (shouldApproveProjectForSpawn(req.cwd)) args.push("--approve");
        // Force cwd confinement: cwd-guard keeps the agent's FILE tools inside the
        // cwd regardless of the server's own PI_CONFINE_CWD. (bash is not confined
        // in-process — see the header note.)
        args.push(...subagentExtArgs(def.tools, def.readOnlyBash, { obs: true, confineCwd: true }));
        const modelArg = spawnModelArg(req.model || def.model);
        if (modelArg) args.push("--model", modelArg);
        args.push(req.text);

        // Standalone run: emit to the dashboard as a ROOT run named after the
        // agent (no PI_OBS_PARENT ⇒ obs-live treats it as root). Strip any
        // inherited dispatch/trace linkage so it never looks like a child of a
        // phantom orchestrator.
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PI_OBS: "1",
            PI_OBS_AGENT: def.name.toLowerCase(),
            PI_SUBAGENT: "1",
            PI_CONFINE_CWD: "1", // confine the agent's file tools to req.cwd
        };
        delete env.PI_OBS_PARENT;
        delete env.PI_OBS_RUN;
        delete env.PI_OBS_DISPATCH_ID;

        let proc;
        try {
            proc = spawnImpl(bin, args, { stdio: ["ignore", "pipe", "pipe"], env, cwd: req.cwd });
        } catch (e) {
            onEvent({ type: "error", error: String((e as Error)?.message || e) });
            reject(e);
            return;
        }

        let buf = "";
        let err = "";
        let sawDone = false;
        const timer = setTimeout(() => proc.kill("SIGTERM"), cfg.timeoutMs);

        if (req.signal) {
            if (req.signal.aborted) proc.kill("SIGTERM");
            else
                req.signal.addEventListener("abort", () => {
                    try {
                        proc.kill("SIGTERM");
                    } catch {}
                });
        }

        proc.stdout?.on("data", (d: Buffer) => {
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
        proc.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
        proc.on("error", (e) => {
            clearTimeout(timer);
            const hint = (e as NodeJS.ErrnoException).code === "ENOENT" ? ` — '${bin}' not on PATH; set PI_OBS_PI_BIN` : "";
            onEvent({ type: "error", error: `spawn ${bin}: ${e.message}${hint}` });
            reject(e);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            const ev = parseChatLine(buf);
            if (ev) {
                if (ev.type === "done") sawDone = true;
                onEvent(ev);
            }
            if (code !== 0 && !sawDone) onEvent({ type: "error", error: `agent exited ${code}${err ? `: ${err.slice(-300)}` : ""}` });
            resolve();
        });
    });
}
