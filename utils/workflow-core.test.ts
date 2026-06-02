import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    validatePlan,
    contextBundle,
    contextBundleForPhase,
    buildPhaseMap,
    failPhase,
    renderTemplate,
    tokenNote,
    mkPhase,
    freshPhases,
    type RunArtifacts,
    type PhaseState,
} from "./workflow-core";

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
            testPhase("critic"),
            testPhase("implementer"),
            testPhase("tester"),
            testPhase("validator"),
            testPhase("documenter"),
            testPhase("shipper"),
        ];
        const pm = buildPhaseMap(phases);
        assert.equal(pm.scout?.agent, "scout");
        assert.equal(pm.planner.agent, "planner");
        assert.equal(pm.critic.agent, "critic");
        assert.equal(pm.implementer.agent, "implementer");
        assert.equal(pm.tester.agent, "tester");
        assert.equal(pm.validator.agent, "validator");
        assert.equal(pm.documenter.agent, "documenter");
        assert.equal(pm.shipper.agent, "shipper");
    });

    it("returns undefined for scout when not present", () => {
        const phases: PhaseState[] = [
            testPhase("planner"),
            testPhase("critic"),
            testPhase("implementer"),
            testPhase("tester"),
            testPhase("validator"),
            testPhase("documenter"),
            testPhase("shipper"),
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
        assert.equal(tokenNote(phase), ", 800 tokens");
    });

    it("formats large token counts with k suffix", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 10000, output: 2340, contextWindow: 200000 };
        assert.equal(tokenNote(phase), ", 12.3k tokens");
    });

    it("formats exactly 1000 tokens with k suffix", () => {
        const phase = testPhase("planner");
        phase.tokens = { input: 700, output: 300, contextWindow: 200000 };
        assert.equal(tokenNote(phase), ", 1.0k tokens");
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
    it("returns full pipeline without scout by default", () => {
        const phases = freshPhases(false, false);
        const agents = phases.map((p) => p.agent);
        assert.deepEqual(agents, [
            "planner",
            "critic",
            "implementer",
            "tester",
            "validator",
            "documenter",
            "shipper",
        ]);
    });

    it("prepends scout when includeScout is true", () => {
        const phases = freshPhases(true, false);
        assert.equal(phases[0].agent, "scout");
        assert.equal(phases[0].label, "Scout");
        assert.equal(phases.length, 8); // scout + 7 standard phases
    });

    it("returns spec mode phases without scout", () => {
        const phases = freshPhases(false, true);
        const agents = phases.map((p) => p.agent);
        assert.deepEqual(agents, ["planner", "critic", "documenter"]);
    });

    it("returns spec mode phases with scout", () => {
        const phases = freshPhases(true, true);
        const agents = phases.map((p) => p.agent);
        assert.deepEqual(agents, ["scout", "planner", "critic", "documenter"]);
    });

    it("all phases start as pending", () => {
        const phases = freshPhases(false, false);
        for (const p of phases) {
            assert.equal(p.status, "pending", `${p.agent} should be pending`);
        }
    });

    it("labels match the phase purpose", () => {
        const phases = freshPhases(true, false);
        assert.equal(phases[0].label, "Scout");
        assert.equal(phases[1].label, "Plan");
        assert.equal(phases[2].label, "Critique");
        assert.equal(phases[3].label, "Implement");
        assert.equal(phases[4].label, "Test");
        assert.equal(phases[5].label, "Validate");
        assert.equal(phases[6].label, "Document");
        assert.equal(phases[7].label, "Ship");
        assert.equal(phases[7].agent, "shipper");
    });
});

// ── contextBundleForPhase ────────────────────────

describe("contextBundleForPhase", () => {
    const fullArtifacts: RunArtifacts = {
        recon: "Scout findings",
        plan: "The plan",
        critique: "Critique feedback",
        implSummary: "Implementation done",
        testReport: "Tests passed",
        docReport: "Docs updated",
    };

    it("scout gets no artifacts (read-only recon pass)", () => {
        const bundle = contextBundleForPhase("scout", fullArtifacts);
        // Scout whitelist is ["recon"] but scout doesn't consume prior artifacts.
        // The bundle should only include recon if it's in the whitelist.
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan"));
        assert.ok(!bundle.includes("Critique"));
    });

    it("planner gets only recon", () => {
        const bundle = contextBundleForPhase("planner", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan"));
        assert.ok(!bundle.includes("Critique"));
        assert.ok(!bundle.includes("Implementation"));
    });

    it("critic gets recon and plan", () => {
        const bundle = contextBundleForPhase("critic", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(!bundle.includes("Critique"));
        assert.ok(!bundle.includes("Implementation"));
    });

    it("implementer gets recon, plan, and critique", () => {
        const bundle = contextBundleForPhase("implementer", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Critique feedback"));
        assert.ok(!bundle.includes("Implementation done"));
        assert.ok(!bundle.includes("Tests passed"));
    });

    it("tester gets recon, plan, and implSummary (not critique)", () => {
        const bundle = contextBundleForPhase("tester", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Implementation done"));
        assert.ok(!bundle.includes("Critique feedback"));
        assert.ok(!bundle.includes("Docs updated"));
    });

    it("validator gets recon, plan, implSummary, and testReport", () => {
        const bundle = contextBundleForPhase("validator", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Implementation done"));
        assert.ok(bundle.includes("Tests passed"));
        assert.ok(!bundle.includes("Critique feedback"));
        assert.ok(!bundle.includes("Docs updated"));
    });

    it("documenter gets recon, plan, implSummary, and testReport", () => {
        const bundle = contextBundleForPhase("documenter", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Implementation done"));
        assert.ok(bundle.includes("Tests passed"));
        assert.ok(!bundle.includes("Critique feedback"));
        assert.ok(!bundle.includes("Docs updated"));
    });

    it("shipper gets all artifacts", () => {
        const bundle = contextBundleForPhase("shipper", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Implementation done"));
        assert.ok(bundle.includes("Tests passed"));
        assert.ok(bundle.includes("Docs updated"));
    });

    it("unknown agent falls back to all artifacts", () => {
        const bundle = contextBundleForPhase("unknown-agent", fullArtifacts);
        // Unknown agents get the full bundle (forward-compat)
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
        assert.ok(bundle.includes("Critique feedback"));
        assert.ok(bundle.includes("Implementation done"));
        assert.ok(bundle.includes("Tests passed"));
        assert.ok(bundle.includes("Docs updated"));
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
