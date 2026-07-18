// obs-reflect.ts — the FAILURE half of agent learning. Agent-authored memory
// (the `remember` tool) only keeps lessons from runs that PASSED. But the most
// valuable lessons come from FAILURES — and on a failed run the agent usually
// never gets to save anything. So when a run fails, this distils durable, per-agent
// lessons from the run's obs digest (its tool errors + anomalies — already
// LLM-ready via formatRunDigest) and writes them straight to each agent's memory.
//
// Gated + best-effort: needs PI_AGENT_MEMORY (memory on), PI_OBS_LLM (the reflector
// model), and an obs sink to read the run from. Never blocks a run.

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parseEventLine, type ObsEvent } from "./obs-events";
import { LineScanner, RunIndexer, type RunSummary } from "./obs-run-index";
import { buildRunDigest, formatRunDigest } from "./obs-explain";
import { llmConfig, type LlmConfig, runPlayground } from "./obs-llm";
import { addLessons, memoryEnabled } from "../utils/workflow/memory";

/** Resolve the obs sink the same way the collector (obs-live) writes it. */
export function reflectSinkPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.PI_OBS_SINK) return resolvePath(env.PI_OBS_SINK.replace(/^~(?=$|\/)/, homedir()));
    return join(homedir(), ".pi", "agent", "obs", "events.jsonl");
}

const MAX_LESSONS = 5;
const MAX_LESSON_CHARS = 280;
const DIGEST_CLAMP = 12_000;

export function reflectSystem(agentNames: string[]): string {
    return (
        `A multi-agent workflow run FAILED. From the run digest below (tool errors,\n` +
        `anomalies, per-agent activity), extract durable, GENERAL lessons that specific\n` +
        `agents should learn so the failure is avoided next time.\n\n` +
        `Agents in this run: ${agentNames.join(", ") || "(unknown)"}.\n\n` +
        `Rules:\n` +
        `- Reply with ONLY a JSON array of 0-${MAX_LESSONS} objects {"agent": "<one of the agents above>", "lesson": "<one imperative general lesson>"}.\n` +
        `- Each lesson is reusable across projects (a habit/check/pitfall), NOT specific to this repo/PR/task, under ${MAX_LESSON_CHARS} chars.\n` +
        `- Attribute each lesson to the agent whose behavior should change (e.g. the one whose tool calls errored).\n` +
        `- Empty array [] if there is no durable, general lesson. No prose, no code fences.`
    );
}

export function reflectInputText(digestText: string): string {
    return digestText.length > DIGEST_CLAMP ? digestText.slice(0, DIGEST_CLAMP) + "\n…(truncated)" : digestText;
}

/** Tolerant parse of the reflector reply into per-agent lessons. Keeps only lessons
 *  attributed to a known agent; trims, drops empty/overlong, dedups, caps. Pure. */
export function parseAgentLessons(raw: string, agentNames: string[]): { agent: string; text: string }[] {
    const known = new Set(agentNames.map((a) => a.toLowerCase()));
    const text = (raw || "").trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr: unknown;
    try {
        arr = JSON.parse(m[0]);
    } catch {
        return [];
    }
    if (!Array.isArray(arr)) return [];
    const out: { agent: string; text: string }[] = [];
    const seen = new Set<string>();
    for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const agent = String((item as any).agent || "").trim().toLowerCase();
        const lesson = String((item as any).lesson || "").replace(/\s+/g, " ").trim();
        if (!known.has(agent) || !lesson || lesson.length > MAX_LESSON_CHARS) continue;
        const key = agent + "|" + lesson.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ agent, text: lesson });
        if (out.length >= MAX_LESSONS) break;
    }
    return out;
}

function indexSink(sink: string): RunIndexer {
    const idx = new RunIndexer();
    const fd = openSync(sink, "r");
    try {
        const CHUNK = 1 << 20;
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
            const n = readSync(fd, buf, 0, CHUNK, idx.scannedTo);
            if (n <= 0) break;
            idx.feed(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }
    return idx;
}

function readRunEvents(sink: string, run: RunSummary): ObsEvent[] {
    const events: ObsEvent[] = [];
    const scanner = new LineScanner((line) => {
        const ev = parseEventLine(line);
        if (ev && ev.runId === run.runId) events.push(ev);
    }, run.startOffset);
    const fd = openSync(sink, "r");
    try {
        const CHUNK = 1 << 20;
        const buf = Buffer.alloc(CHUNK);
        let pos = run.startOffset;
        while (pos < run.endOffset) {
            const n = readSync(fd, buf, 0, Math.min(CHUNK, run.endOffset - pos), pos);
            if (n <= 0) break;
            scanner.push(buf.subarray(0, n));
            pos += n;
        }
    } finally {
        closeSync(fd);
    }
    return events;
}

export type RunPlaygroundFn = (system: string, input: string, cfg: LlmConfig) => Promise<{ output: string }>;

/** Distil per-agent lessons from a FAILED run's obs digest and write them to each
 *  agent's memory. Best-effort + gated. Returns the number of lessons added.
 *  `sink`/`reflect` are injectable for tests. */
export async function reflectFailedRun(
    runId: string | undefined,
    cfg: LlmConfig = llmConfig(),
    opts: { sink?: string; reflect?: RunPlaygroundFn } = {},
): Promise<number> {
    if (!memoryEnabled() || !cfg.enabled || !runId) return 0;
    try {
        const sink = opts.sink || reflectSinkPath();
        if (!existsSync(sink)) return 0;
        const run = indexSink(sink).get(runId);
        if (!run) return 0;
        const digest = buildRunDigest(readRunEvents(sink, run));
        const agentNames = digest.agents.map((a) => a.agent);
        if (!agentNames.length) return 0;
        const digestText = formatRunDigest(digest).join("\n");
        const reflect = opts.reflect || runPlayground;
        const res = await reflect(reflectSystem(agentNames), reflectInputText(digestText), cfg);
        const lessons = parseAgentLessons(res.output, agentNames);
        if (!lessons.length) return 0;
        const byAgent = new Map<string, string[]>();
        for (const l of lessons) {
            const arr = byAgent.get(l.agent) || [];
            arr.push(l.text);
            byAgent.set(l.agent, arr);
        }
        let added = 0;
        for (const [agent, texts] of byAgent) added += addLessons(agent, texts, { runId, source: "reflect" });
        return added;
    } catch {
        return 0;
    }
}
