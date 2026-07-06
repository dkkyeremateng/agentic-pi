import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    validatePlan,
    contextBundle,
    contextBundleForPhase,
    clampSummary,
    clampOutput,
    reviewTask,
    projectSessionHash,
    parsePlanPhases,
    parseProgressLedger,
    buildReviewChecklist,
    REVIEW_CHECKLIST,
    inferWorkflowTeam,
    buildPhaseMap,
    buildWorkflowMetrics,
    spawnModelArg,
    spawnTaskArg,
    appendLiveLog,
    failPhase,
    renderTemplate,
    tokenNote,
    formatCostUsd,
    totalTokens,
    runAgentWithFallback,
    transientRetryLimit,
    mkPhase,
    freshPhases,
    dispatchEnv,
    stripInheritedSecrets,
    renderWorkflowFooter,
    formatContextUsage,
    stickyContextUsage,
    parseAgentFile,
    subagentExtArgs,
    shouldApproveProjectForSpawn,
    spawnSessionName,
    loadSkills,
    sessionLabel,
    resolveAgentModel,
    agentModelEnvVar,
    contextWindowForModel,
    parseAgentEnvConfig,
    setModelOverride,
    clearModelOverride,
    clearAllModelOverrides,
    getModelOverride,
    getModelOverrides,
    type AgentDef,
    type RunArtifacts,
    type PhaseState,
} from "./workflow-core";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Run with: npx tsx --test workflow-core.test.ts

// Helper: create a minimal PhaseState for testing (uses the shared mkPhase
// under the hood but assigns the agent field as the label for convenience
// in tests that don't care about the label/agent distinction).
function testPhase(agent: string): PhaseState {
    return mkPhase(agent, agent);
}

// ── validatePlan ─────────────────────────────────

describe("validatePlan", () => {
    it("accepts a well-structured plan", () => {
        const plan = [
            "## Phase 1: Setup",
            "Create the project scaffolding.",
            "",
            "## Phase 2: Implement",
            "Build the core feature.",
            "",
            "## Acceptance Criteria",
            "- Feature works end-to-end",
            "",
            "## Critical Files",
            "- src/main.ts",
            "- src/utils.ts",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, true);
        assert.deepEqual(result.missing, []);
    });

    it("accepts a plan with file paths in bullet points", () => {
        const plan = [
            "## Phase 1: Build",
            "- src/index.ts — entry point",
            "- src/lib.ts — core logic",
            "",
            "## Acceptance Criteria",
            "- All tests pass",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, true);
    });

    it("accepts a plan with file action patterns", () => {
        const plan = [
            "## Phase 1: Changes",
            "Modify src/server.ts to add the endpoint.",
            "",
            "## Acceptance Criteria",
            "- Endpoint responds correctly",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, true);
    });

    it("rejects a plan with no phase headings", () => {
        const plan = [
            "Here is my plan:",
            "First we do this, then we do that.",
            "",
            "## Acceptance Criteria",
            "- It works",
            "",
            "## Critical Files",
            "- src/main.ts",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, false);
        assert.ok(
            result.missing.some((m) => m.includes("phase")),
            `Expected phase missing, got: ${JSON.stringify(result.missing)}`,
        );
    });

    it("rejects a plan with no acceptance criteria heading", () => {
        const plan = [
            "## Phase 1: Build",
            "Build the thing.",
            "",
            "## Critical Files",
            "- src/main.ts",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, false);
        assert.ok(
            result.missing.some((m) => m.includes("Acceptance")),
            `Expected acceptance criteria missing, got: ${JSON.stringify(result.missing)}`,
        );
    });

    it("rejects a plan with no file-level specificity", () => {
        const plan = [
            "## Phase 1: Build",
            "Build the thing.",
            "",
            "## Acceptance Criteria",
            "- It works",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, false);
        assert.ok(
            result.missing.some((m) => m.includes("file-level")),
            `Expected file-level missing, got: ${JSON.stringify(result.missing)}`,
        );
    });

    it("does not accept prose mentioning 'phase' without a heading", () => {
        const plan = [
            "This phase of the project will be handled by the implementer.",
            "The acceptance criteria are that it works.",
            "We will modify several files.",
        ].join("\n");
        const result = validatePlan(plan);
        assert.equal(result.ok, false);
    });
});

// ── contextBundle ────────────────────────────────

describe("contextBundle", () => {
    it("returns empty string when no artifacts are set", () => {
        assert.equal(contextBundle({}), "");
    });

    it("returns empty string when all artifacts are undefined", () => {
        const a: RunArtifacts = {
            recon: undefined,
            plan: undefined,
            review: undefined,
        };
        assert.equal(contextBundle(a), "");
    });

    it("includes only the artifacts that are present", () => {
        const a: RunArtifacts = {
            recon: "Scout found X",
            plan: "Plan says Y",
        };
        const result = contextBundle(a);
        assert.ok(result.includes("Shared run context"));
        assert.ok(result.includes("Reconnaissance (scout)"));
        assert.ok(result.includes("Scout found X"));
        assert.ok(result.includes("Approved plan (planner)"));
        assert.ok(result.includes("Plan says Y"));
        assert.ok(!result.includes("Review"));
        assert.ok(!result.includes("Implementation summary"));
    });

    it("includes all artifacts when all are set", () => {
        const a: RunArtifacts = {
            recon: "recon",
            plan: "plan",
            review: "review",
            implSummary: "impl",
        };
        const result = contextBundle(a);
        assert.ok(result.includes("Reconnaissance"));
        assert.ok(result.includes("Approved plan"));
        assert.ok(result.includes("Review"));
        assert.ok(result.includes("Implementation summary"));
    });

    it("truncates artifacts longer than 3000 chars", () => {
        const longBody = "x".repeat(5000);
        const a: RunArtifacts = { recon: longBody };
        const result = contextBundle(a);
        // The truncated body should be ≤3000 chars + "..."
        const reconSection = result.split("### Reconnaissance (scout)")[1];
        assert.ok(
            reconSection.length < 5100,
            `Section too long: ${reconSection.length}`,
        );
        assert.ok(result.includes("..."), "Expected truncation marker");
    });

    it("skips whitespace-only artifacts", () => {
        const a: RunArtifacts = { recon: "   \n\n  " };
        assert.equal(contextBundle(a), "");
    });
});

// ── buildPhaseMap ────────────────────────────────

describe("buildPhaseMap", () => {
    it("correctly maps phases by agent name", () => {
        const phases: PhaseState[] = [
            testPhase("scout"),
            testPhase("planner"),
            testPhase("refiner"),
            testPhase("implementer"),
            testPhase("reviewer"),
            testPhase("validator"),
            testPhase("shipper"),
        ];
        const pm = buildPhaseMap(phases);
        assert.equal(pm.scout?.agent, "scout");
        assert.equal(pm.planner?.agent, "planner");
        assert.equal(pm.refiner?.agent, "refiner");
        assert.equal(pm.reviewer?.agent, "reviewer");
        assert.equal(pm.implementer?.agent, "implementer");
        assert.equal(pm.validator?.agent, "validator");
        assert.equal(pm.shipper?.agent, "shipper");
    });

    it("returns null for any phase the team omits", () => {
        const phases: PhaseState[] = [
            testPhase("planner"),
            testPhase("reviewer"),
        ];
        const pm = buildPhaseMap(phases);
        assert.equal(pm.scout, null);
        assert.equal(pm.implementer, null);
        assert.equal(pm.shipper, null);
        assert.equal(pm.planner?.agent, "planner");
    });
});

// ── failPhase ────────────────────────────────────

describe("failPhase", () => {
    it("returns error status with phase name and output", () => {
        const result = failPhase("Planning", "Something went wrong");
        assert.equal(result.status, "error");
        assert.ok(result.report.includes("Planning"));
        assert.ok(result.report.includes("Something went wrong"));
    });

    it("includes the output verbatim", () => {
        const output = "Error: missing dependency foo-bar";
        const result = failPhase("Implementation", output);
        assert.ok(result.report.includes(output));
    });
});

// ── renderTemplate ───────────────────────────────

describe("renderTemplate", () => {
    it("replaces {{key}} placeholders with values", () => {
        const result = renderTemplate("Hello {{name}}, welcome to {{place}}!", {
            name: "Alice",
            place: "Wonderland",
        });
        assert.equal(result, "Hello Alice, welcome to Wonderland!");
    });

    it("leaves unreplaced placeholders intact", () => {
        const result = renderTemplate(
            "Hello {{name}}, your {{item}} is ready.",
            {
                name: "Bob",
            },
        );
        assert.equal(result, "Hello Bob, your {{item}} is ready.");
    });

    it("returns the template unchanged when vars is empty", () => {
        const template = "No {{vars}} here";
        assert.equal(renderTemplate(template, {}), template);
    });

    it("handles templates with no placeholders", () => {
        const template = "Plain text with no placeholders.";
        assert.equal(renderTemplate(template, { foo: "bar" }), template);
    });

    it("replaces multiple occurrences of the same key", () => {
        const result = renderTemplate("{{x}} and {{x}} again", { x: "hello" });
        assert.equal(result, "hello and hello again");
    });
});

// ── tokenNote ──────────────────────────────────

describe("tokenNote", () => {
    it("returns empty string when tokens is undefined", () => {
        const phase = testPhase("planner");
        assert.equal(tokenNote(phase), "");
    });

    it("returns empty string when tokens are zero", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 0, output: 0, contextWindow: 200000 };
        assert.equal(tokenNote(phase), "");
    });

    it("formats small token counts without k suffix", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 500, output: 300, contextWindow: 200000 };
        assert.equal(tokenNote(phase), ", 800 tokens, $0.00");
    });

    it("formats large token counts with k suffix", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 10000, output: 2340, contextWindow: 200000 };
        assert.equal(tokenNote(phase), ", 12.3k tokens, $0.00");
    });

    it("formats exactly 1000 tokens with k suffix", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 700, output: 300, contextWindow: 200000 };
        assert.equal(tokenNote(phase), ", 1.0k tokens, $0.00");
    });

    it("shows cost when a priced model reported one", () => {
        const phase = testPhase("planner");
        phase.tokens = {
            input: 700,
            output: 300,
            contextWindow: 200000,
            costUsd: 0.0123,
        };
        assert.equal(tokenNote(phase), ", 1.0k tokens, $0.012");
    });

    it("shows $0.00 when cost is zero/absent", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 700, output: 300, contextWindow: 200000 };
        assert.equal(tokenNote(phase), ", 1.0k tokens, $0.00");
        phase.tokens.costUsd = 0;
        assert.equal(tokenNote(phase), ", 1.0k tokens, $0.00");
    });

    it("counts cache read/write tokens too (matches the cost basis)", () => {
        const phase = testPhase("planner");
        phase.tokens = {
            input: 500,
            output: 300,
            cacheRead: 1000,
            cacheWrite: 200,
            contextWindow: 200000,
            costUsd: 0.0123,
        };
        // 500 + 300 + 1000 + 200 = 2000
        assert.equal(tokenNote(phase), ", 2.0k tokens, $0.012");
    });
});

describe("totalTokens", () => {
    it("sums input + output + cache read/write", () => {
        assert.equal(
            totalTokens({
                input: 500,
                output: 300,
                cacheRead: 1000,
                cacheWrite: 200,
                contextWindow: 0,
            }),
            2000,
        );
    });
    it("treats missing cache fields as 0", () => {
        assert.equal(totalTokens({ input: 5, output: 7, contextWindow: 0 }), 12);
    });
    it("is undefined-safe", () => {
        assert.equal(totalTokens(undefined), 0);
    });
});

describe("formatCostUsd", () => {
    it("returns $0.00 for zero/undefined/negative", () => {
        assert.equal(formatCostUsd(0), "$0.00");
        assert.equal(formatCostUsd(undefined), "$0.00");
        assert.equal(formatCostUsd(-1), "$0.00");
    });
    it("uses 4 decimals for sub-cent costs", () => {
        assert.equal(formatCostUsd(0.0003), "$0.0003");
    });
    it("uses 3 decimals for sub-dollar costs", () => {
        assert.equal(formatCostUsd(0.012), "$0.012");
    });
    it("uses 2 decimals for dollar-plus costs", () => {
        assert.equal(formatCostUsd(1.5), "$1.50");
    });
});

// ── mkPhase ──────────────────────────────────────

describe("mkPhase", () => {
    it("creates a phase with the given label and agent", () => {
        const phase = mkPhase("Plan", "planner");
        assert.equal(phase.label, "Plan");
        assert.equal(phase.agent, "planner");
    });

    it("initializes all counters to zero/false/empty", () => {
        const phase = mkPhase("Test", "tester");
        assert.equal(phase.status, "pending");
        assert.equal(phase.elapsed, 0);
        assert.equal(phase.note, "");
        assert.equal(phase.log, "");
        assert.equal(phase.droppedLines, 0);
        assert.equal(phase.toolCount, 0);
        assert.equal(phase.contextPct, 0);
        assert.equal(phase.attempt, 0);
        assert.equal(phase.modelFallback, false);
    });

    it("does not set tokens or activeModel", () => {
        const phase = mkPhase("X", "y");
        assert.equal(phase.tokens, undefined);
        assert.equal(phase.activeModel, undefined);
    });
});

// ── freshPhases ──────────────────────────────────

describe("freshPhases", () => {
    const FULL = [
        "scout",
        "planner",
        "refiner",
        "implementer",
        "reviewer",
        "validator",
        "shipper",
    ];

    it("builds the full pipeline from a full roster", () => {
        const phases = freshPhases(FULL);
        assert.deepEqual(phases.map((p) => p.agent), FULL);
    });

    it("places refiner between planner and implementer", () => {
        const phases = freshPhases(["implementer", "refiner", "planner"]);
        assert.deepEqual(phases.map((p) => p.agent), [
            "planner",
            "refiner",
            "implementer",
        ]);
    });

    it("runs only the roster's members, in canonical order", () => {
        // Roster given out of order — output is still canonical order.
        const phases = freshPhases(["validator", "implementer", "reviewer"]);
        assert.deepEqual(phases.map((p) => p.agent), [
            "implementer",
            "reviewer",
            "validator",
        ]);
    });

    it("supports a planner+reviewer team", () => {
        const phases = freshPhases(["planner", "reviewer"]);
        assert.deepEqual(phases.map((p) => p.agent), ["planner", "reviewer"]);
    });

    it("ignores non-pipeline members (e.g. seeker)", () => {
        const phases = freshPhases(["seeker", "validator"]);
        assert.deepEqual(phases.map((p) => p.agent), ["validator"]);
    });

    it("is case-insensitive on member names", () => {
        const phases = freshPhases(["Planner", "IMPLEMENTER"]);
        assert.deepEqual(phases.map((p) => p.agent), [
            "planner",
            "implementer",
        ]);
    });

    it("all phases start as pending", () => {
        const phases = freshPhases(FULL);
        for (const p of phases) {
            assert.equal(p.status, "pending", `${p.agent} should be pending`);
        }
    });

    it("labels match the phase purpose", () => {
        const phases = freshPhases(FULL);
        assert.equal(phases[0].label, "Scout");
        assert.equal(phases[1].label, "Plan");
        assert.equal(phases[2].label, "Refine");
        assert.equal(phases[3].label, "Implement");
        assert.equal(phases[4].label, "Review");
        assert.equal(phases[5].label, "Validate");
        assert.equal(phases[6].label, "Ship");
        assert.equal(phases[6].agent, "shipper");
    });
});

// ── contextBundleForPhase ────────────────────────

describe("contextBundleForPhase", () => {
    const fullArtifacts: RunArtifacts = {
        recon: "Scout findings",
        plan: "The plan",
        review: "Review feedback",
        implSummary: "Implementation done",
    };

    it("scout gets no artifacts (read-only recon pass)", () => {
        const bundle = contextBundleForPhase("scout", fullArtifacts);
        // Scout whitelist is ["recon"] but scout doesn't consume prior artifacts.
        // The bundle should only include recon if it's in the whitelist.
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan"));
        assert.ok(!bundle.includes("Review feedback"));
    });

    it("planner gets only recon", () => {
        const bundle = contextBundleForPhase("planner", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan"));
        assert.ok(!bundle.includes("Review feedback"));
        assert.ok(!bundle.includes("Implementation"));
    });

    it("refiner gets an empty bundle (reads the plan from disk; recon threaded inline by refineTask)", () => {
        const bundle = contextBundleForPhase("refiner", fullArtifacts);
        // The refiner reads .agent/plan.md directly and refineTask threads the
        // recon, so the bundle must add nothing — otherwise recon is duplicated.
        assert.equal(bundle, "");
    });

    it("implementer gets recon (it writes code across the codebase), not plan/review", () => {
        const bundle = contextBundleForPhase("implementer", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan")); // read from .agent/plan.md by the implementer
        assert.ok(!bundle.includes("Review feedback"));
        assert.ok(!bundle.includes("Implementation done"));
    });

    it("reviewer gets an empty bundle (plan + implSummary inline; recon redundant)", () => {
        const bundle = contextBundleForPhase("reviewer", fullArtifacts);
        assert.equal(bundle, "");
    });

    it("validator gets an empty bundle (plan + implSummary inline; recon redundant)", () => {
        const bundle = contextBundleForPhase("validator", fullArtifacts);
        assert.equal(bundle, "");
    });

    it("shipper gets implSummary only — no full plan (or recon) in the bundle", () => {
        const bundle = contextBundleForPhase("shipper", fullArtifacts);
        assert.ok(!bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan"));
        assert.ok(bundle.includes("Implementation done"));
    });

    it("unknown agent falls back to all artifacts", () => {
        const bundle = contextBundleForPhase("unknown-agent", fullArtifacts);
        // Unknown agents get the full bundle (forward-compat)
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Review feedback"));
        assert.ok(bundle.includes("Implementation done"));
    });

    it("returns empty string when no artifacts are set", () => {
        const bundle = contextBundleForPhase("planner", {});
        assert.equal(bundle, "");
    });

    it("omits artifacts that are undefined even if in whitelist", () => {
        const partial: RunArtifacts = { recon: "Scout only" };
        const bundle = contextBundleForPhase("planner", partial);
        assert.ok(bundle.includes("Scout only"));
        assert.ok(!bundle.includes("The plan"));
    });

    it("is case-insensitive for agent names", () => {
        const bundle = contextBundleForPhase("PLANNER", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
    });
});

describe("reviewTask re-review awareness", () => {
    it("omits the re-review block on a first review", () => {
        const t = reviewTask("do X", "I changed a.ts");
        assert.doesNotMatch(t, /RE-REVIEW/);
        assert.doesNotMatch(t, /previous review/i);
        assert.match(t, /I changed a\.ts/);
    });

    it("includes the prior review (clamped) on a re-review", () => {
        const prior = "VERDICT: REVISE BEFORE MERGE\nC1: null deref at a.ts:10";
        const t = reviewTask("do X", "fixed it", prior);
        assert.match(t, /RE-REVIEW/);
        assert.match(t, /Your previous review:/);
        assert.match(t, /null deref at a\.ts:10/);
    });

    it("clamps a huge prior review", () => {
        const huge = "VERDICT: REVISE\n" + "x".repeat(40000);
        const t = reviewTask("do X", "fixed", huge);
        assert.ok(t.length < 8000, `re-review task too large: ${t.length}`);
        assert.match(t, /output truncated/);
    });
});

describe("projectSessionHash", () => {
    it("gives distinct keys to cwds that share a long prefix (the bug)", () => {
        const a = projectSessionHash(
            "/Users/teckdroids/Documents/Dev/slf/ai/projects/todo",
        );
        const b = projectSessionHash(
            "/Users/teckdroids/Documents/Dev/slf/ai/projects/todo_app_spec",
        );
        assert.notEqual(a, b);
    });

    it("is stable for the same cwd", () => {
        const p = "/Users/x/projects/todo";
        assert.equal(projectSessionHash(p), projectSessionHash(p));
    });

    it("stays bounded and filesystem-safe even for very deep paths", () => {
        const h = projectSessionHash("/" + "segment/".repeat(200) + "deep");
        assert.ok(h.length <= 49, `too long: ${h.length}`);
        assert.match(h, /^[A-Za-z0-9-]+$/);
    });
});

describe("parsePlanPhases", () => {
    it("extracts phase headings in order", () => {
        const plan =
            "# Plan\n## Context\ntext\n## Phase 1: Skeleton\nbody\n## Phase 2: Polish (TDD)\nbody\n## Acceptance Criteria\n";
        assert.deepEqual(parsePlanPhases(plan), [
            "Phase 1: Skeleton",
            "Phase 2: Polish (TDD)",
        ]);
    });

    it("returns [] when there are no phase headings", () => {
        assert.deepEqual(parsePlanPhases("just some text\n## Context\n"), []);
        assert.deepEqual(parsePlanPhases(""), []);
    });
});

describe("parseProgressLedger", () => {
    it("parses the seeded ledger format, ignoring heading and Base line", () => {
        const ledger =
            "# Implementation progress\n\nBase: abc123\n\n- [ ] Phase 1: Skeleton\n- [x] Phase 2: Polish\n";
        assert.deepEqual(parseProgressLedger(ledger), [
            { label: "Phase 1: Skeleton", done: false },
            { label: "Phase 2: Polish", done: true },
        ]);
    });

    it("treats [X] (uppercase) as done and keeps order", () => {
        const out = parseProgressLedger("- [X] A\n- [ ] B\n- [x] C\n");
        assert.deepEqual(
            out.map((i) => i.done),
            [true, false, true],
        );
        assert.deepEqual(
            out.map((i) => i.label),
            ["A", "B", "C"],
        );
    });

    it("returns [] for empty or checkbox-free content", () => {
        assert.deepEqual(parseProgressLedger(""), []);
        assert.deepEqual(parseProgressLedger("# Heading\nno boxes here\n"), []);
    });
});

describe("inferWorkflowTeam", () => {
    const teams = { build: ["implementer"], spec: ["planner"] };

    it("maps build/implement-the-plan phrasings to the build team", () => {
        for (const req of [
            "build the implementation plan",
            "implement the plan",
            "implement the implementation plan",
            "build the plan",
            "please build the implementation plan for the dashboard",
        ]) {
            assert.equal(inferWorkflowTeam(req, teams), "build", req);
        }
    });

    it("does not match from-scratch or planning requests", () => {
        for (const req of [
            "build me a todo app",
            "create an implementation plan",
            "build a plan for the API",
            "add a dark mode toggle",
            "",
        ]) {
            assert.equal(inferWorkflowTeam(req, teams), "", req);
        }
    });

    it("returns '' when the build team isn't defined", () => {
        assert.equal(
            inferWorkflowTeam("implement the plan", { spec: ["planner"] }),
            "",
        );
    });
});

describe("buildReviewChecklist", () => {
    const phase = (agent: string, status: PhaseState["status"]) => {
        const p = testPhase(agent);
        p.status = status;
        return p;
    };

    it("is hidden until the reviewer phase exists or starts", () => {
        assert.deepEqual(buildReviewChecklist([]), []);
        assert.deepEqual(buildReviewChecklist([phase("implementer", "running")]), []);
        assert.deepEqual(buildReviewChecklist([phase("reviewer", "pending")]), []);
    });

    it("shows all items unchecked while the reviewer runs with no markers", () => {
        const items = buildReviewChecklist([phase("reviewer", "running")]);
        assert.equal(items.length, REVIEW_CHECKLIST.length);
        assert.ok(items.every((i) => !i.done));
        assert.equal(items[0].label, "Plan conformance");
    });

    it("ticks only the reported items live while running (doneLabels)", () => {
        const items = buildReviewChecklist(
            [phase("reviewer", "running")],
            new Set(["Correctness", "Tests"]),
        );
        const done = items.filter((i) => i.done).map((i) => i.label);
        assert.deepEqual(done.sort(), ["Correctness", "Tests"]);
    });

    it("ignores doneLabels once finished — all items read done", () => {
        const items = buildReviewChecklist(
            [phase("reviewer", "done")],
            new Set(["Correctness"]),
        );
        assert.ok(items.every((i) => i.done));
    });

    it("checks every item once the reviewer finishes", () => {
        const items = buildReviewChecklist([phase("reviewer", "done")]);
        assert.ok(items.length > 0 && items.every((i) => i.done));
    });
});

describe("contextWindowForModel", () => {
    const models = [
        { id: "gateframe_yoda/qwen-max-3-7-yoda-2", provider: "gateframe", contextWindow: 1000000 },
        { id: "gpt-5-nano", provider: "gateframe_bot", contextWindow: 400000 },
        { id: "no-window", provider: "x" },
    ];

    it("matches the bare registry id (env-style model string)", () => {
        assert.equal(
            contextWindowForModel(models, "gateframe_yoda/qwen-max-3-7-yoda-2"),
            1000000,
        );
    });

    it("matches the full provider/id form (.md-style model string)", () => {
        assert.equal(
            contextWindowForModel(models, "gateframe_bot/gpt-5-nano"),
            400000,
        );
    });

    it("returns 0 for unknown model, missing window, or empty input", () => {
        assert.equal(contextWindowForModel(models, "who/knows"), 0);
        assert.equal(contextWindowForModel(models, "x/no-window"), 0);
        assert.equal(contextWindowForModel(undefined, "anything"), 0);
        assert.equal(contextWindowForModel(models, ""), 0);
    });
});

describe("parseAgentEnvConfig", () => {
    const env = (v?: string) =>
        ({ PI_AGENT_VALIDATOR: v }) as Record<string, string | undefined>;

    it("parses strict JSON (model + contextWindow)", () => {
        assert.deepEqual(
            parseAgentEnvConfig(
                "validator",
                env('{"model":"x/y","contextWindow":1000000}'),
            ),
            { model: "x/y", contextWindow: 1000000 },
        );
    });

    it("parses the loose unquoted form", () => {
        assert.deepEqual(
            parseAgentEnvConfig(
                "validator",
                env("{model: x/y, contextWindow: 1000000}"),
            ),
            { model: "x/y", contextWindow: 1000000 },
        );
    });

    it("accepts context_window snake_case", () => {
        assert.deepEqual(
            parseAgentEnvConfig("validator", env("{model: m, context_window: 500000}")),
            { model: "m", contextWindow: 500000 },
        );
    });

    it("returns only the fields present", () => {
        assert.deepEqual(parseAgentEnvConfig("validator", env("{model: only}")), {
            model: "only",
        });
        assert.deepEqual(
            parseAgentEnvConfig("validator", env("{contextWindow: 200000}")),
            { contextWindow: 200000 },
        );
    });

    it("derives the var name from the agent key (hyphens/case)", () => {
        assert.deepEqual(
            parseAgentEnvConfig("plan-build", { PI_AGENT_PLAN_BUILD: "{model: pb}" }),
            { model: "pb" },
        );
    });

    it("returns {} when unset or unparseable, and ignores invalid contextWindow", () => {
        assert.deepEqual(parseAgentEnvConfig("validator", env(undefined)), {});
        assert.deepEqual(parseAgentEnvConfig("validator", env("not an object")), {});
        assert.deepEqual(
            parseAgentEnvConfig("validator", env("{model: m, contextWindow: abc}")),
            { model: "m" },
        );
    });
});

describe("clampOutput", () => {
    it("passes normal-sized output through untouched", () => {
        const normal = "VERDICT: PASS\n" + "x".repeat(5000);
        assert.equal(clampOutput(normal), normal);
    });

    it("clamps a runaway output but keeps head AND tail", () => {
        // First-line marker (head) and a trailing marker (tail) both survive.
        const big =
            "VERDICT: PASS — leading summary\n" +
            "m".repeat(40000) +
            "\nTRAILING-MARKER";
        const out = clampOutput(big, 1000);
        assert.ok(out.length < big.length);
        assert.match(out, /VERDICT: PASS/); // head preserved
        assert.match(out, /TRAILING-MARKER/); // tail preserved
        assert.match(out, /output truncated/);
    });

    it("handles empty/undefined", () => {
        assert.equal(clampOutput(""), "");
        assert.equal(clampOutput(undefined as unknown as string), "");
    });
});

describe("clampSummary", () => {
    it("returns a short summary unchanged (trimmed)", () => {
        assert.equal(clampSummary("  short summary  "), "short summary");
    });

    it("head-truncates a long summary and points to the durable record", () => {
        const long = "A".repeat(5000);
        const out = clampSummary(long, 2500);
        assert.ok(out.startsWith("A".repeat(2500)));
        assert.ok(out.length < long.length);
        assert.match(out, /truncated/);
        assert.match(out, /per-phase commits and `\.agent\/progress\.md`/);
    });

    it("keeps text exactly at the cap intact (no truncation note)", () => {
        const exact = "B".repeat(2500);
        assert.equal(clampSummary(exact, 2500), exact);
    });

    it("handles empty/undefined input", () => {
        assert.equal(clampSummary(""), "");
        assert.equal(clampSummary(undefined as unknown as string), "");
    });
});

describe("dispatchEnv", () => {
    const KEYS = [
        "PI_DISPATCH_DEPTH",
        "PI_DISPATCH_ANCESTRY",
        "PI_OBS",
        "PI_OBS_RUN",
        "PI_OBS_AGENT",
        "PI_OBS_PARENT",
        "PI_OBS_DISPATCH_ID",
    ];
    function withEnv(
        vars: Record<string, string | undefined>,
        fn: () => void,
    ) {
        const saved: Record<string, string | undefined> = {};
        for (const k of KEYS) saved[k] = process.env[k];
        try {
            for (const k of KEYS) {
                if (vars[k] === undefined) delete process.env[k];
                else process.env[k] = vars[k];
            }
            fn();
        } finally {
            for (const k of KEYS) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        }
    }

    it("starts depth at 1 and seeds ancestry from a top-level spawn", () => {
        withEnv({ PI_DISPATCH_DEPTH: undefined, PI_DISPATCH_ANCESTRY: undefined }, () => {
            const env = dispatchEnv("Scout");
            assert.equal(env.PI_DISPATCH_DEPTH, "1");
            assert.equal(env.PI_DISPATCH_ANCESTRY, "scout");
            assert.equal(env.PI_SUBAGENT, "1");
        });
    });

    it("increments depth and appends (lowercased) to the ancestry chain", () => {
        withEnv({ PI_DISPATCH_DEPTH: "1", PI_DISPATCH_ANCESTRY: "coordinator" }, () => {
            const env = dispatchEnv("Scout");
            assert.equal(env.PI_DISPATCH_DEPTH, "2");
            assert.equal(env.PI_DISPATCH_ANCESTRY, "coordinator>scout");
        });
    });

    it("omits the obs vars when PI_OBS is off", () => {
        withEnv({ PI_OBS: undefined }, () => {
            const env = dispatchEnv("Scout", "scout-123");
            assert.equal(env.PI_OBS_AGENT, undefined);
            assert.equal(env.PI_OBS_DISPATCH_ID, undefined);
        });
    });

    it("propagates the dispatchId (and run/parent) for obs when PI_OBS=1", () => {
        withEnv(
            {
                PI_OBS: "1",
                PI_OBS_RUN: "run-xyz",
                PI_OBS_AGENT: "orchestrator",
                PI_OBS_DISPATCH_ID: undefined,
            },
            () => {
                const env = dispatchEnv("Seeker", "seeker-1759-abc");
                assert.equal(env.PI_OBS_AGENT, "seeker");
                assert.equal(env.PI_OBS_RUN, "run-xyz");
                assert.equal(env.PI_OBS_PARENT, "orchestrator");
                assert.equal(env.PI_OBS_DISPATCH_ID, "seeker-1759-abc");
            },
        );
    });

    it("sets no dispatchId when none is given even with obs on", () => {
        withEnv({ PI_OBS: "1" }, () => {
            const env = dispatchEnv("Seeker");
            assert.equal(env.PI_OBS_AGENT, "seeker");
            assert.equal(env.PI_OBS_DISPATCH_ID, undefined);
        });
    });
});

describe("stripInheritedSecrets", () => {
    it("removes the bridge secrets but keeps provider/skill creds and everything else", () => {
        const env = stripInheritedSecrets(
            {
                PI_OBS_TOKEN: "server-secret",
                PI_OBS_TG_TOKEN: "bot-token",
                ATLASSIAN_API_TOKEN: "keep-me",
                LINEAR_API_KEY: "keep-me-too",
                ANTHROPIC_API_KEY: "provider-key",
                PATH: "/usr/bin",
            },
            {},
        );
        assert.equal(env.PI_OBS_TOKEN, undefined);
        assert.equal(env.PI_OBS_TG_TOKEN, undefined);
        assert.equal(env.ATLASSIAN_API_TOKEN, "keep-me");
        assert.equal(env.LINEAR_API_KEY, "keep-me-too");
        assert.equal(env.ANTHROPIC_API_KEY, "provider-key");
        assert.equal(env.PATH, "/usr/bin");
    });

    it("also strips operator-specified extra keys (PI_SUBAGENT_ENV_STRIP)", () => {
        const env = stripInheritedSecrets(
            { PI_OBS_TOKEN: "x", MY_SECRET: "y", OTHER: "z", KEEP: "k" },
            { PI_SUBAGENT_ENV_STRIP: "MY_SECRET, OTHER" },
        );
        assert.equal(env.MY_SECRET, undefined);
        assert.equal(env.OTHER, undefined);
        assert.equal(env.KEEP, "k");
    });
});

describe("stickyContextUsage", () => {
    const known = { percent: 42, tokens: 13000, contextWindow: 1_000_000 };
    const idle = { percent: null, tokens: null, contextWindow: 1_000_000 };

    it("returns the live reading when it has a real percent/tokens", () => {
        assert.equal(stickyContextUsage(undefined, known), known);
    });

    it("keeps the last known reading when the live one is idle (null)", () => {
        // after a job finishes, getContextUsage reports null until the next turn
        assert.equal(stickyContextUsage(known, idle), known);
    });

    it("falls back to the live (unknown) value when there is no prior reading", () => {
        assert.equal(stickyContextUsage(undefined, idle), idle);
        assert.equal(stickyContextUsage(undefined, undefined), undefined);
    });

    it("treats a real 0% as known (does not stick to a stale value)", () => {
        const zero = { percent: 0, tokens: 0, contextWindow: 1_000_000 };
        assert.equal(stickyContextUsage(known, zero), zero);
    });
});

describe("formatContextUsage bar fill", () => {
    const fill = (contextPct: number | null, opts: any = {}) =>
        formatContextUsage({ contextPct, barLength: 10, preferContextPct: true, ...opts }).bar;

    it("lights at least one cell for any non-zero usage (large window)", () => {
        // 1.3% of a 1M window rounds to 0 cells naively; floor it to 1 so the bar
        // visibly tracks usage instead of reading empty.
        assert.equal(fill(1.3), "#---------");
    });

    it("keeps a true 0% empty", () => {
        assert.equal(fill(0), "----------");
    });

    it("stays empty when usage rounds to 0.0% (e.g. a few tokens on a 1M window)", () => {
        // 16 tokens / 1M ≈ 0.0016% — displays 0.0%, so the bar must not light a cell.
        assert.equal(fill(0.0016), "----------");
        assert.equal(fill(0.04), "----------"); // still < 0.05 → 0.0%
        assert.equal(fill(0.05), "#---------"); // rounds to 0.1% → one cell
    });

    it("fills proportionally above the first cell", () => {
        assert.equal(fill(50), "#####-----");
        assert.equal(fill(100), "##########");
    });

    it("is empty when the percent is unknown", () => {
        assert.equal(fill(null), "----------");
    });
});

describe("renderWorkflowFooter", () => {
    // Stub theme: return the raw text so we can assert on content, not colors.
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    function footer(phases: PhaseState[]): string {
        return renderWorkflowFooter({
            width: 200,
            theme,
            selfName: "agent-workflow",
            model: "m",
            running: false,
            lastStatus: "idle",
            iteration: 1,
            maxLoopsRef: 3,
            dispatchMode: true,
            phases,
            dispatchElapsedMs: 0,
            runElapsedMs: 0,
            contextUsage: () => undefined,
            visibleWidth: (s) => s.length,
            truncateToWidth: (s, w) => s.slice(0, w),
        })[0];
    }
    function running(label: string): PhaseState {
        const p = mkPhase(label, label.toLowerCase());
        p.status = "running";
        return p;
    }

    it("shows a single running sub-agent by name", () => {
        assert.ok(footer([running("Scout")]).includes("running Scout"));
    });

    it("lists all running sub-agents when several run in parallel", () => {
        const line = footer([running("Scout"), running("Seeker")]);
        assert.ok(line.includes("Scout ∥ Seeker"));
    });

    it("caps the list with a +N overflow", () => {
        const line = footer(
            ["A", "B", "C", "D", "E", "F"].map(running),
        );
        assert.ok(line.includes("+2"));
        assert.ok(!line.includes("∥ E"));
    });

    const base = {
        width: 200,
        theme,
        selfName: "",
        model: "m",
        running: false,
        lastStatus: "idle",
        iteration: 1,
        maxLoopsRef: 3,
        dispatchMode: false,
        phases: [] as PhaseState[],
        dispatchElapsedMs: 0,
        runElapsedMs: 0,
        contextUsage: () => undefined,
        visibleWidth: (s: string) => s.length,
        truncateToWidth: (s: string, w: number) => s.slice(0, w),
    };

    it("shows the rounded cache hit rate when provided", () => {
        const line = renderWorkflowFooter({ ...base, cacheHitPct: 88.6 })[0];
        assert.ok(line.includes("CH 89%"), line);
    });

    it("omits the cache hit rate when zero or undefined", () => {
        assert.ok(!renderWorkflowFooter({ ...base })[0].includes("CH "));
        assert.ok(
            !renderWorkflowFooter({ ...base, cacheHitPct: 0 })[0].includes("CH "),
        );
    });
});

describe("parseAgentFile aliases", () => {
    function write(content: string): string {
        const f = join(mkdtempSync(join(tmpdir(), "agent-")), "a.md");
        writeFileSync(f, content);
        return f;
    }
    it("parses YAML [a, b] list form", () => {
        const def = parseAgentFile(
            write("---\nname: atlassian\naliases: [jira, atl]\ntools: bash\n---\nbody"),
        );
        assert.deepEqual(def?.aliases, ["jira", "atl"]);
    });
    it("parses bare comma/space form, and is undefined when absent", () => {
        const a = parseAgentFile(write("---\nname: x\naliases: foo, bar\n---\nb"));
        assert.deepEqual(a?.aliases, ["foo", "bar"]);
        const b = parseAgentFile(write("---\nname: y\n---\nb"));
        assert.equal(b?.aliases, undefined);
    });

    it("applies PI_AGENT_<NAME> model/contextWindow when the frontmatter omits them", () => {
        const f = write("---\nname: validator\ndescription: gate\ntools: read,bash\n---\nbody");
        process.env.PI_AGENT_VALIDATOR =
            '{"model":"prov/the-model","contextWindow":1000000}';
        try {
            const def = parseAgentFile(f);
            assert.equal(def?.model, "prov/the-model");
            assert.equal(def?.contextWindow, 1000000);
        } finally {
            delete process.env.PI_AGENT_VALIDATOR;
        }
    });

    it("leaves model empty and contextWindow 0 with no frontmatter and no env", () => {
        delete process.env.PI_AGENT_NOENVAGENT;
        const def = parseAgentFile(
            write("---\nname: noenvagent\ndescription: d\ntools: read\n---\nbody"),
        );
        assert.equal(def?.model, "");
        assert.equal(def?.contextWindow, 0);
    });
});

describe("subagentExtArgs", () => {
    // subagentExtArgs reads PI_CONFINE_CWD from the ambient env; a project .env
    // (PI_CONFINE_CWD=1) would otherwise inject cwd-guard.ts and break the
    // default-case assertions. Pin it unset per test; the dedicated toggle test
    // sets and restores it within its own try/finally.
    let savedConfine: string | undefined;
    beforeEach(() => {
        savedConfine = process.env.PI_CONFINE_CWD;
        delete process.env.PI_CONFINE_CWD;
    });
    afterEach(() => {
        if (savedConfine === undefined) delete process.env.PI_CONFINE_CWD;
        else process.env.PI_CONFINE_CWD = savedConfine;
    });
    it("adds agent-memory.ts by default; nothing else for a plain agent", () => {
        const saved = process.env.PI_AGENT_MEMORY;
        try {
            // with memory off, a plain (no dispatch/guard) agent gets no extensions
            process.env.PI_AGENT_MEMORY = "0";
            assert.deepEqual(subagentExtArgs("read,write,grep,find,ls"), []);
            // default on: every agent gets the remember tool
            delete process.env.PI_AGENT_MEMORY;
            assert.ok(subagentExtArgs("read,write,grep,find,ls").some((a) => a.endsWith("agent-memory.ts")));
        } finally {
            if (saved === undefined) delete process.env.PI_AGENT_MEMORY;
            else process.env.PI_AGENT_MEMORY = saved;
        }
    });
    it("passes -e dispatch.ts when tools include a dispatch tool", () => {
        const a = subagentExtArgs("read,dispatch_agent,ls");
        assert.equal(a[0], "-e");
        assert.ok(a[1].endsWith("extensions/dispatch.ts"), a[1]);
    });
    const hasReadonlyGuard = (a: string[]) =>
        a.some((x) => x.endsWith("readonly-guard.ts"));
    it("adds readonly-guard.ts for a bash agent with no write/edit", () => {
        assert.ok(hasReadonlyGuard(subagentExtArgs("read,bash,grep")));
    });
    it("skips readonly-guard.ts for a write-capable bash agent by default", () => {
        assert.ok(!hasReadonlyGuard(subagentExtArgs("read,write,bash")));
    });
    it("adds readonly-guard.ts for a write agent that opts into read-only-bash", () => {
        assert.ok(hasReadonlyGuard(subagentExtArgs("read,write,bash", true)));
    });
    it("never adds readonly-guard.ts to an agent without bash", () => {
        assert.ok(!hasReadonlyGuard(subagentExtArgs("read,write", true)));
    });
    it("adds cwd-guard.ts only when PI_CONFINE_CWD=1", () => {
        const saved = process.env.PI_CONFINE_CWD;
        try {
            delete process.env.PI_CONFINE_CWD;
            assert.ok(
                !subagentExtArgs("read").some((a) => a.endsWith("cwd-guard.ts")),
            );
            process.env.PI_CONFINE_CWD = "1";
            assert.ok(
                subagentExtArgs("read").some((a) => a.endsWith("cwd-guard.ts")),
            );
        } finally {
            if (saved === undefined) delete process.env.PI_CONFINE_CWD;
            else process.env.PI_CONFINE_CWD = saved;
        }
    });
});

describe("spawnSessionName", () => {
    it("combines the project basename and agent name", () => {
        assert.equal(
            spawnSessionName("/home/me/projects/todo", "implementer"),
            "todo · implementer",
        );
    });
    it("falls back to 'pi' when the cwd has no basename", () => {
        assert.equal(spawnSessionName("/", "scout"), "pi · scout");
    });
});

describe("shouldApproveProjectForSpawn", () => {
    let dir: string;
    let cwd: string;
    let savedAgentDir: string | undefined;
    let savedEnv: string | undefined;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "trust-"));
        cwd = mkdtempSync(join(tmpdir(), "proj-"));
        savedAgentDir = process.env.PI_CODING_AGENT_DIR;
        savedEnv = process.env.PI_WORKFLOW_APPROVE_PROJECT;
        process.env.PI_CODING_AGENT_DIR = dir;
        delete process.env.PI_WORKFLOW_APPROVE_PROJECT;
    });
    afterEach(() => {
        if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
        if (savedEnv === undefined) delete process.env.PI_WORKFLOW_APPROVE_PROJECT;
        else process.env.PI_WORKFLOW_APPROVE_PROJECT = savedEnv;
    });

    const writeTrust = (obj: Record<string, unknown>) =>
        writeFileSync(join(dir, "trust.json"), JSON.stringify(obj));
    // The store is keyed by the canonical (realpath'd) cwd.
    const keyFor = (p: string) => {
        try {
            return require("node:fs").realpathSync(p);
        } catch {
            return p;
        }
    };

    it("is false when no trust.json exists", () => {
        assert.equal(shouldApproveProjectForSpawn(cwd), false);
    });
    it("approves when the saved decision is exactly true", () => {
        writeTrust({ [keyFor(cwd)]: true });
        assert.equal(shouldApproveProjectForSpawn(cwd), true);
    });
    it("does not approve a declined (false) project", () => {
        writeTrust({ [keyFor(cwd)]: false });
        assert.equal(shouldApproveProjectForSpawn(cwd), false);
    });
    it("does not approve when the cwd has no saved decision", () => {
        writeTrust({ "/some/other/path": true });
        assert.equal(shouldApproveProjectForSpawn(cwd), false);
    });
    it("PI_WORKFLOW_APPROVE_PROJECT=1 forces approval without a store", () => {
        process.env.PI_WORKFLOW_APPROVE_PROJECT = "1";
        assert.equal(shouldApproveProjectForSpawn(cwd), true);
    });
    it("PI_WORKFLOW_APPROVE_PROJECT=0 forces off even when trusted", () => {
        writeTrust({ [keyFor(cwd)]: true });
        process.env.PI_WORKFLOW_APPROVE_PROJECT = "0";
        assert.equal(shouldApproveProjectForSpawn(cwd), false);
    });
    it("survives a corrupt trust.json", () => {
        writeFileSync(join(dir, "trust.json"), "{ not json");
        assert.equal(shouldApproveProjectForSpawn(cwd), false);
    });

    // Authoritative trust from pi's ctx.isProjectTrusted() (pi >= 0.79.1).
    it("approves on authoritative true even with no store", () => {
        assert.equal(shouldApproveProjectForSpawn(cwd, true), true);
    });
    it("authoritative false wins over a trusted disk store", () => {
        writeTrust({ [keyFor(cwd)]: true });
        assert.equal(shouldApproveProjectForSpawn(cwd, false), false);
    });
    it("falls back to the disk read when authoritative is undefined", () => {
        writeTrust({ [keyFor(cwd)]: true });
        assert.equal(shouldApproveProjectForSpawn(cwd, undefined), true);
    });
    it("PI_WORKFLOW_APPROVE_PROJECT=0 still overrides authoritative true", () => {
        process.env.PI_WORKFLOW_APPROVE_PROJECT = "0";
        assert.equal(shouldApproveProjectForSpawn(cwd, true), false);
    });
    it("PI_WORKFLOW_APPROVE_PROJECT=1 still overrides authoritative false", () => {
        process.env.PI_WORKFLOW_APPROVE_PROJECT = "1";
        assert.equal(shouldApproveProjectForSpawn(cwd, false), true);
    });
});

// ── loadSkills ───────────────────────────────────

describe("loadSkills", () => {
    it("discovers the bundled SKILL.md skills with name + description", () => {
        const skills = loadSkills(process.cwd());
        const names = skills.map((s) => s.name).sort();
        for (const n of ["atlassian", "bowser", "commit", "github", "linear"]) {
            assert.ok(names.includes(n), `expected skill "${n}"`);
        }
        const github = skills.find((s) => s.name === "github");
        assert.ok(
            github && github.description.length > 0,
            "github skill should have a description",
        );
    });
});

// ── sessionLabel ─────────────────────────────────

describe("sessionLabel", () => {
    it("includes the team and request", () => {
        assert.equal(
            sessionLabel("agent-workflow", "plan-build", "add CSV export"),
            "agent-workflow · plan-build · add CSV export",
        );
    });
    it("omits the team when none / 'none'", () => {
        assert.equal(
            sessionLabel("agent-workflow", "", "do a thing"),
            "agent-workflow · do a thing",
        );
        assert.equal(
            sessionLabel("agent-workflow", "none", "do a thing"),
            "agent-workflow · do a thing",
        );
    });
    it("truncates a long request", () => {
        const label = sessionLabel("agent-workflow", "", "x".repeat(80));
        assert.ok(label.endsWith("…"));
        assert.ok(label.length < 70);
    });
});

// ── resolveAgentModel + runtime model overrides ──

function mkAgentDef(name: string, model = ""): AgentDef {
    return {
        name,
        description: "",
        tools: "",
        model,
        contextWindow: 0,
        systemPrompt: "",
    };
}
// A unique agent key so a real PI_AGENT_<NAME>_MODEL in the environment can't
// shadow these tests (the dev env exports some PI_AGENT_*_MODEL vars).
const A = "qa-probe";
const ENV = "PI_AGENT_QA_PROBE_MODEL";
const oneAgent = (model = ""): Map<string, AgentDef> =>
    new Map([[A, mkAgentDef(A, model)]]);

describe("agentModelEnvVar", () => {
    it("derives the env var name from an agent key", () => {
        assert.equal(agentModelEnvVar("seeker"), "PI_AGENT_SEEKER_MODEL");
        assert.equal(
            agentModelEnvVar("plan-build"),
            "PI_AGENT_PLAN_BUILD_MODEL",
        );
        assert.equal(agentModelEnvVar(A), ENV);
    });
});

describe("resolveAgentModel", () => {
    it("falls back to the workflow model, then the caller fallback", () => {
        assert.equal(
            resolveAgentModel(A, oneAgent(), "wf-model", "fb"),
            "wf-model",
        );
        assert.equal(resolveAgentModel(A, oneAgent(), "", "fb"), "fb");
    });

    it("prefers the agent's frontmatter model over the workflow model", () => {
        assert.equal(resolveAgentModel(A, oneAgent("fm"), "wf", "fb"), "fm");
    });

    it("prefers PI_AGENT_<NAME>_MODEL over frontmatter", () => {
        const prev = process.env[ENV];
        process.env[ENV] = "env-model";
        try {
            assert.equal(
                resolveAgentModel(A, oneAgent("fm"), "wf", "fb"),
                "env-model",
            );
        } finally {
            if (prev === undefined) delete process.env[ENV];
            else process.env[ENV] = prev;
        }
    });
});

describe("runtime model overrides", () => {
    it("a runtime override wins over env, frontmatter, and workflow model", () => {
        const prev = process.env[ENV];
        process.env[ENV] = "env-model";
        setModelOverride(A, "override-model");
        try {
            assert.equal(
                resolveAgentModel(A, oneAgent("fm"), "wf", "fb"),
                "override-model",
            );
            assert.equal(getModelOverride(A), "override-model");
            assert.equal(getModelOverrides().get(A), "override-model");
        } finally {
            clearAllModelOverrides();
            if (prev === undefined) delete process.env[ENV];
            else process.env[ENV] = prev;
        }
    });

    it("is case-insensitive on the agent key", () => {
        setModelOverride("QA-Probe", "m1");
        try {
            assert.equal(resolveAgentModel(A, oneAgent("fm"), "wf", "fb"), "m1");
        } finally {
            clearAllModelOverrides();
        }
    });

    it("clearModelOverride removes one; resolution returns to frontmatter", () => {
        setModelOverride(A, "m1");
        assert.equal(clearModelOverride(A), true);
        assert.equal(clearModelOverride(A), false);
        assert.equal(resolveAgentModel(A, oneAgent("fm"), "wf", "fb"), "fm");
    });

    it("clearAllModelOverrides returns the count cleared and empties the map", () => {
        setModelOverride(A, "m1");
        setModelOverride("qa-probe-2", "m2");
        assert.equal(clearAllModelOverrides(), 2);
        assert.equal(getModelOverrides().size, 0);
    });

    it("getModelOverrides returns a copy (mutating it does not affect state)", () => {
        setModelOverride(A, "m1");
        const snap = getModelOverrides() as Map<string, string>;
        snap.delete(A);
        assert.equal(getModelOverride(A), "m1");
        clearAllModelOverrides();
    });
});

describe("transientRetryLimit", () => {
    it("defaults to 2 and clamps to 0..5", () => {
        assert.equal(transientRetryLimit({} as NodeJS.ProcessEnv), 2);
        assert.equal(transientRetryLimit({ PI_AGENT_TRANSIENT_RETRIES: "0" } as any), 0);
        assert.equal(transientRetryLimit({ PI_AGENT_TRANSIENT_RETRIES: "9" } as any), 5);
        assert.equal(transientRetryLimit({ PI_AGENT_TRANSIENT_RETRIES: "x" } as any), 2);
    });
});

describe("runAgentWithFallback transient retry", () => {
    const agent: AgentDef = {
        name: "tester-agent", description: "", model: "", contextWindow: 0, tools: "",
    } as AgentDef;
    const noopOpts = { updateWidget: () => {}, notify: () => {} };

    // Keep tests fast (no real backoff) and isolated (restore env after each).
    const origBackoff = process.env.PI_AGENT_TRANSIENT_BACKOFF_MS;
    const origRetries = process.env.PI_AGENT_TRANSIENT_RETRIES;
    beforeEach(() => {
        process.env.PI_AGENT_TRANSIENT_BACKOFF_MS = "0";
    });
    afterEach(() => {
        const restore = (k: string, v: string | undefined) =>
            v === undefined ? delete process.env[k] : (process.env[k] = v);
        restore("PI_AGENT_TRANSIENT_BACKOFF_MS", origBackoff);
        restore("PI_AGENT_TRANSIENT_RETRIES", origRetries);
    });

    it("retries the same model on a transient error, then succeeds", async () => {
        const models: string[] = [];
        let n = 0;
        const spawn = async (_d: any, _t: string, _p: any, _c: string, model: string) => {
            models.push(model);
            n++;
            return n === 1
                ? { output: "[agent error] Stream ended without finish_reason", exitCode: 1 }
                : { output: "ok", exitCode: 0 };
        };
        const r = await runAgentWithFallback(agent, "t", mkPhase("T", "tester-agent"), "/x", "primary", "fallback", spawn, noopOpts);
        assert.equal(r.exitCode, 0);
        assert.equal(n, 2);
        assert.deepEqual(models, ["primary", "primary"]); // same model retried, no fallback
    });

    it("does NOT retry a non-transient (logical) failure", async () => {
        let n = 0;
        const spawn = async () => {
            n++;
            return { output: "VERDICT: FAIL — tests failed", exitCode: 1 };
        };
        const r = await runAgentWithFallback(agent, "t", mkPhase("T", "tester-agent"), "/x", "primary", "", spawn, noopOpts);
        assert.equal(r.exitCode, 1);
        assert.equal(n, 1); // ran once, no retry
    });

    it("gives up after the retry limit on a persistent transient error", async () => {
        process.env.PI_AGENT_TRANSIENT_RETRIES = "2";
        let n = 0;
        const spawn = async () => {
            n++;
            return { output: "503 Service Unavailable", exitCode: 1 };
        };
        const r = await runAgentWithFallback(agent, "t", mkPhase("T", "tester-agent"), "/x", "primary", "", spawn, noopOpts);
        assert.equal(r.exitCode, 1);
        assert.equal(n, 3); // initial + 2 retries
    });
});

// ── buildWorkflowMetrics ─────────────────────────

describe("buildWorkflowMetrics", () => {
    it("emits a structured single-run record from phase states + totals", () => {
        const scout = mkPhase("Scout", "scout");
        scout.status = "done";
        scout.elapsed = 19_000;
        scout.toolCount = 2;
        scout.tokens = {
            input: 8000,
            output: 1000,
            cacheRead: 2000,
            cacheWrite: 0,
            contextWindow: 200000,
            costUsd: 0.022,
        };
        const impl = mkPhase("Implementer", "implementer");
        impl.status = "done";
        impl.elapsed = 378_000;
        impl.attempt = 2;
        impl.tokens = {
            input: 40000,
            output: 20000,
            cacheRead: 412700,
            cacheWrite: 0,
            contextWindow: 200000,
            costUsd: 0.397,
        };

        const m = buildWorkflowMetrics({
            request: "build a todo app",
            status: "paused-no-remote",
            verdict: "pass",
            passes: 1,
            maxLoops: 3,
            passed: true,
            prUrl: "",
            team: "build",
            startedAt: Date.parse("2026-06-10T19:25:00.000Z"),
            endedAt: Date.parse("2026-06-10T19:35:38.000Z"),
            totals: {
                runElapsedMs: 638_000,
                totalToolCalls: 53,
                totalTokens: {
                    input: 47677,
                    output: 24308,
                    cacheRead: 518993,
                    cacheWrite: 0,
                },
                totalDroppedLines: 0,
                totalCostUsd: 0.643,
            },
            phases: [scout, null, null, impl, null, null, null],
        });

        assert.equal(m.schema, 1);
        assert.equal(m.team, "build");
        assert.equal(m.shipOutcome, "paused");
        assert.equal(m.passes, 1);
        assert.equal(m.maxLoops, 3);
        assert.equal(m.startedAt, "2026-06-10T19:25:00.000Z");
        assert.equal(m.totals.wallclockMs, 638_000);
        assert.equal(m.totals.toolCalls, 53);
        assert.equal(m.totals.tokens.total, 47677 + 24308 + 518993);
        assert.equal(m.totals.costUsd, 0.643);
        // nulls are dropped; order preserved
        assert.equal(m.phases.length, 2);
        assert.equal(m.phases[0].label, "Scout");
        assert.equal(m.phases[1].label, "Implementer");
        assert.equal(m.phases[1].attempt, 2);
        assert.equal(m.phases[1].tokens?.total, 40000 + 20000 + 412700);
        assert.equal(m.phases[1].tokens?.costUsd, 0.397);
    });

    it("maps ship outcome from status and prUrl", () => {
        const base = {
            request: "x",
            verdict: "pass",
            passes: 1,
            maxLoops: 3,
            passed: true,
            totals: {
                runElapsedMs: 0,
                totalToolCalls: 0,
                totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                totalDroppedLines: 0,
            },
            phases: [],
        };
        assert.equal(
            buildWorkflowMetrics({ ...base, status: "shipped", prUrl: "" })
                .shipOutcome,
            "shipped",
        );
        assert.equal(
            buildWorkflowMetrics({
                ...base,
                status: "done",
                prUrl: "https://github.com/o/r/pull/1",
            }).shipOutcome,
            "shipped",
        );
        assert.equal(
            buildWorkflowMetrics({
                ...base,
                status: "failed-after-retries",
                prUrl: "",
            }).shipOutcome,
            "failed",
        );
        assert.equal(
            buildWorkflowMetrics({ ...base, status: "done", prUrl: "" })
                .shipOutcome,
            "unknown",
        );
    });
});

// ── spawnModelArg ────────────────────────────────

describe("spawnModelArg", () => {
    it("passes a bare id (with optional :thinking) through unchanged", () => {
        assert.equal(spawnModelArg("qwen-max-3-7-yoda-2"), "qwen-max-3-7-yoda-2");
        assert.equal(
            spawnModelArg("qwen-max-3-7-yoda-2:low"),
            "qwen-max-3-7-yoda-2:low",
        );
    });

    it("keeps the provider for a single-slash provider/id string", () => {
        assert.equal(
            spawnModelArg("anthropic/claude-opus-4-8"),
            "anthropic/claude-opus-4-8",
        );
        assert.equal(
            spawnModelArg("anthropic/claude-fable-5:low"),
            "anthropic/claude-fable-5:low",
        );
    });

    it("keeps the provider for a two-or-more-slash string", () => {
        assert.equal(
            spawnModelArg("gfr_prt/gateframe_yoda/qwen-max-3-7-yoda-2:low"),
            "gfr_prt/gateframe_yoda/qwen-max-3-7-yoda-2:low",
        );
    });

    it("returns null for empty or whitespace-containing strings", () => {
        assert.equal(spawnModelArg(undefined), null);
        assert.equal(spawnModelArg(""), null);
        assert.equal(spawnModelArg("   "), null);
        assert.equal(spawnModelArg("two words"), null);
    });
});

// ── spawnTaskArg ─────────────────────────────────

describe("spawnTaskArg", () => {
    it("passes a normal task through unchanged", () => {
        assert.equal(spawnTaskArg("implement the plan"), "implement the plan");
        assert.equal(spawnTaskArg(""), "");
    });

    it("neutralizes a dash-leading task so pi parses it as the prompt, not a flag", () => {
        // pi has no `--` separator and errors on an unknown `-x`; a leading space
        // forces the token to be read as the positional prompt.
        assert.equal(spawnTaskArg("-v then verify"), " -v then verify");
        assert.equal(spawnTaskArg("--help the user"), " --help the user");
    });
});

describe("appendLiveLog pane collapse", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const vw = (s: string) => s.length;
    const phase = (over: any) =>
        ({ label: "Seeker", status: "running", log: "line one\nline two\nreport body", toolCount: 2, ...over }) as any;

    it("shows the streamed log inline when the agent has NO pane", () => {
        const out: string[] = [];
        appendLiveLog(out, 80, theme, [phase({ paneActive: false })], true, vw);
        const t = out.join("\n");
        assert.match(t, /Seeker · live/);
        assert.match(t, /report body/); // streamed lines present
    });

    it("collapses to a pane pointer (no streamed lines) when the agent HAS a pane", () => {
        const out: string[] = [];
        appendLiveLog(out, 80, theme, [phase({ paneActive: true })], true, vw);
        const t = out.join("\n");
        assert.match(t, /live log in this agent's own pane/);
        assert.doesNotMatch(t, /report body/); // streamed lines moved to the pane
    });

    it("keeps the panel the SAME height collapsed vs not (stable height → no ghosting)", () => {
        const noPane: string[] = [];
        appendLiveLog(noPane, 80, theme, [phase({ paneActive: false })], true, vw);
        const withPane: string[] = [];
        appendLiveLog(withPane, 80, theme, [phase({ paneActive: true })], true, vw);
        assert.equal(withPane.length, noPane.length); // collapse pads to the same rows
    });
});
