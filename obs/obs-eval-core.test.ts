import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateRun,
    overallScore,
    budgetScore,
    levelFor,
    formatCost,
    formatDuration,
    formatEvalReport,
    DEFAULT_EVAL_CONFIG,
    type EvalConfig,
    type EvalRunInput,
} from "./obs-eval-core";

describe("obs-eval-core", () => {
    const cleanRun: EvalRunInput = {
        costUsd: 0.25,
        durationMs: 60_000,
        toolCalls: 10,
        errors: 0,
        runId: "run-test-123",
    };

    it("evaluates a clean, under-budget run as PASS across all evaluators", () => {
        const results = evaluateRun(cleanRun);
        assert.equal(results.length, 4);

        for (const r of results) {
            assert.equal(r.level, "pass");
            assert.equal(r.score, 1);
        }

        const ov = overallScore(results);
        assert.equal(ov.level, "pass");
        assert.equal(ov.score, 1);
    });

    it("evaluates errors with progressive degradation", () => {
        const r1 = evaluateRun({ ...cleanRun, errors: 1 });
        const err1 = r1.find((x) => x.id === "error-free")!;
        assert.equal(err1.level, "warn");
        assert.ok(err1.score < 1 && err1.score >= 0.5);

        const r3 = evaluateRun({ ...cleanRun, errors: 3 });
        const err3 = r3.find((x) => x.id === "error-free")!;
        assert.equal(err3.level, "fail");
        assert.ok(err3.score < 0.5);
    });

    it("evaluates cost budget accurately", () => {
        const cfg: EvalConfig = {
            costBudgetUsd: 1.0,
            maxDurationMs: 600_000,
            maxToolCalls: 50,
        };

        const under = evaluateRun({ ...cleanRun, costUsd: 0.8 }, cfg);
        assert.equal(under.find((x) => x.id === "cost-budget")!.level, "pass");

        const warn = evaluateRun({ ...cleanRun, costUsd: 1.4 }, cfg);
        assert.equal(warn.find((x) => x.id === "cost-budget")!.level, "warn");

        const fail = evaluateRun({ ...cleanRun, costUsd: 2.5 }, cfg);
        assert.equal(fail.find((x) => x.id === "cost-budget")!.level, "fail");
    });

    it("evaluates latency budget accurately", () => {
        const cfg: EvalConfig = {
            costBudgetUsd: 1.0,
            maxDurationMs: 100_000,
            maxToolCalls: 50,
        };

        const under = evaluateRun({ ...cleanRun, durationMs: 50_000 }, cfg);
        assert.equal(under.find((x) => x.id === "latency")!.level, "pass");

        const over = evaluateRun({ ...cleanRun, durationMs: 250_000 }, cfg);
        assert.equal(over.find((x) => x.id === "latency")!.level, "fail");
    });

    it("evaluates tool efficiency budget accurately", () => {
        const cfg: EvalConfig = {
            costBudgetUsd: 1.0,
            maxDurationMs: 100_000,
            maxToolCalls: 20,
        };

        const under = evaluateRun({ ...cleanRun, toolCalls: 15 }, cfg);
        assert.equal(under.find((x) => x.id === "tool-efficiency")!.level, "pass");

        const over = evaluateRun({ ...cleanRun, toolCalls: 45 }, cfg);
        assert.equal(over.find((x) => x.id === "tool-efficiency")!.level, "fail");
    });

    it("calculates budgetScore edge cases", () => {
        assert.equal(budgetScore(10, 0), 1);
        assert.equal(budgetScore(5, 10), 1);
        assert.equal(budgetScore(10, 10), 1);
        assert.equal(budgetScore(15, 10), 0.5);
        assert.equal(budgetScore(25, 10), 0);
    });

    it("maps levelFor thresholds", () => {
        assert.equal(levelFor(1.0), "pass");
        assert.equal(levelFor(0.999), "pass");
        assert.equal(levelFor(0.998), "warn");
        assert.equal(levelFor(0.5), "warn");
        assert.equal(levelFor(0.49), "fail");
        assert.equal(levelFor(0), "fail");
    });

    it("formats costs and durations cleanly", () => {
        assert.equal(formatCost(0), "$0.00");
        assert.equal(formatCost(0.005), "<$0.01");
        assert.equal(formatCost(1.499), "$1.50");

        assert.equal(formatDuration(500), "500ms");
        assert.equal(formatDuration(45_000), "45s");
        assert.equal(formatDuration(125_000), "2m 5s");
    });

    it("formats CLI evaluation report", () => {
        const results = evaluateRun(cleanRun);
        const report = formatEvalReport(cleanRun, results);
        assert.ok(report.includes("Evaluation: PASS"));
        assert.ok(report.includes("Run: run-test-123"));
        assert.ok(report.includes("Error-free"));
        assert.ok(report.includes("Cost budget"));
    });
});
