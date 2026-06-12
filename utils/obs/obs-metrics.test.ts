import { test } from "node:test";
import assert from "node:assert/strict";
import {
    parseSession,
    aggregateRun,
    formatRunReport,
    estTokens,
    parseDuration,
    parseTokenCount,
    parseWorkflowReport,
    aggregateTrends,
    formatTrendReport,
    type TrendRun,
} from "./obs-metrics";

// Build a minimal but realistic pi v3 JSONL session as an array of lines.
function jsonl(...objs: unknown[]): string[] {
    return objs.map((o) => JSON.stringify(o));
}

const T0 = "2026-06-10T19:25:00.000Z";
const T1 = "2026-06-10T19:25:30.000Z";
const T2 = "2026-06-10T19:26:00.000Z";

function assistant(ts: string, opts: any = {}) {
    return {
        type: "message",
        timestamp: ts,
        message: {
            role: "assistant",
            model: opts.model ?? "qwen-max",
            stopReason: opts.stopReason ?? "end_turn",
            usage: {
                input: opts.input ?? 1000,
                output: opts.output ?? 200,
                cacheRead: opts.cacheRead ?? 0,
                cacheWrite: 0,
                totalTokens: (opts.input ?? 1000) + (opts.output ?? 200),
                cost: {
                    input: opts.costIn ?? 0.01,
                    output: opts.costOut ?? 0.002,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: (opts.costIn ?? 0.01) + (opts.costOut ?? 0.002),
                },
            },
            content: (opts.tools ?? []).map((name: string, i: number) => ({
                type: "toolCall",
                id: `tc${i}`,
                name,
                arguments: {},
            })),
        },
    };
}

function toolResult(ts: string, id: string, name: string, text: string, isError = false) {
    return {
        type: "message",
        timestamp: ts,
        message: {
            role: "toolResult",
            toolCallId: id,
            toolName: name,
            isError,
            content: [{ type: "text", text }],
        },
    };
}

test("estTokens approximates ~4 chars/token", () => {
    assert.equal(estTokens(""), 0);
    assert.equal(estTokens("abcd"), 1);
    assert.equal(estTokens("abcde"), 2);
});

test("parseSession totals tokens, cost, turns, tools and duration", () => {
    const lines = jsonl(
        { type: "session", id: "s1", cwd: "/tmp/proj", timestamp: T0 },
        assistant(T0, { tools: ["read", "read"], output: 100, costOut: 0.001 }),
        toolResult(T1, "tc0", "read", "x".repeat(40)),
        assistant(T2, { tools: ["write"], output: 300, costOut: 0.003 }),
    );
    const m = parseSession(lines, { agent: "implementer" });
    assert.equal(m.agent, "implementer");
    assert.equal(m.sessionId, "s1");
    assert.equal(m.cwd, "/tmp/proj");
    assert.equal(m.turns, 2);
    assert.equal(m.toolCalls, 3);
    assert.deepEqual(m.toolBreakdown, { read: 2, write: 1 });
    assert.equal(m.tokens.output, 400);
    assert.ok(Math.abs(m.cost.total - (0.01 + 0.001 + 0.01 + 0.003)) < 1e-9);
    assert.equal(m.durationMs, 60_000);
    assert.equal(m.startedAt, T0);
    assert.equal(m.endedAt, T2);
    assert.ok(m.tps > 0);
});

test("parseSession counts tool errors, model changes and compactions", () => {
    const lines = jsonl(
        { type: "model_change", modelId: "claude-haiku", timestamp: T0 },
        assistant(T0, { tools: ["bash"] }),
        toolResult(T1, "tc0", "bash", "boom", true),
        { type: "branch_summary", timestamp: T2, summary: "compacted" },
    );
    const m = parseSession(lines);
    assert.equal(m.toolErrors, 1);
    assert.equal(m.modelChanges, 1);
    assert.equal(m.compactions, 1);
    assert.ok(m.models.includes("claude-haiku"));
});

test("parseSession accounts for context-prune savings via toolCallId match", () => {
    const lines = jsonl(
        assistant(T0, { tools: ["read"] }),
        toolResult(T0, "tc0", "read", "y".repeat(400)), // ~100 tokens
        {
            type: "custom_message",
            customType: "context-prune-summary",
            timestamp: T1,
            details: { toolCallRefs: [{ shortId: "t1", toolCallId: "tc0" }] },
        },
    );
    const m = parseSession(lines);
    assert.equal(m.pruneEvents, 1);
    assert.equal(m.prunedOutputs, 1);
    assert.equal(m.estPruneTokensReclaimed, 100);
});

test("parseSession window filters out-of-range entries", () => {
    const lines = jsonl(
        assistant("2026-06-10T18:00:00.000Z", { output: 999 }), // before window
        assistant(T1, { output: 50 }),
    );
    const m = parseSession(lines, {
        window: { start: T0, end: T2 },
    });
    assert.equal(m.turns, 1);
    assert.equal(m.tokens.output, 50);
});

test("aggregateRun rolls up totals, wallclock and costliest/slowest", () => {
    const a = parseSession(
        jsonl(
            { type: "session", cwd: "/tmp/proj", timestamp: T0 },
            assistant(T0, { costOut: 0.05, output: 100 }),
            assistant(T1, { costOut: 0.05, output: 100 }),
        ),
        { agent: "planner" },
    );
    const b = parseSession(
        jsonl(
            assistant(T1, { costOut: 0.5, output: 1000 }),
            assistant(T2, { costOut: 0.5, output: 1000 }),
        ),
        { agent: "implementer" },
    );
    const r = aggregateRun([a, b], {
        team: "build",
        phasesTotal: 3,
        phasesDone: 3,
        shipOutcome: "paused",
    });
    assert.equal(r.totals.turns, 4);
    assert.equal(r.costliestAgent?.agent, "implementer");
    assert.equal(r.pipeline.shipOutcome, "paused");
    assert.equal(r.totals.wallclockMs, 60_000); // T0 -> T2
    // agents sorted by start time: planner (T0) before implementer (T1)
    assert.equal(r.agents[0].agent, "planner");
});

test("parseDuration handles m/s combos", () => {
    assert.equal(parseDuration("10m 38s"), 638_000);
    assert.equal(parseDuration("6m18s"), 378_000);
    assert.equal(parseDuration("51s"), 51_000);
    assert.equal(parseDuration("2m"), 120_000);
});

test("parseTokenCount handles k/m suffixes and commas", () => {
    assert.equal(parseTokenCount("472.7k"), 472_700);
    assert.equal(parseTokenCount("11.0k"), 11_000);
    assert.equal(parseTokenCount("590,978"), 590_978);
    assert.equal(parseTokenCount("1.5m"), 1_500_000);
});

test("parseWorkflowReport extracts totals, attempts, ship and phases", () => {
    const report = [
        "# Workflow Report",
        "",
        "**Request:** build a simple todo app",
        "**Outcome:** PAUSED — no GitHub remote.",
        "**Result:** paused-no-remote · verdict UNKNOWN · 0 attempt(s) of 3",
        "**Totals:** 10m 38s wall-clock · 53 tool call(s) · 590,978 tokens (47,677 in / 24,308 out / 518,993 cache) · $0.643",
        "",
        "## Summary of work",
        "- **Scout** (19s, 11.0k tokens, $0.022) — empty dir",
        "- **Implementer** (6m 18s, 472.7k tokens, $0.397) — built it",
        "- **Ship** (1m 3s, 38.3k tokens, $0.049) — SHIP: PAUSED",
    ].join("\n");
    const s = parseWorkflowReport(report);
    assert.equal(s.request, "build a simple todo app");
    assert.equal(s.shipOutcome, "paused");
    assert.equal(s.verdict, "UNKNOWN");
    assert.equal(s.attempts, 0);
    assert.equal(s.attemptsMax, 3);
    assert.equal(s.wallclockMs, 638_000);
    assert.equal(s.toolCalls, 53);
    assert.equal(s.tokens?.total, 590_978);
    assert.equal(s.tokens?.input, 47_677);
    assert.equal(s.tokens?.cache, 518_993);
    assert.equal(s.costUsd, 0.643);
    assert.equal(s.phases.length, 3);
    assert.equal(s.phases[1].name, "Implementer");
    assert.equal(s.phases[1].durationMs, 378_000);
    assert.equal(s.phases[1].tokens, 472_700);
    assert.equal(s.phases[1].costUsd, 0.397);
});

function trendRun(over: Partial<TrendRun> = {}): TrendRun {
    return {
        project: "p",
        startedAt: "2026-06-10T19:25:00.000Z",
        shipOutcome: "shipped",
        passed: true,
        passes: 1,
        maxLoops: 3,
        costUsd: 0.5,
        tokensTotal: 100_000,
        wallclockMs: 600_000,
        phases: [
            { label: "Scout", elapsedMs: 20_000, costUsd: 0.02, attempt: 1 },
            {
                label: "Implementer",
                elapsedMs: 300_000,
                costUsd: 0.4,
                attempt: 1,
            },
        ],
        ...over,
    };
}

test("aggregateTrends rolls up outcomes, rates and per-phase/project trends", () => {
    const runs: TrendRun[] = [
        trendRun({ project: "alpha", shipOutcome: "shipped", passed: true }),
        trendRun({
            project: "alpha",
            shipOutcome: "paused",
            passed: true,
            passes: 2, // looped once
            costUsd: 1.0,
            phases: [
                { label: "Scout", elapsedMs: 10_000, costUsd: 0.01, attempt: 1 },
                {
                    label: "Implementer",
                    elapsedMs: 500_000,
                    costUsd: 0.9,
                    attempt: 2,
                },
            ],
        }),
        trendRun({
            project: "beta",
            shipOutcome: "failed",
            passed: false,
            startedAt: "2026-06-09T10:00:00.000Z",
        }),
    ];
    const t = aggregateTrends(runs);
    assert.equal(t.runs, 3);
    assert.equal(t.ship.shipped, 1);
    assert.equal(t.ship.paused, 1);
    assert.equal(t.ship.failed, 1);
    assert.ok(Math.abs(t.cost.total - (0.5 + 1.0 + 0.5)) < 1e-9);
    assert.ok(Math.abs(t.validatorPassRate - 2 / 3) < 1e-9);
    assert.ok(Math.abs(t.retryRate - 1 / 3) < 1e-9); // one run looped
    // Implementer is slowest on average
    assert.equal(t.slowestPhase?.label, "Implementer");
    assert.equal(t.costliestPhase?.label, "Implementer");
    // date range spans the earliest beta run
    assert.equal(t.firstRun, "2026-06-09T10:00:00.000Z");
    // byProject sorted by total cost: alpha (1.5) before beta (0.5)
    assert.equal(t.byProject[0].project, "alpha");
    assert.equal(t.byProject[0].runs, 2);
    assert.equal(t.byProject[0].shipped, 1);
});

test("formatTrendReport renders key sections without throwing", () => {
    const text = formatTrendReport(aggregateTrends([trendRun()])).join("\n");
    assert.match(text, /Cross-Run Trends/);
    assert.match(text, /By phase/);
    assert.match(text, /By project/);
});

test("formatRunReport renders without throwing and includes key lines", () => {
    const a = parseSession(jsonl(assistant(T0, { tools: ["read"] })), {
        agent: "scout",
    });
    const text = formatRunReport(
        aggregateRun([a], { team: "build", shipOutcome: "shipped" }),
    ).join("\n");
    assert.match(text, /Run Metrics/);
    assert.match(text, /Trifecta/);
    assert.match(text, /scout/);
});
