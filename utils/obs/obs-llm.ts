// Optional LLM enrichment for run digests — turns the deterministic RunDigest
// (utils/obs/obs-explain.ts) into a short narrative + recommendations.
//
// Integration: it shells out to the `pi` CLI (one-shot, `--mode text -p`), so it
// reuses pi's provider auth and the same model strings the workflow uses
// (e.g. anthropic/claude-haiku-4-5) — no separate API key, no SDK dependency.
//
// Design constraints (mirrors the rest of obs-server):
//   - STDLIB ONLY (child_process).
//   - OFF BY DEFAULT. Nothing runs unless PI_OBS_LLM=1; the bundled experience
//     stays local-first, offline, and zero-cost.
//   - Tools/skills/extensions are disabled for the spawn (pure text generation;
//     no file access, no side effects, ephemeral session).
//   - Results are cached by runId + endTs so re-opening a finished run is free.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { RunDigest } from "./obs-explain";
import type { ObsEvent } from "./obs-events";

// The obs-server is a SEPARATE process from pi — pi's extensions load the repo
// `.env` into pi, but the server never saw it. Mirror that loading here so
// PI_OBS_LLM* (and PI_WORKFLOW_MODEL) work the same way for the server. The real
// environment always wins; inline `# comments` after a value are stripped.
export function loadRepoEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
    let text: string;
    try {
        text = readFileSync(path, "utf-8");
    } catch {
        return; // no .env — nothing to load
    }
    for (const raw of text.split("\n")) {
        let line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("export ")) line = line.slice(7).trim();
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (key in env) continue; // real environment wins
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        } else {
            val = val.replace(/\s+#.*$/, "").trim(); // strip an inline comment
        }
        env[key] = val;
    }
}

export interface LlmConfig {
    enabled: boolean;
    /** pi model id, verbatim (e.g. "gateframe/gpt-5-nano"); empty = let pi pick
     *  the primary session's own configured model (no `--model` flag). */
    model: string;
    timeoutMs: number;
}

export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
    return {
        enabled: env.PI_OBS_LLM === "1" || env.PI_OBS_LLM === "true",
        // Prefer an explicit obs model, else the workflow's global model. If
        // neither is set, leave it EMPTY so the pi spawn omits `--model` and
        // inherits the primary agent's own model — never force a hardcoded
        // (third-party-billed) default the user didn't ask for.
        model: (env.PI_OBS_LLM_MODEL || env.PI_WORKFLOW_MODEL || "").trim(),
        timeoutMs: Number(env.PI_OBS_LLM_TIMEOUT_MS) || 60_000,
    };
}

export interface RunExplanation {
    narrative: string;
    recommendations: string[];
    model: string;
    ts: number;
    cached?: boolean;
}

const SYSTEM =
    "You are an observability assistant. An engineer is reviewing a single AI-agent run. " +
    "Summarize what happened in 2-4 plain sentences and surface anything worth acting on. " +
    "Be concrete and specific. Base everything strictly on the data provided — never invent " +
    "agents, tools, numbers, or causes. If nothing is wrong, say so briefly.\n" +
    'Respond with ONLY a JSON object: {"narrative": string, "recommendations": string[]} ' +
    "(0-3 short, concrete, actionable items; empty when the run is clean). No prose outside the JSON, no code fences.";

function fmtMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m${String(s % 60).padStart(2, "0")}s`;
}
function fmtTok(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Render the digest + a bounded slice of notable events into the prompt body.
 *  Pure and bounded, so it's cheap to unit-test and never blows the context. */
export function compactRun(digest: RunDigest, events: ObsEvent[]): string {
    const L: string[] = [];
    L.push(`run ${digest.runId} · project ${basename(digest.cwd || "—")} · wall ${fmtMs(digest.wallMs)}`);
    const t = digest.totals;
    L.push(
        `totals: $${t.costUsd.toFixed(4)} · ${fmtTok(t.tokens.total)} tok · ${t.turns} turns · ` +
            `${t.toolCalls} tool calls · ${t.toolErrors} tool errors · ${t.providerErrors} provider errors · ` +
            `${t.retries} retries · ${t.compactions} compactions`,
    );
    if (digest.models.length) L.push(`models: ${digest.models.join(", ")}`);

    if (digest.agents.length) {
        L.push("agents:");
        for (const a of digest.agents.slice(0, 8)) {
            const ctx = a.maxContextPct != null ? ` · ctx ${Math.round(a.maxContextPct)}%` : "";
            L.push(
                `  - ${a.agent}${a.model ? ` (${a.model})` : ""}: ${a.turns} turns · $${a.costUsd.toFixed(4)} · ` +
                    `${fmtTok(a.tokens)} tok · ${a.toolCalls} tools · ${a.errors + a.toolErrors} errors${ctx}`,
            );
        }
    }
    if (digest.tools.length) {
        const top = [...digest.tools].sort((x, y) => y.totalMs - x.totalMs).slice(0, 6);
        L.push("tools: " + top.map((x) => `${x.tool}×${x.calls} (${fmtMs(x.totalMs)}${x.errors ? `, ${x.errors} err` : ""})`).join(", "));
    }
    if (digest.anomalies.length) {
        L.push("anomalies:");
        for (const an of digest.anomalies.slice(0, 12)) {
            L.push(`  - [${an.kind}]${an.agent ? ` ${an.agent}:` : ""} ${an.detail}`);
        }
    } else {
        L.push("anomalies: none flagged");
    }

    const notable = events
        .filter(
            (e) =>
                e.type === "error" ||
                e.type === "dispatch_start" ||
                e.type === "dispatch_retry" ||
                (e.type === "tool_end" && (e.payload as Record<string, unknown>)?.isError) ||
                e.type === "verdict",
        )
        .slice(-12);
    if (notable.length) {
        L.push("notable events:");
        for (const e of notable) {
            const p = e.payload as Record<string, unknown>;
            const bit =
                e.type === "tool_end"
                    ? `${p.tool || p.toolName || "tool"} error: ${String(p.summary || "").slice(0, 120)}`
                    : e.type === "dispatch_start"
                      ? `dispatch ${p.agent || ""} ← ${String(p.task || "").slice(0, 100)}`
                      : e.type === "verdict"
                        ? `verdict ${p.status || ""}${p.note ? `: ${String(p.note).slice(0, 80)}` : ""}`
                        : String(p.message || p.reason || p.summary || e.type).slice(0, 120);
            L.push(`  - ${e.agent}: ${bit}`);
        }
    }
    return L.join("\n");
}

/** One-shot pi text completion: `pi --mode text -p` with tools/skills/extensions
 *  off and an ephemeral session. Resolves the assistant's stdout text. */
export type RunPi = (model: string, system: string, prompt: string, timeoutMs: number) => Promise<string>;

const runPiText: RunPi = (model, system, prompt, timeoutMs) =>
    new Promise((resolve, reject) => {
        const args = ["--mode", "text", "-p", "--no-tools", "--no-session", "--no-skills", "--no-extensions"];
        if (model) args.push("--model", model);
        args.push("--append-system-prompt", system, prompt);

        const proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            proc.kill("SIGTERM");
            reject(new Error(`pi timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
        proc.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
        proc.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(`spawn pi: ${e.message}`));
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`pi exited ${code}${err ? `: ${err.slice(-300)}` : ""}`));
        });
    });

const cache = new Map<string, RunExplanation>(); // runId#endTs -> explanation

/** Summarize a run via pi, caching by runId+endTs. Throws on spawn/timeout error
 *  (the route maps that to an HTTP error). */
export async function explainRun(
    runId: string,
    digest: RunDigest,
    events: ObsEvent[],
    cfg: LlmConfig = llmConfig(),
    runImpl: RunPi = runPiText,
): Promise<RunExplanation> {
    const key = `${runId}#${digest.endTs}`;
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };

    const stdout = await runImpl(cfg.model, SYSTEM, compactRun(digest, events), cfg.timeoutMs);
    const parsed = parseResult(stdout);
    const out: RunExplanation = {
        narrative: parsed.narrative,
        recommendations: parsed.recommendations,
        model: cfg.model || "session default",
        ts: Date.now(),
    };
    cache.set(key, out);
    return out;
}

// ── per-block summary (I/O Input/Output) ──

const SUM_SYSTEM =
    "You summarize one piece of an AI-agent trace for an engineer scanning it. " +
    "Reply with ONE short, plain sentence stating what the content is or does — e.g. " +
    '"Fetches Jira ticket TTP-10962\'s key fields via the atlassian CLI." ' +
    "No preamble, no markdown, no quotes, no trailing period unless natural.";

const textCache = new Map<string, string>(); // kind:hash -> summary

export interface TextSummary {
    summary: string;
    cached?: boolean;
}

/** Summarize an arbitrary chunk (a tool's input args or output result) into one
 *  sentence via pi, cached by kind + content hash. */
export async function summarizeText(
    text: string,
    kind: string,
    cfg: LlmConfig = llmConfig(),
    runImpl: RunPi = runPiText,
): Promise<TextSummary> {
    const key = `${kind}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
    const hit = textCache.get(key);
    if (hit !== undefined) return { summary: hit, cached: true };
    const prompt = `This is the ${kind} of a tool call. Summarize it in one sentence.\n\n${text.slice(0, 6000)}`;
    const out = (await runImpl(cfg.model, SUM_SYSTEM, prompt, cfg.timeoutMs)).trim();
    textCache.set(key, out);
    return { summary: out };
}

// ── LLM-as-judge (run quality scoring) ──
// A strict evaluator that scores a finished run on a small rubric and returns
// numeric scores (0-100) + reasons. Same opt-in + caching model as explainRun;
// the client renders it alongside the deterministic heuristic evaluators.

export interface JudgeCriterion {
    name: string;
    score: number; // 0..100
    reason: string;
}
export interface RunJudgement {
    score: number; // 0..100 overall
    reason: string;
    criteria: JudgeCriterion[];
    model: string;
    ts: number;
    cached?: boolean;
}

const JUDGE_SYSTEM =
    "You are a strict evaluator (LLM-as-judge) scoring a single AI-agent run for an engineer. " +
    "Assess it on exactly three criteria, each scored 0-100: " +
    "goal_completion (did the agent accomplish the task it was given?), " +
    "efficiency (was the cost, turn count, and tool use reasonable for the work done?), and " +
    "error_handling (did it avoid errors, or recover well from the ones it hit?). " +
    "Base everything strictly on the data provided — never invent agents, tools, numbers, or causes. " +
    "Be concise and concrete; one short sentence per reason.\n" +
    'Respond with ONLY a JSON object: {"score": number, "reason": string, ' +
    '"criteria": [{"name": string, "score": number, "reason": string}]} — ' +
    "score is the overall 0-100, each criterion score is 0-100. No prose outside the JSON, no code fences.";

function clampScore(v: unknown): number {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

/** Tolerant parse of the judge's reply — bare/fenced/embedded JSON; the overall
 *  score falls back to the mean of the criteria when absent. */
export function parseJudgement(raw: string): { score: number; reason: string; criteria: JudgeCriterion[] } {
    const text = raw.trim();
    const candidate = extractJsonObject(text) ?? text;
    try {
        const o = JSON.parse(candidate) as { score?: unknown; reason?: unknown; criteria?: unknown };
        const criteria: JudgeCriterion[] = Array.isArray(o.criteria)
            ? o.criteria
                  .map((c) => {
                      const cc = c as { name?: unknown; score?: unknown; reason?: unknown };
                      return {
                          name: typeof cc.name === "string" ? cc.name : "",
                          score: clampScore(cc.score),
                          reason: typeof cc.reason === "string" ? cc.reason : "",
                      };
                  })
                  .filter((c) => c.name)
            : [];
        const overall =
            typeof o.score === "number"
                ? clampScore(o.score)
                : criteria.length
                  ? Math.round(criteria.reduce((s, c) => s + c.score, 0) / criteria.length)
                  : 0;
        return { score: overall, reason: typeof o.reason === "string" ? o.reason : text.slice(0, 200), criteria };
    } catch {
        return { score: 0, reason: text || "(no judgement returned)", criteria: [] };
    }
}

const judgeCache = new Map<string, RunJudgement>(); // runId#endTs -> judgement

/** Score a run via pi (LLM-as-judge), caching by runId+endTs. Throws on
 *  spawn/timeout error (the route maps that to a 200 with `error`). */
export async function judgeRun(
    runId: string,
    digest: RunDigest,
    events: ObsEvent[],
    cfg: LlmConfig = llmConfig(),
    runImpl: RunPi = runPiText,
): Promise<RunJudgement> {
    const key = `${runId}#${digest.endTs}`;
    const hit = judgeCache.get(key);
    if (hit) return { ...hit, cached: true };

    const stdout = await runImpl(cfg.model, JUDGE_SYSTEM, compactRun(digest, events), cfg.timeoutMs);
    const parsed = parseJudgement(stdout);
    const out: RunJudgement = { ...parsed, model: cfg.model || "session default", ts: Date.now() };
    judgeCache.set(key, out);
    return out;
}

// ── prompt playground (safe sandbox) ──
// A one-shot completion for iterating on prompt wording: runs pi with tools,
// session, skills, and extensions OFF, so there are no side effects — it's a
// pure text sandbox, NOT an agent re-execution.
export interface PlaygroundResult {
    output: string;
    model: string;
    ts: number;
}
export async function runPlayground(
    system: string,
    input: string,
    cfg: LlmConfig = llmConfig(),
    runImpl: RunPi = runPiText,
): Promise<PlaygroundResult> {
    const sys = system.trim() || "You are a helpful assistant.";
    const out = (await runImpl(cfg.model, sys, input, cfg.timeoutMs)).trim();
    return { output: out, model: cfg.model || "session default", ts: Date.now() };
}

function extractJsonObject(t: string): string | null {
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim();
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    return i >= 0 && j > i ? t.slice(i, j + 1) : null;
}

/** Tolerant parse of pi's text reply — handles a bare JSON object, a fenced
 *  block, or JSON embedded in prose; falls back to the raw text as narrative. */
export function parseResult(raw: string): { narrative: string; recommendations: string[] } {
    const text = raw.trim();
    const candidate = extractJsonObject(text) ?? text;
    try {
        const o = JSON.parse(candidate) as { narrative?: unknown; recommendations?: unknown };
        return {
            narrative: typeof o.narrative === "string" ? o.narrative : text,
            recommendations: Array.isArray(o.recommendations) ? o.recommendations.filter((x): x is string => typeof x === "string") : [],
        };
    } catch {
        return { narrative: text || "(no summary returned)", recommendations: [] };
    }
}
