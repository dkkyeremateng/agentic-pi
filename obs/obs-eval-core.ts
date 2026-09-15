// ABOUTME: Pure evaluation engine for agent runs — heuristic evaluators that
// ABOUTME: score a run against cost, latency, error count, and tool call budgets.
// ABOUTME: Shared across the CLI analyzer (obs-cli.ts), test suites, and backend.

export type EvalLevel = "pass" | "warn" | "fail";

export interface EvalConfig {
    costBudgetUsd: number;
    maxDurationMs: number;
    maxToolCalls: number;
}

export const DEFAULT_EVAL_CONFIG: EvalConfig = {
    costBudgetUsd: 1.0,
    maxDurationMs: 10 * 60_000,
    maxToolCalls: 60,
};

export interface EvalResult {
    id: string; // evaluator id, stable across runs
    label: string;
    score: number; // 0..1
    level: EvalLevel; // derived from score thresholds
    value: string; // measured value, human-readable
    reason: string; // one-line explanation
}

export interface EvalRunInput {
    costUsd: number;
    durationMs: number;
    toolCalls: number;
    errors: number;
    runId?: string;
    project?: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function levelFor(score: number): EvalLevel {
    return score >= 0.999 ? "pass" : score >= 0.5 ? "warn" : "fail";
}

/** A budget check: at/under budget = 1; degrades to 0 at 2x budget. */
export function budgetScore(value: number, budget: number): number {
    if (budget <= 0) return 1;
    const ratio = value / budget;
    return ratio <= 1 ? 1 : clamp01(2 - ratio);
}

export function overPct(value: number, budget: number): number {
    return budget > 0 ? Math.round((value / budget - 1) * 100) : 0;
}

export function formatCost(usd: number): string {
    if (usd <= 0) return "$0.00";
    if (usd < 0.01) return `<$0.01`;
    return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Run heuristic evaluators over a run's measurable metrics.
 */
export function evaluateRun(
    run: EvalRunInput,
    cfg: EvalConfig = DEFAULT_EVAL_CONFIG,
): EvalResult[] {
    const durMs = Math.max(0, run.durationMs ?? 0);
    const tools = Math.max(0, run.toolCalls ?? 0);
    const errs = Math.max(0, run.errors ?? 0);
    const cost = Math.max(0, run.costUsd ?? 0);

    const errScore = errs === 0 ? 1 : clamp01(1 - errs * 0.34);
    const costScore = budgetScore(cost, cfg.costBudgetUsd);
    const latScore = budgetScore(durMs, cfg.maxDurationMs);
    const toolScore = budgetScore(tools, cfg.maxToolCalls);

    return [
        {
            id: "error-free",
            label: "Error-free",
            score: errScore,
            level: levelFor(errScore),
            value: errs === 0 ? "0 errors" : `${errs} error${errs === 1 ? "" : "s"}`,
            reason:
                errs === 0
                    ? "No errors or failed tools."
                    : `${errs} error${errs === 1 ? "" : "s"} during the run.`,
        },
        {
            id: "cost-budget",
            label: "Cost budget",
            score: costScore,
            level: levelFor(costScore),
            value: `${formatCost(cost)} / ${formatCost(cfg.costBudgetUsd)}`,
            reason:
                cost <= cfg.costBudgetUsd
                    ? "Within the cost budget."
                    : `Over budget by ${overPct(cost, cfg.costBudgetUsd)}%.`,
        },
        {
            id: "latency",
            label: "Latency",
            score: latScore,
            level: levelFor(latScore),
            value: formatDuration(durMs),
            reason:
                durMs <= cfg.maxDurationMs
                    ? `Finished within ${formatDuration(cfg.maxDurationMs)}.`
                    : `${overPct(durMs, cfg.maxDurationMs)}% over the ${formatDuration(cfg.maxDurationMs)} budget.`,
        },
        {
            id: "tool-efficiency",
            label: "Tool efficiency",
            score: toolScore,
            level: levelFor(toolScore),
            value: `${tools} tool call${tools === 1 ? "" : "s"}`,
            reason:
                tools <= cfg.maxToolCalls
                    ? `Under the ${cfg.maxToolCalls}-call budget.`
                    : `${tools} calls — over the ${cfg.maxToolCalls}-call budget.`,
        },
    ];
}

/**
 * Aggregate evaluator score (mean of individual evaluator scores) + overall level.
 */
export function overallScore(results: EvalResult[]): {
    score: number;
    level: EvalLevel;
} {
    if (!results.length) return { score: 1, level: "pass" };
    const score = results.reduce((s, r) => s + r.score, 0) / results.length;
    return { score, level: levelFor(score) };
}

/**
 * Format evaluation results as a human-readable CLI report.
 */
export function formatEvalReport(
    run: EvalRunInput,
    results: EvalResult[],
    cfg: EvalConfig = DEFAULT_EVAL_CONFIG,
): string {
    const ov = overallScore(results);
    const badge =
        ov.level === "pass" ? "PASS" : ov.level === "warn" ? "WARN" : "FAIL";

    const lines: string[] = [
        `Evaluation: ${badge} (score: ${(ov.score * 100).toFixed(0)}/100)`,
    ];
    if (run.runId) lines.push(`Run: ${run.runId}`);
    lines.push("");

    for (const r of results) {
        const lvl = r.level.toUpperCase().padEnd(4);
        const sc = `[${(r.score * 100).toFixed(0)}%]`.padStart(6);
        lines.push(`  ${lvl} ${sc} ${r.label.padEnd(16)} ${r.value} — ${r.reason}`);
    }

    return lines.join("\n");
}
