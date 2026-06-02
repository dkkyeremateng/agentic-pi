import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    validatePlan,
    contextBundle,
    buildPhaseMap,
    failPhase,
    renderTemplate,
    type RunArtifacts,
    type PhaseState,
} from "./workflow-core";

// Run with: npx tsx --test workflow-core.test.ts

// Helper: create a minimal PhaseState for testing.
function mkPhase(agent: string): PhaseState {
    return {
        label: agent,
        agent,
        status: "pending",
        elapsed: 0,
        note: "",
        log: "",
        droppedLines: 0,
        toolCount: 0,
        contextPct: 0,
        attempt: 0,
        modelFallback: false,
    };
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
            critique: undefined,
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
        assert.ok(!result.includes("Critique"));
        assert.ok(!result.includes("Implementation summary"));
    });

    it("includes all artifacts when all are set", () => {
        const a: RunArtifacts = {
            recon: "recon",
            plan: "plan",
            critique: "critique",
            implSummary: "impl",
            testReport: "test",
            docReport: "doc",
        };
        const result = contextBundle(a);
        assert.ok(result.includes("Reconnaissance"));
        assert.ok(result.includes("Approved plan"));
        assert.ok(result.includes("Critique"));
        assert.ok(result.includes("Implementation summary"));
        assert.ok(result.includes("Test report"));
        assert.ok(result.includes("Documentation report"));
    });

    it("truncates artifacts longer than 3000 chars", () => {
        const longBody = "x".repeat(5000);
        const a: RunArtifacts = { recon: longBody };
        const result = contextBundle(a);
        // The truncated body should be ≤3000 chars + "..."
        const reconSection = result.split("### Reconnaissance (scout)")[1];
        assert.ok(reconSection.length < 5100, `Section too long: ${reconSection.length}`);
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
            mkPhase("scout"),
            mkPhase("planner"),
            mkPhase("critic"),
            mkPhase("implementer"),
            mkPhase("tester"),
            mkPhase("validator"),
            mkPhase("documenter"),
            mkPhase("validator"), // second validator = ship
        ];
        const pm = buildPhaseMap(phases);
        assert.equal(pm.scout?.agent, "scout");
        assert.equal(pm.planner.agent, "planner");
        assert.equal(pm.critic.agent, "critic");
        assert.equal(pm.implementer.agent, "implementer");
        assert.equal(pm.tester.agent, "tester");
        assert.equal(pm.validator.agent, "validator");
        assert.equal(pm.documenter.agent, "documenter");
        assert.equal(pm.ship.agent, "validator"); // ship = second validator
    });

    it("maps ship to the second validator entry", () => {
        const phases: PhaseState[] = [
            mkPhase("planner"),
            mkPhase("critic"),
            mkPhase("implementer"),
            mkPhase("tester"),
            mkPhase("validator"), // first = validate
            mkPhase("documenter"),
            mkPhase("validator"), // second = ship
        ];
        const pm = buildPhaseMap(phases);
        // The ship phase should be the second validator in the array
        const validators = phases.filter((p) => p.agent === "validator");
        assert.equal(pm.ship, validators[1]);
    });

    it("falls back to first validator for ship when only one validator exists", () => {
        const phases: PhaseState[] = [
            mkPhase("planner"),
            mkPhase("critic"),
            mkPhase("implementer"),
            mkPhase("tester"),
            mkPhase("validator"),
            mkPhase("documenter"),
        ];
        const pm = buildPhaseMap(phases);
        const validators = phases.filter((p) => p.agent === "validator");
        assert.equal(pm.ship, validators[0]);
    });

    it("returns undefined for scout when not present", () => {
        const phases: PhaseState[] = [
            mkPhase("planner"),
            mkPhase("critic"),
            mkPhase("implementer"),
            mkPhase("tester"),
            mkPhase("validator"),
            mkPhase("documenter"),
            mkPhase("validator"),
        ];
        const pm = buildPhaseMap(phases);
        assert.equal(pm.scout, undefined);
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
        const result = renderTemplate("Hello {{name}}, your {{item}} is ready.", {
            name: "Bob",
        });
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
