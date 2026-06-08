import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    validatePlan,
    contextBundle,
    contextBundleForPhase,
    clampSummary,
    parsePlanPhases,
    buildPhaseMap,
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
    renderWorkflowFooter,
    parseAgentFile,
    subagentExtArgs,
    loadSkills,
    sessionLabel,
    resolveAgentModel,
    agentModelEnvVar,
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

    it("refiner gets an empty bundle (refineTask threads both the draft plan and recon inline)", () => {
        const bundle = contextBundleForPhase("refiner", fullArtifacts);
        // refineTask already carries the plan AND the recon, so the bundle must
        // add nothing — otherwise the recon brief is duplicated.
        assert.equal(bundle, "");
    });

    it("implementer gets recon (it writes code across the codebase), not plan/review", () => {
        const bundle = contextBundleForPhase("implementer", fullArtifacts);
        assert.ok(bundle.includes("Scout findings"));
        assert.ok(!bundle.includes("The plan")); // threaded inline by implementTask
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

    it("shipper gets plan and implSummary, but not recon", () => {
        const bundle = contextBundleForPhase("shipper", fullArtifacts);
        assert.ok(!bundle.includes("Scout findings"));
        assert.ok(bundle.includes("The plan"));
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
    const KEYS = ["PI_DISPATCH_DEPTH", "PI_DISPATCH_ANCESTRY"];
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
});

describe("subagentExtArgs", () => {
    it("returns [] for an agent without a dispatch tool", () => {
        assert.deepEqual(subagentExtArgs("read,write,grep,find,ls"), []);
    });
    it("passes -e dispatch.ts when tools include a dispatch tool", () => {
        const a = subagentExtArgs("read,dispatch_agent,ls");
        assert.equal(a[0], "-e");
        assert.ok(a[1].endsWith("extensions/dispatch.ts"), a[1]);
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
            sessionLabel("agent-workflow", "building", "add CSV export"),
            "agent-workflow · building · add CSV export",
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
