// Prompt/config registry — turns the per-agent `boot` snapshots (system-prompt
// hash + size, tools, skills, context files) into a versioned history, so you
// can see how an agent's configuration evolved across runs and diff versions.
// Pure: obs-server feeds it the boot + session_start events it has gathered.
import type { ObsEvent } from "./obs-events";

export interface PromptConfig {
    promptHash: string;
    promptChars: number;
    model: string; // from the session's session_start (may be "")
    tools: string[];
    skills: string[];
    contextFiles: string[];
}
export interface PromptVersion extends PromptConfig {
    firstTs: number;
    lastTs: number;
    runs: string[]; // distinct runIds that used this config
    sessions: number; // how many sessions booted with it
}
export interface AgentPrompts {
    agent: string;
    versions: PromptVersion[]; // newest (by lastTs) first
}

function strArr(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function num(v: unknown): number {
    return typeof v === "number" ? v : 0;
}
function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

// A stable signature for a config — two boots with the same signature are the
// same "version". Arrays are sorted so ordering noise doesn't fork a version.
function signature(c: PromptConfig): string {
    return JSON.stringify([
        c.promptHash,
        c.model,
        [...c.tools].sort(),
        [...c.skills].sort(),
        [...c.contextFiles].sort(),
    ]);
}

export function buildPromptRegistry(events: ObsEvent[]): AgentPrompts[] {
    // session → model, from session_start (boot carries no model)
    const sessionModel = new Map<string, string>();
    for (const e of events) {
        if (e.type === "session_start") {
            const m = str((e.payload as Record<string, unknown>)?.model);
            if (m) sessionModel.set(e.sessionId, m);
        }
    }

    // agent → signature → accumulating version
    const byAgent = new Map<string, Map<string, PromptVersion>>();
    for (const e of events) {
        if (e.type !== "boot") continue;
        const p = (e.payload as Record<string, unknown>) || {};
        const cfg: PromptConfig = {
            promptHash: str(p.promptHash),
            promptChars: num(p.promptChars),
            model: sessionModel.get(e.sessionId) || "",
            tools: strArr(p.tools),
            skills: strArr(p.skills),
            contextFiles: strArr(p.contextFiles),
        };
        const sig = signature(cfg);
        let versions = byAgent.get(e.agent);
        if (!versions) {
            versions = new Map();
            byAgent.set(e.agent, versions);
        }
        let v = versions.get(sig);
        if (!v) {
            v = { ...cfg, firstTs: e.ts, lastTs: e.ts, runs: [], sessions: 0 };
            versions.set(sig, v);
        }
        v.firstTs = Math.min(v.firstTs, e.ts);
        v.lastTs = Math.max(v.lastTs, e.ts);
        v.sessions++;
        if (e.runId && !v.runs.includes(e.runId)) v.runs.push(e.runId);
    }

    return [...byAgent.entries()]
        .map(([agent, versions]) => ({
            agent,
            versions: [...versions.values()].sort((a, b) => b.lastTs - a.lastTs),
        }))
        .sort((a, b) => a.agent.localeCompare(b.agent));
}
