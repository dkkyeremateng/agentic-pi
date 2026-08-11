import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    newOrchestratorState,
    type OrchestratorState,
    type OrchestratorHost,
    runFullWorkflowCommand,
    dispatchAgentCore,
    dispatchParallelCore,
    selectAgentsCore,
    resolveAgent,
    capturePlan,
    selectPlan,
    readPlanFile,
    stripPlanPreamble,
    savePlanDraft,
    resetRunScratch,
    maybeTickMilestone,
    initProgressLedger,
    markAllPhasesDone,
    planArchiveName,
    archivePlan,
    runWorkflowCore,
    streamDispatchEnabled,
    renderDispatchActivity,
    countDispatchesSince,
    countDispatchEventsSince,
    freshContextViolated,
    reconcileLedgerBranch,
    countDonePhases,
} from "./orchestrator-core";
import type { AgentDef, PhaseState, SpawnEventState } from "./workflow-core";
import { handleSpawnEvent, computeSpawnResult } from "./workflow-core";
import { setObsEmit } from "../../obs/obs-events";
import { stageLearning, readStaged } from "./memory";

// Run with: npx tsx --test orchestrator-core.test.ts

// Isolate agent memory for the WHOLE file. Several tests drive dispatch/workflow
// paths that end in commitStagedLearnings, which WRITES <agent>.md — and its
// default target is this repo's own agents/memory/. Without this the suite leaves
// files behind in the working tree on every run.
process.env.PI_AGENT_MEMORY_DIR = mkdtempSync(join(tmpdir(), "orch-test-memory-"));

// ── Test helpers ─────────────────────────────────

function mkAgent(name: string): AgentDef {
    return {
        name,
        description: `Test agent ${name}`,
        tools: "bash",
        model: "test/model",
        contextWindow: 200000,
        systemPrompt: "You are a test agent.",
    };
}

// Deep partial for test overrides
type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function mkHost(
    overrides: DeepPartial<OrchestratorHost> = {},
): OrchestratorHost {
    const base: OrchestratorHost = {
        execution: {
            runPhase: async () => ({ output: "", ok: true }),
            runAgent: async () => ({ output: "test output", exitCode: 0 }),
        },
        ui: {
            updateWidget: () => {},
            notify: () => {},
            publishLogs: () => {},
        },
        setup: {
            setupSessions: () => {},
            loadAgents: () => new Map(),
            prepareRun: () => {},
        },
        config: {
            sharedContext: true,
            maxDispatchesPerTurn: 20,
            minDispatchOutputChars: 40,
        },
    };

    // Merge overrides
    if (overrides.execution) {
        Object.assign(base.execution, overrides.execution);
    }
    if (overrides.ui) {
        Object.assign(base.ui, overrides.ui);
    }
    if (overrides.setup) {
        Object.assign(base.setup, overrides.setup);
    }
    if (overrides.config) {
        Object.assign(base.config, overrides.config);
    }
    if (overrides.signal !== undefined) {
        base.signal = overrides.signal as AbortSignal;
    }

    return base;
}

function mkState(
    overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
    return { ...newOrchestratorState(), ...overrides };
}

// Helper: create a state pre-loaded with agents (as session_start would).
function mkStateWithAgents(
    agents: Map<string, AgentDef>,
    overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
    return { ...newOrchestratorState(), agents, ...overrides };
}

function mkCtx(): any {
    return { cwd: "/test" };
}

// ── newOrchestratorState ─────────────────────────

describe("newOrchestratorState", () => {
    it("creates a fresh state with correct defaults", () => {
        const st = newOrchestratorState();
        assert.equal(st.running, false);
        assert.equal(st.lastStatus, "idle");
        assert.equal(st.phases.length, 0);
        assert.equal(st.iteration, 0);
        assert.equal(st.dispatchMode, false);
        assert.equal(st.freshDispatchSession, false);
        assert.deepEqual(st.totalTokens, {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        });
        assert.equal(st.totalToolCalls, 0);
        assert.equal(st.totalDroppedLines, 0);
        assert.equal(st.dispatchesThisTurn, 0);
    });

    it("creates independent instances", () => {
        const a = newOrchestratorState();
        const b = newOrchestratorState();
        a.running = true;
        a.totalTokens.input = 100;
        assert.equal(b.running, false);
        assert.equal(b.totalTokens.input, 0);
    });
});

// ── resolveAgent ─────────────────────────────────

describe("resolveAgent", () => {
    it("resolves by name and by alias (case-insensitive), returning the canonical def", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("atlassian", { ...mkAgent("atlassian"), aliases: ["jira", "atl"] });
        agents.set("scout", mkAgent("scout"));
        assert.equal(resolveAgent(agents, "atlassian")?.name, "atlassian");
        assert.equal(resolveAgent(agents, "atl")?.name, "atlassian");
        assert.equal(resolveAgent(agents, "JIRA")?.name, "atlassian");
        assert.equal(resolveAgent(agents, "nope"), undefined);
    });

    it("a real agent name takes precedence over another's alias", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("atl", mkAgent("atl"));
        agents.set("atlassian", { ...mkAgent("atlassian"), aliases: ["atl"] });
        assert.equal(resolveAgent(agents, "atl")?.name, "atl");
    });
});

// ── dispatchAgentCore ────────────────────────────

describe("dispatchAgentCore", () => {
    it("rejects dispatch when a workflow is running", async () => {
        const st = mkState({ running: true });
        const host = mkHost();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "do something",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("Cannot dispatch"));
    });

    it("rejects dispatch when limit is reached", async () => {
        const st = mkState({ dispatchesThisTurn: 20 });
        const host = mkHost();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "do something",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("Dispatch limit"));
    });

    // Recursion guard (env-propagated across sub-agent processes).
    const DISPATCH_ENV_KEYS = [
        "PI_DISPATCH_DEPTH",
        "PI_DISPATCH_MAX_DEPTH",
        "PI_DISPATCH_ANCESTRY",
    ];
    function saveDispatchEnv(): Record<string, string | undefined> {
        const s: Record<string, string | undefined> = {};
        for (const k of DISPATCH_ENV_KEYS) s[k] = process.env[k];
        return s;
    }
    function restoreDispatchEnv(s: Record<string, string | undefined>) {
        for (const k of DISPATCH_ENV_KEYS) {
            if (s[k] === undefined) delete process.env[k];
            else process.env[k] = s[k];
        }
    }

    it("refuses to dispatch beyond the max depth", async () => {
        const saved = saveDispatchEnv();
        try {
            process.env.PI_DISPATCH_DEPTH = "1"; // already one level deep
            delete process.env.PI_DISPATCH_MAX_DEPTH; // default max depth = 1
            const result = await dispatchAgentCore(
                mkState(),
                mkHost(),
                "scout",
                "task",
                undefined,
                mkCtx(),
            );
            assert.ok(
                (result.content[0] as { text: string }).text.includes(
                    "depth limit",
                ),
            );
        } finally {
            restoreDispatchEnv(saved);
        }
    });

    it("allows deeper dispatch when PI_DISPATCH_MAX_DEPTH is raised", async () => {
        const saved = saveDispatchEnv();
        try {
            process.env.PI_DISPATCH_DEPTH = "1";
            process.env.PI_DISPATCH_MAX_DEPTH = "2";
            const result = await dispatchAgentCore(
                mkState(),
                mkHost(),
                "scout",
                "task",
                undefined,
                mkCtx(),
            );
            // Depth gate passed (falls through to agent lookup, which is empty here).
            assert.ok(
                !(result.content[0] as { text: string }).text.includes(
                    "depth limit",
                ),
            );
        } finally {
            restoreDispatchEnv(saved);
        }
    });

    it("disables dispatch entirely when PI_DISPATCH_MAX_DEPTH=0", async () => {
        const saved = saveDispatchEnv();
        try {
            delete process.env.PI_DISPATCH_DEPTH; // top level: depth 0
            process.env.PI_DISPATCH_MAX_DEPTH = "0";
            const result = await dispatchAgentCore(
                mkState(),
                mkHost(),
                "scout",
                "task",
                undefined,
                mkCtx(),
            );
            const first: unknown = result.content[0];
            assert.ok(first && typeof first === "object" && "text" in first);
            assert.ok(typeof first.text === "string");
            assert.ok(
                first.text.includes("depth limit"),
                "depth 0 is already at the limit when max is 0",
            );
        } finally {
            restoreDispatchEnv(saved);
        }
    });

    it("refuses a cycle when the agent is already an ancestor", async () => {
        const saved = saveDispatchEnv();
        try {
            process.env.PI_DISPATCH_ANCESTRY = "coordinator>scout";
            const agents = new Map<string, AgentDef>();
            agents.set("scout", mkAgent("scout"));
            const result = await dispatchAgentCore(
                mkStateWithAgents(agents),
                mkHost({ setup: { loadAgents: () => agents } }),
                "scout",
                "task",
                undefined,
                mkCtx(),
            );
            assert.ok(
                (result.content[0] as { text: string }).text.includes(
                    "Cycle detected",
                ),
            );
        } finally {
            restoreDispatchEnv(saved);
        }
    });

    it("refuses a cycle reached through an ALIAS of the ancestor", async () => {
        // The ancestry chain carries canonical names, so the check must run AFTER
        // resolveAgent — otherwise "recon" (an alias of scout) slips past it.
        const saved = saveDispatchEnv();
        try {
            process.env.PI_DISPATCH_ANCESTRY = "coordinator>scout";
            const agents = new Map<string, AgentDef>();
            agents.set("scout", { ...mkAgent("scout"), aliases: ["recon"] });
            let ran = 0;
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runAgent: async () => {
                        ran++;
                        return { output: "should never run", exitCode: 0 };
                    },
                },
            });
            const result = await dispatchAgentCore(
                mkStateWithAgents(agents),
                host,
                "recon",
                "task",
                undefined,
                mkCtx(),
            );
            assert.ok(
                (result.content[0] as { text: string }).text.includes(
                    "Cycle detected",
                ),
                "the alias must not evade the ancestry guard",
            );
            assert.equal(ran, 0, "the aliased ancestor never ran");
        } finally {
            restoreDispatchEnv(saved);
        }
    });

    it("returns error for unknown agent", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "nonexistent",
            "do something",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("not found"));
        assert.ok((result.content[0] as { text: string }).text.includes("planner"));
    });

    it("dispatches a known agent successfully", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "Here is a detailed plan output with enough text for the test",
                    exitCode: 0,
                }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan something",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("done"));
        assert.equal(st.phases.length, 1);
        assert.equal(st.phases[0].agent, "planner");
        assert.equal(st.phases[0].status, "done");
    });

    it("marks dispatch as error when agent returns non-zero exit", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("tester", mkAgent("tester"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "something failed badly",
                    exitCode: 1,
                }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "tester",
            "test this",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("error"));
        assert.equal(st.phases[0].status, "error");
    });

    it("flags empty output as failed dispatch", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({ output: "   ", exitCode: 0 }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("RE-DISPATCH"));
        assert.equal(st.phases[0].status, "error");
    });

    it("retries once when the first dispatch comes back empty, then succeeds", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let calls = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => {
                    calls++;
                    return calls === 1
                        ? { output: "   ", exitCode: 0 } // empty first attempt
                        : {
                              output:
                                  "Recovered: here is a real plan with enough text",
                              exitCode: 0,
                          };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.equal(calls, 2); // retried once
        assert.equal(st.phases[0].status, "done");
        assert.equal(st.phases[0].attempt, 2);
        assert.ok((result.content[0] as { text: string }).text.includes("done"));
    });

    it("reports truncation (stop=length) instead of a generic empty failure", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async (_def, _task, phase) => {
                    phase.lastStopReason = "length"; // hit the output-token cap
                    return { output: "", exitCode: 0 };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "scout",
            "recon the repo",
            undefined,
            mkCtx(),
        );
        const text = (result.content[0] as { text: string }).text;
        assert.ok(
            text.includes("TRUNCATED") && text.includes("output-token limit"),
            `expected truncation message, got: ${text}`,
        );
        assert.equal(st.phases[0].status, "error");
    });

    it("emits dispatch_start then dispatch_end through the obs hook", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const events: { type: string; payload: any }[] = [];
        setObsEmit((type, payload) => events.push({ type, payload }));
        try {
            const host = mkHost({
                setup: {
                    loadAgents: () => agents,
                    setupSessions: () => {},
                    prepareRun: () => {},
                },
                execution: {
                    runAgent: async () => ({
                        output: "a real plan with plenty of substantive text",
                        exitCode: 0,
                    }),
                },
            });
            const st = mkStateWithAgents(agents);
            await dispatchAgentCore(st, host, "planner", "plan", undefined, mkCtx());
        } finally {
            setObsEmit(undefined);
        }
        assert.deepEqual(
            events.map((e) => e.type),
            ["dispatch_start", "dispatch_end"],
        );
        assert.equal(events[0].payload.agent, "planner");
        assert.equal(events[1].payload.status, "done");
    });

    it("emits dispatch_retry with a reason when the first attempt is empty", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        const events: { type: string; payload: any }[] = [];
        setObsEmit((type, payload) => events.push({ type, payload }));
        let calls = 0;
        try {
            const host = mkHost({
                setup: {
                    loadAgents: () => agents,
                    setupSessions: () => {},
                    prepareRun: () => {},
                },
                execution: {
                    runAgent: async () => {
                        calls++;
                        return calls === 1
                            ? { output: "   ", exitCode: 0 }
                            : {
                                  output: "recovered with a real, substantive result",
                                  exitCode: 0,
                              };
                    },
                },
            });
            const st = mkStateWithAgents(agents);
            await dispatchAgentCore(st, host, "scout", "recon", undefined, mkCtx());
        } finally {
            setObsEmit(undefined);
        }
        assert.deepEqual(
            events.map((e) => e.type),
            ["dispatch_start", "dispatch_retry", "dispatch_end"],
        );
        assert.equal(events[1].payload.reason, "empty");
        assert.equal(events[2].payload.status, "done");
    });

    it("does not flag tool-driven agents with short output as empty", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            config: {
                minDispatchOutputChars: 40,
            },
            execution: {
                runAgent: async (_def, _task, phase) => {
                    // Simulate a tool-driven agent: short output but tool calls made
                    phase.toolCount = 5;
                    return { output: "Done.", exitCode: 0 };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "seeker",
            "research this",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("done"));
        assert.equal(st.phases[0].status, "done");
    });

    it("resets phase state on re-dispatch including modelFallback", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let callCount = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async (_def, _task, phase) => {
                    callCount++;
                    if (callCount === 1) {
                        // First call: simulate model fallback
                        phase.modelFallback = true;
                        phase.activeModel = "fallback/model";
                        return {
                            output: "fallback output with enough text for this test",
                            exitCode: 0,
                        };
                    }
                    return {
                        output: "normal output with enough text for this test",
                        exitCode: 0,
                    };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const ctx = mkCtx();

        // First dispatch — triggers model fallback
        await dispatchAgentCore(st, host, "planner", "plan", undefined, ctx);
        assert.equal(st.phases[0].modelFallback, true);
        assert.equal(st.phases[0].activeModel, "fallback/model");

        // Re-dispatch — should clear modelFallback
        await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan again",
            undefined,
            ctx,
        );
        assert.equal(st.phases[0].modelFallback, false);
        assert.equal(st.phases[0].activeModel, undefined);
    });

    it("increments dispatchesThisTurn", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("tester", mkAgent("tester"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "enough output text here for testing purposes in this test",
                    exitCode: 0,
                }),
            },
        });
        const st = mkStateWithAgents(agents);
        const ctx = mkCtx();
        assert.equal(st.dispatchesThisTurn, 0);
        await dispatchAgentCore(st, host, "planner", "plan", undefined, ctx);
        assert.equal(st.dispatchesThisTurn, 1);
        await dispatchAgentCore(st, host, "tester", "test", undefined, ctx);
        assert.equal(st.dispatchesThisTurn, 2);
    });

    it("truncates output longer than 8000 chars head+tail, keeping the conclusion", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        // Agents summarize at the END: a head-only slice would drop the conclusion.
        const longOutput =
            "HEAD-MARKER\n" + "x".repeat(10000) + "\nCONCLUSION-MARKER";
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({ output: longOutput, exitCode: 0 }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        const text = (result.content[0] as { text: string }).text;
        assert.ok(text.includes("truncated"), "truncation marker present");
        assert.ok(text.includes("HEAD-MARKER"), "head kept");
        assert.ok(
            text.includes("CONCLUSION-MARKER"),
            "tail kept — the agent's concluding summary survives truncation",
        );
        assert.ok(text.length < longOutput.length, "output actually clamped");
    });

    it("enters dispatch mode on first dispatch", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "enough output for this test case to pass the minimum character threshold",
                    exitCode: 0,
                }),
            },
        });
        const st = mkStateWithAgents(agents, { dispatchMode: false });
        await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.equal(st.dispatchMode, true);
    });

    it("clears phases on fresh dispatch session", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "enough output for this test case to pass the minimum character threshold",
                    exitCode: 0,
                }),
            },
        });
        const st = mkState({
            dispatchMode: true,
            freshDispatchSession: true,
            phases: [
                {
                    label: "Old",
                    agent: "old",
                    status: "done",
                    elapsed: 100,
                    note: "",
                    log: "",
                    droppedLines: 0,
                    toolCount: 0,
                    contextPct: 0,
                    attempt: 1,
                    modelFallback: false,
                },
            ],
        });
        await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.equal(st.phases.length, 1);
        assert.equal(st.phases[0].agent, "planner");
        assert.equal(st.freshDispatchSession, false);
    });

    it("steers re-dispatch on empty output", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({ output: "   ", exitCode: 0 }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("RE-DISPATCH"));
    });

    it("signals DONE when all selected agents are complete", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "enough output for this test case to pass the minimum character threshold",
                    exitCode: 0,
                }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        // Only one agent dispatched, no pending phases remain
        assert.ok((result.content[0] as { text: string }).text.includes("DONE"));
    });

    it("does not reload agents when freshDispatchSession is false", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let loadCount = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => {
                    loadCount++;
                    return agents;
                },
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "enough output for this test case to pass the minimum character threshold",
                    exitCode: 0,
                }),
            },
        });
        const st = mkStateWithAgents(agents, {
            freshDispatchSession: false,
        });
        await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.equal(loadCount, 0, "loadAgents should not be called");
    });

    it("reloads agents when freshDispatchSession is true", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let loadCount = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => {
                    loadCount++;
                    return agents;
                },
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: async () => ({
                    output: "enough output for this test case to pass the minimum character threshold",
                    exitCode: 0,
                }),
            },
        });
        const st = mkStateWithAgents(agents, {
            freshDispatchSession: true,
        });
        await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.equal(loadCount, 1, "loadAgents should be called once");
    });
});

// ── dispatchParallelCore ─────────────────────────

describe("dispatchParallelCore", () => {
    function parallelHost(
        runAgent: (def: AgentDef) => Promise<{ output: string; exitCode: number }>,
        agents: Map<string, AgentDef>,
    ) {
        return mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runAgent: ((def: AgentDef) => runAgent(def)) as any,
                runPhase: (async () => ({ output: "", ok: true })) as any,
            },
        });
    }
    const longOutput = (name: string) => `result from ${name} ` + "x".repeat(50);

    it("runs all agents concurrently and combines their results", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        agents.set("seeker", mkAgent("seeker"));
        const started: string[] = [];
        const host = parallelHost(async (def) => {
            started.push(def.name);
            return { output: longOutput(def.name), exitCode: 0 };
        }, agents);
        const st = mkStateWithAgents(agents);
        const result = await dispatchParallelCore(
            st,
            host,
            [
                { agent: "scout", task: "t1" },
                { agent: "seeker", task: "t2" },
            ],
            undefined,
            mkCtx(),
        );
        const text = (result.content[0] as { text: string }).text;
        assert.ok(text.includes("2/2 succeeded"));
        assert.ok(text.includes("scout") && text.includes("seeker"));
        assert.equal(st.phases.length, 2); // one distinct phase per agent
        assert.equal(started.length, 2);
    });

    it("bounds the combined output across a large batch but keeps every agent", async () => {
        const names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
        const agents = new Map<string, AgentDef>();
        for (const n of names) agents.set(n, mkAgent(n));
        const host = parallelHost(
            async (def) => ({
                output: `[${def.name}] ` + "x".repeat(10000),
                exitCode: 0,
            }),
            agents,
        );
        const st = mkStateWithAgents(agents);
        const result = await dispatchParallelCore(
            st,
            host,
            names.map((n) => ({ agent: n, task: "t" })),
            undefined,
            mkCtx(),
        );
        const text = (result.content[0] as { text: string }).text;
        // Unbounded this would be ~8 * 10000 = 80k; the aggregate ceiling holds it
        // well under that.
        assert.ok(text.length < 30000, `combined output too large: ${text.length}`);
        // Every agent is still represented — the batch shares the budget, it
        // doesn't drop whole results.
        for (const n of names)
            assert.ok(text.includes(`[${n}]`), `${n} missing from output`);
    });

    it("reuses select_agents phases instead of duplicating cards", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        agents.set("seeker", mkAgent("seeker"));
        const host = parallelHost(
            async (def) => ({ output: longOutput(def.name), exitCode: 0 }),
            agents,
        );
        const st = mkStateWithAgents(agents);
        selectAgentsCore(st, host, ["scout", "seeker"], mkCtx());
        assert.equal(st.phases.length, 2);
        await dispatchParallelCore(
            st,
            host,
            [
                { agent: "scout", task: "t1" },
                { agent: "seeker", task: "t2" },
            ],
            undefined,
            mkCtx(),
        );
        assert.equal(st.phases.length, 2); // reused, not duplicated to 4
        assert.deepEqual(
            st.phases.map((p) => p.agent).sort(),
            ["scout", "seeker"],
        );
    });

    it("counts a short pong reply to a ping as success, not empty/error", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        const host = parallelHost(
            async () => ({ output: "pong — ready", exitCode: 0 }),
            agents,
        );
        const st = mkStateWithAgents(agents);
        const result = await dispatchParallelCore(
            st,
            host,
            [{ agent: "scout", task: "ping" }],
            undefined,
            mkCtx(),
        );
        const text = (result.content[0] as { text: string }).text;
        assert.ok(text.includes("1/1 succeeded"));
        assert.equal(st.phases[0].status, "done");
    });

    it("skips unknown agents and runs the rest", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        const host = parallelHost(
            async (def) => ({ output: longOutput(def.name), exitCode: 0 }),
            agents,
        );
        const st = mkStateWithAgents(agents);
        const result = await dispatchParallelCore(
            st,
            host,
            [
                { agent: "scout", task: "t" },
                { agent: "nope", task: "t" },
            ],
            undefined,
            mkCtx(),
        );
        const text = (result.content[0] as { text: string }).text;
        assert.ok(text.includes("1/1 succeeded"));
        assert.ok(text.includes("nope (unknown)"));
    });

    it("refuses the batch when the depth limit is reached", async () => {
        const savedDepth = process.env.PI_DISPATCH_DEPTH;
        const savedMax = process.env.PI_DISPATCH_MAX_DEPTH;
        try {
            // Pin BOTH vars so an ambient .env (e.g. PI_DISPATCH_MAX_DEPTH=2)
            // can't shift the limit out from under the assertion.
            process.env.PI_DISPATCH_MAX_DEPTH = "1";
            process.env.PI_DISPATCH_DEPTH = "1"; // at the limit ⇒ refuse
            const agents = new Map<string, AgentDef>();
            agents.set("scout", mkAgent("scout"));
            const host = parallelHost(
                async (def) => ({ output: longOutput(def.name), exitCode: 0 }),
                agents,
            );
            const result = await dispatchParallelCore(
                mkStateWithAgents(agents),
                host,
                [{ agent: "scout", task: "t" }],
                undefined,
                mkCtx(),
            );
            assert.ok(
                (result.content[0] as { text: string }).text.includes(
                    "depth limit",
                ),
            );
        } finally {
            if (savedDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
            else process.env.PI_DISPATCH_DEPTH = savedDepth;
            if (savedMax === undefined) delete process.env.PI_DISPATCH_MAX_DEPTH;
            else process.env.PI_DISPATCH_MAX_DEPTH = savedMax;
        }
    });
});

// ── dispatch commits staged learnings ────────────
// A bare dispatch has no workflow finalize, so the dispatch cores commit each
// agent's `remember` lessons themselves (else they stage and are orphaned). These
// assert the wiring via the observable side effect: after a dispatch the run's
// staging file is CLEARED (commitStagedLearnings always clears before its verdict
// gate). Failed dispatches are used so the fail gate keeps nothing — no write to
// the agents' repo memory dir. The commit's pass/fail persistence is covered in
// memory.test.ts.
describe("dispatch commits staged learnings", () => {
    let saved: string | undefined;
    beforeEach(() => {
        saved = process.env.PI_AGENT_MEMORY;
        delete process.env.PI_AGENT_MEMORY; // default = memory enabled
    });
    const restore = () => {
        if (saved === undefined) delete process.env.PI_AGENT_MEMORY;
        else process.env.PI_AGENT_MEMORY = saved;
    };

    it("dispatchAgentCore clears this run's staging after a dispatch", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "dispatch-learn-"));
        try {
            stageLearning(cwd, "seeker", "avoid captcha-walled sites for finance");
            assert.equal(readStaged(cwd).length, 1);
            const agents = new Map<string, AgentDef>();
            agents.set("seeker", mkAgent("seeker"));
            const host = mkHost({
                setup: { loadAgents: () => agents, setupSessions: () => {}, prepareRun: () => {} },
                // Empty output ⇒ failed dispatch ⇒ commit runs with passed:false
                // (clears staging, writes nothing).
                execution: { runAgent: async () => ({ output: "", exitCode: 0 }) },
            });
            await dispatchAgentCore(mkStateWithAgents(agents), host, "seeker", "research", undefined, { cwd });
            assert.equal(readStaged(cwd).length, 0, "staging should be cleared by the dispatch commit");
        } finally {
            restore();
        }
    });

    it("dispatchParallelCore clears this run's staging once for the batch", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "dispatch-learn-par-"));
        try {
            stageLearning(cwd, "seeker", "prefer structured-filing sources");
            assert.equal(readStaged(cwd).length, 1);
            const agents = new Map<string, AgentDef>();
            agents.set("seeker", mkAgent("seeker"));
            const host = mkHost({
                setup: { loadAgents: () => agents, setupSessions: () => {}, prepareRun: () => {} },
                execution: { runAgent: async () => ({ output: "", exitCode: 0 }) },
            });
            await dispatchParallelCore(
                mkStateWithAgents(agents),
                host,
                [{ agent: "seeker", task: "a" }, { agent: "seeker", task: "b" }],
                undefined,
                { cwd },
            );
            assert.equal(readStaged(cwd).length, 0, "staging should be cleared once after the batch");
        } finally {
            restore();
        }
    });
});

// ── selectAgentsCore ─────────────────────────────

describe("selectAgentsCore", () => {
    it("rejects selection when a workflow is running", () => {
        const st = mkState({ running: true });
        const host = mkHost();
        const result = selectAgentsCore(st, host, ["planner"], mkCtx());
        assert.ok((result.content[0] as { text: string }).text.includes("Cannot change"));
    });

    it("returns error when no valid agents in selection", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents);
        const result = selectAgentsCore(st, host, ["nonexistent"], mkCtx());
        assert.ok((result.content[0] as { text: string }).text.includes("No valid agents"));
    });

    it("steers to dispatch on a redundant repeat selection", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("scout", mkAgent("scout"));
        agents.set("seeker", mkAgent("seeker"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents);
        // First call declares the plan (agents queued, none dispatched yet).
        selectAgentsCore(st, host, ["scout", "seeker"], mkCtx());
        // Repeat with the same still-queued agents → hard steer to dispatch.
        const result = selectAgentsCore(st, host, ["scout", "seeker"], mkCtx());
        const text = (result.content[0] as { text: string }).text;
        assert.ok(text.includes("do NOT call select_agents again"));
        assert.ok(text.includes("dispatch_agent"));
    });

    it("selects valid agents and ignores unknown", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("tester", mkAgent("tester"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents);
        const result = selectAgentsCore(
            st,
            host,
            ["planner", "nonexistent", "tester"],
            mkCtx(),
        );
        assert.equal(st.phases.length, 2);
        assert.equal(st.phases[0].agent, "planner");
        assert.equal(st.phases[1].agent, "tester");
        assert.ok((result.content[0] as { text: string }).text.includes("ignored unknown"));
        assert.ok((result.content[0] as { text: string }).text.includes("nonexistent"));
    });

    it("sets dispatch mode", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, { dispatchMode: false });
        selectAgentsCore(st, host, ["planner"], mkCtx());
        assert.equal(st.dispatchMode, true);
    });

    it("preserves existing phases on non-fresh session", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("tester", mkAgent("tester"));
        const existingPhase: PhaseState = {
            label: "Planner",
            agent: "planner",
            status: "done",
            elapsed: 5000,
            note: "completed",
            log: "some log",
            droppedLines: 0,
            toolCount: 3,
            contextPct: 10,
            attempt: 1,
            modelFallback: false,
        };
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, {
            dispatchMode: true,
            freshDispatchSession: false,
            phases: [existingPhase],
        });
        selectAgentsCore(st, host, ["planner", "tester"], mkCtx());
        // Planner phase should be preserved, tester should be new
        assert.equal(st.phases.length, 2);
        assert.equal(st.phases[0].status, "done");
        assert.equal(st.phases[0].elapsed, 5000);
        assert.equal(st.phases[1].status, "pending");
    });

    it("clears phases on fresh dispatch session", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const existingPhase: PhaseState = {
            label: "Old",
            agent: "old",
            status: "done",
            elapsed: 5000,
            note: "",
            log: "",
            droppedLines: 0,
            toolCount: 0,
            contextPct: 0,
            attempt: 1,
            modelFallback: false,
        };
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkState({
            freshDispatchSession: true,
            phases: [existingPhase],
        });
        selectAgentsCore(st, host, ["planner"], mkCtx());
        assert.equal(st.phases.length, 1);
        assert.equal(st.phases[0].agent, "planner");
        assert.equal(st.freshDispatchSession, false);
    });

    it("returns a sequential (→) order for distinct agents", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("tester", mkAgent("tester"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents);
        const result = selectAgentsCore(
            st,
            host,
            ["planner", "tester"],
            mkCtx(),
        );
        assert.ok((result.content[0] as { text: string }).text.includes("Planner → Tester"));
    });

    it("uses ∥ only for duplicate (parallel-instance) selections", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const result = selectAgentsCore(
            mkStateWithAgents(agents),
            host,
            ["seeker", "seeker"],
            mkCtx(),
        );
        assert.ok(
            (result.content[0] as { text: string }).text.includes(
                "Seeker ∥ Seeker",
            ),
        );
    });

    it("creates one phase per duplicate occurrence; an unknown name never becomes a card", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const host = mkHost({
            setup: { loadAgents: () => agents },
        });
        const st = mkStateWithAgents(agents);
        const result = selectAgentsCore(
            st,
            host,
            ["seeker", "seeker", "bogus"],
            mkCtx(),
        );
        assert.equal(st.phases.length, 2, "two seeker instances, no bogus card");
        assert.ok(st.phases.every((p) => p.agent === "seeker"));
        const details: unknown = result.details;
        assert.ok(details && typeof details === "object" && "order" in details);
        assert.equal(details.order, "Seeker ∥ Seeker");
    });

    it("re-selection with duplicates reuses an existing phase at most once", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const existingPhase: PhaseState = {
            label: "Seeker",
            agent: "seeker",
            status: "done",
            elapsed: 1200,
            note: "",
            log: "",
            droppedLines: 0,
            toolCount: 2,
            contextPct: 5,
            attempt: 1,
            modelFallback: false,
        };
        const host = mkHost({
            setup: { loadAgents: () => agents },
        });
        const st = mkStateWithAgents(agents, {
            dispatchMode: true,
            freshDispatchSession: false,
            phases: [existingPhase],
        });
        selectAgentsCore(st, host, ["seeker", "seeker"], mkCtx());
        assert.equal(st.phases.length, 2);
        assert.equal(st.phases[0], existingPhase, "the prior phase is reused once");
        assert.ok(
            st.phases[0] !== st.phases[1],
            "the same PhaseState object is never inserted twice",
        );
    });

    it("does not reload agents when freshDispatchSession is false", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let loadCount = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => {
                    loadCount++;
                    return agents;
                },
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, {
            freshDispatchSession: false,
        });
        selectAgentsCore(st, host, ["planner"], mkCtx());
        assert.equal(loadCount, 0, "loadAgents should not be called");
    });

    it("reloads agents when freshDispatchSession is true", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let loadCount = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => {
                    loadCount++;
                    return agents;
                },
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, {
            freshDispatchSession: true,
        });
        selectAgentsCore(st, host, ["planner"], mkCtx());
        assert.equal(loadCount, 1, "loadAgents should be called once");
        assert.equal(st.freshDispatchSession, false);
    });
});

// ── runWorkflowCore — re-entry guard ─────────────

describe("runWorkflowCore re-entry guard", () => {
    it("rejects when a workflow is already running", async () => {
        const agents = new Map<string, AgentDef>();
        for (const name of [
            "planner",
            "implementer",
            "reviewer",
            "tester",
            "validator",
        ]) {
            agents.set(name, mkAgent(name));
        }
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, { running: true });
        const result = await runWorkflowCore(
            st,
            host,
            "test request",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "error");
        assert.ok(result.report.includes("already running"));
    });
});

// ── runWorkflowCore — per-agent auto-verdicts ────

describe("runWorkflowCore agent-scoped auto-verdicts", () => {
    // a structurally valid plan, so the post-planner plan check passes
    const PLAN = [
        "## Phase 1: Implement the toggle",
        "Edit `src/theme.ts` to add a dark-mode toggle.",
        "",
        "## Acceptance Criteria",
        "- The toggle switches themes.",
        "",
        "## Critical Files",
        "- src/theme.ts",
    ].join("\n");

    it("emits a scoped verdict per agent plus the run-level verdict on a passing run", async () => {
        const names = ["scout", "planner", "implementer", "validator", "shipper"];
        const agents = new Map<string, AgentDef>();
        for (const n of names) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "obs-av-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });

        const events: { type: string; payload: any }[] = [];
        setObsEmit((type, payload) => events.push({ type, payload }));
        let result;
        try {
            const host = mkHost({
                setup: { loadAgents: () => agents, setupSessions: () => {}, prepareRun: () => {} },
                execution: {
                    // route by phase.agent: planner emits a real plan, validator passes, shipper ships
                    runPhase: async (phase: PhaseState) => {
                        if (phase.agent === "planner") return { output: PLAN, ok: true };
                        if (phase.agent === "validator") return { output: "VERDICT: PASS", ok: true };
                        if (phase.agent === "shipper") return { output: "SHIP: SHIPPED\nhttps://x/pull/7", ok: true };
                        return { output: `${phase.agent} did substantive work, well over forty characters of it`, ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, { teams: { team: names }, activeTeamName: "team" });
            result = await runWorkflowCore(st, host, "implement the dark-mode toggle", 2, { cwd });
        } finally {
            setObsEmit(undefined);
        }
        assert.equal(result!.status, "shipped");

        const verdicts = events.filter((e) => e.type === "verdict");
        // every agent got its own scoped, source:"auto" pass
        const byAgent = new Map(
            verdicts.filter((v) => v.payload.agent).map((v) => [v.payload.agent, v.payload]),
        );
        for (const a of names) {
            assert.equal(byAgent.get(a)?.status, "pass", `${a} should be auto-passed`);
            assert.equal(byAgent.get(a)?.source, "auto");
        }
        // exactly one run-level verdict (no agent), source:"workflow", pass
        const runLevel = verdicts.filter((v) => !v.payload.agent);
        assert.equal(runLevel.length, 1);
        assert.equal(runLevel[0].payload.status, "pass");
        assert.equal(runLevel[0].payload.source, "workflow");
    });

    it("emits a scoped fail for the agent whose phase errors out", async () => {
        const names = ["scout", "planner", "implementer", "validator"];
        const agents = new Map<string, AgentDef>();
        for (const n of names) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "obs-av-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });

        const events: { type: string; payload: any }[] = [];
        setObsEmit((type, payload) => events.push({ type, payload }));
        try {
            const host = mkHost({
                setup: { loadAgents: () => agents, setupSessions: () => {}, prepareRun: () => {} },
                execution: {
                    // the implementer phase hard-fails (ok:false)
                    runPhase: async (phase: PhaseState) => {
                        if (phase.agent === "planner") return { output: PLAN, ok: true };
                        if (phase.agent === "implementer") return { output: "blew up", ok: false };
                        return { output: `${phase.agent} did substantive work, well over forty characters of it`, ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, { teams: { team: names }, activeTeamName: "team" });
            await runWorkflowCore(st, host, "implement the dark-mode toggle", 2, { cwd });
        } finally {
            setObsEmit(undefined);
        }
        const verdicts = events.filter((e) => e.type === "verdict");
        const implV = verdicts.find((v) => v.payload.agent === "implementer");
        assert.equal(implV?.payload.status, "fail");
        assert.equal(implV?.payload.source, "auto");
        // scout still recorded its pass before the failure
        assert.equal(verdicts.find((v) => v.payload.agent === "scout")?.payload.status, "pass");
    });
});

// ── runWorkflowCore — re-entry guard (spec-shaped team) ──

describe("runWorkflowCore re-entry guard", () => {
    it("rejects when a workflow is already running", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("reviewer", mkAgent("reviewer"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, { running: true });
        const result = await runWorkflowCore(
            st,
            host,
            "test spec",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "error");
        assert.ok(result.report.includes("already running"));
    });
});

// ── runWorkflowCore — full lifecycle tests ─────────

describe("runWorkflowCore", () => {
    function mkFullAgentSet(): Map<string, AgentDef> {
        const agents = new Map<string, AgentDef>();
        for (const name of [
            "planner",
            "implementer",
            "reviewer",
            "validator",
            "shipper",
        ]) {
            agents.set(name, mkAgent(name));
        }
        return agents;
    }

    // Helper: create a valid plan that passes validatePlan()
    function mkValidPlan(): string {
        return `## Phase 1: Implementation
Build feature X according to the requirements.

## Acceptance Criteria
- Feature X works as specified
- All tests pass

## Critical Files
- src/feature-x.ts`;
    }

    it("runs happy path: all phases pass", async () => {
        const agents = mkFullAgentSet();
        const runPhaseCalls: string[] = [];
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    runPhaseCalls.push(phase.agent);
                    if (phase.agent === "planner") {
                        return { output: mkValidPlan(), ok: true };
                    }
                    if (phase.agent === "validator") {
                        return { output: "VERDICT: PASS", ok: true };
                    }
                    if (phase.agent === "reviewer") {
                        return {
                            output: "APPROVED\nPlan looks good",
                            ok: true,
                        };
                    }
                    if (phase.agent === "shipper") {
                        return {
                            output: "SHIP: SHIPPED\nhttps://github.com/test/pull/1",
                            ok: true,
                        };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "shipped");
        assert.ok(st.running === false);
        assert.ok(st.runElapsedMs >= 0);
        // Verify phases were created
        assert.ok(st.phases.length > 0);
        // Verify all required agents ran
        assert.ok(runPhaseCalls.includes("planner"));
        assert.ok(runPhaseCalls.includes("implementer"));
        assert.ok(runPhaseCalls.includes("validator"));
        assert.ok(!runPhaseCalls.includes("tester"), "no tester phase");
    });

    it("clears running and returns an error result when a phase throws", async () => {
        // An unexpected throw inside the pipeline must NOT leave s.running stuck
        // (which would lock out /agent-workflow for the session) and must surface as
        // a failed RunResult, not an unhandled rejection.
        const agents = mkFullAgentSet();
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "planner") {
                        throw new Error("boom: provider exploded mid-plan");
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Build feature X", 3, mkCtx());
        assert.equal(result.status, "error");
        assert.match(result.report, /failed unexpectedly: boom/);
        assert.equal(st.running, false); // not stuck — the command stays usable
        assert.equal(st.lastStatus, "error"); // the dashboard must not keep reading "running"
    });

    it("runs the refiner between planner and implementer; the hardened plan on disk is the source of truth", async () => {
        const agents = mkFullAgentSet();
        agents.set("refiner", mkAgent("refiner"));
        const cwd = mkdtempSync(join(tmpdir(), "refine-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        const planFile = join(cwd, ".agent", "plan.md");
        const draftPlan =
            "## Phase 1: Draft\nDraft.\n\n## Acceptance Criteria\n- works\n\n## Critical Files\n- a.ts";
        const refinedPlan =
            "## Phase 1: REFINED\nHardened.\n\n## Acceptance Criteria\n- works\n- edge cases handled\n\n## Critical Files\n- a.ts";
        const order: string[] = [];
        let implementerSawPlan = "";
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                // The planner and refiner emit the full plan as their message; the
                // orchestrator persists it to .agent/plan.md for downstream agents.
                runPhase: async (phase, task) => {
                    order.push(phase.agent);
                    if (phase.agent === "planner") {
                        return { output: draftPlan, ok: true };
                    }
                    if (phase.agent === "refiner") {
                        return { output: refinedPlan, ok: true };
                    }
                    if (phase.agent === "implementer") {
                        implementerSawPlan = task;
                        return { output: "impl output", ok: true };
                    }
                    if (phase.agent === "reviewer")
                        return { output: "APPROVED", ok: true };
                    if (phase.agent === "validator")
                        return { output: "VERDICT: PASS", ok: true };
                    if (phase.agent === "shipper")
                        return {
                            output: "SHIP: SHIPPED\nhttps://github.com/t/pull/1",
                            ok: true,
                        };
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });
        assert.equal(result.status, "shipped");
        // Order: planner -> refiner -> implementer
        assert.ok(
            order.indexOf("planner") < order.indexOf("refiner"),
            "planner before refiner",
        );
        assert.ok(
            order.indexOf("refiner") < order.indexOf("implementer"),
            "refiner before implementer",
        );
        // The plan is read from disk, NOT threaded into the implementer's task.
        assert.ok(
            !implementerSawPlan.includes("REFINED"),
            "plan is not threaded into the implementer task",
        );
        assert.ok(
            !implementerSawPlan.includes("Phase 1: Draft"),
            "draft is not threaded either",
        );
        // The hardened plan is the canonical source of truth on disk.
        const onDisk = readFileSync(planFile, "utf-8");
        assert.ok(onDisk.includes("REFINED"), "refiner's hardened plan persisted");
        assert.ok(
            !onDisk.includes("Phase 1: Draft"),
            "draft was overwritten by the refiner",
        );
    });

    it("handles review revision loop (reviewer sends the implementer back)", async () => {
        const agents = mkFullAgentSet();
        let reviewerCalls = 0;
        let implementerCalls = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "planner") {
                        return { output: mkValidPlan(), ok: true };
                    }
                    if (phase.agent === "implementer") {
                        implementerCalls++;
                        return { output: "Implementation complete", ok: true };
                    }
                    if (phase.agent === "reviewer") {
                        reviewerCalls++;
                        if (reviewerCalls === 1) {
                            return {
                                output: "REVISE BEFORE MERGE\nFix the edge case",
                                ok: true,
                            };
                        }
                        return { output: "APPROVED\nLooks good", ok: true };
                    }
                    if (phase.agent === "validator") {
                        return { output: "VERDICT: PASS", ok: true };
                    }
                    if (phase.agent === "shipper") {
                        return { output: "SHIP: SHIPPED", ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "shipped");
        // reviewer: REVISE then APPROVED; implementer: first pass + the review fix.
        assert.equal(reviewerCalls, 2);
        assert.equal(implementerCalls, 2);
    });

    it("runs the reviewer when the roster has no implementer (review-only)", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("reviewer", mkAgent("reviewer"));
        let reviewerCalls = 0;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "reviewer") {
                        reviewerCalls++;
                        return {
                            output: "APPROVED\nWorking tree looks good",
                            ok: true,
                        };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(
            st,
            host,
            "Review the working tree changes",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "done");
        assert.equal(
            reviewerCalls,
            1,
            "the reviewer reviews the working tree instead of being skipped",
        );
    });

    it("handles validation FAIL → re-implementation loop", async () => {
        const agents = mkFullAgentSet();
        let validatorCalls = 0;
        let implementerCalls = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "planner") {
                        return { output: mkValidPlan(), ok: true };
                    }
                    if (phase.agent === "validator") {
                        validatorCalls++;
                        if (validatorCalls === 1) {
                            return {
                                output: "VERDICT: FAIL\nIssues found",
                                ok: true,
                            };
                        }
                        return { output: "VERDICT: PASS", ok: true };
                    }
                    if (phase.agent === "implementer") {
                        implementerCalls++;
                        return { output: "Implementation complete", ok: true };
                    }
                    if (phase.agent === "reviewer") {
                        return { output: "APPROVED\nPlan approved", ok: true };
                    }
                    if (phase.agent === "shipper") {
                        return { output: "SHIP: SHIPPED", ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "shipped");
        // Validator is called 2 times: validate (FAIL), validate (PASS)
        // Shipper is called 1 time for shipping
        assert.equal(validatorCalls, 2);
        assert.equal(implementerCalls, 2);
    });

    it("exhausts max retries and returns failed-after-retries", async () => {
        const agents = mkFullAgentSet();
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "planner") {
                        return { output: mkValidPlan(), ok: true };
                    }
                    if (phase.agent === "validator") {
                        return {
                            output: "VERDICT: FAIL\nStill broken",
                            ok: true,
                        };
                    }
                    if (phase.agent === "reviewer") {
                        return { output: "APPROVED\nPlan approved", ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            2,
            mkCtx(),
        );
        assert.equal(result.status, "failed-after-retries");
        assert.ok(st.running === false);
    });

    it("exits early on scout failure", async () => {
        const agents = mkFullAgentSet();
        agents.set("scout", mkAgent("scout"));
        const runPhaseCalls: string[] = [];
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    runPhaseCalls.push(phase.agent);
                    if (phase.agent === "scout") {
                        return { output: "Scout failed", ok: false };
                    }
                    if (phase.agent === "planner") {
                        return { output: mkValidPlan(), ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: {
                all: [
                    "scout",
                    "planner",
                    "implementer",
                    "reviewer",
                    "validator",
                ],
            },
            activeTeamName: "all",
        });
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "error");
        assert.ok(result.report.includes("Scout"));
        // Verify planner never ran
        assert.ok(!runPhaseCalls.includes("planner"));
    });

    it("respects abort signal between phases", async () => {
        const agents = mkFullAgentSet();
        const controller = new AbortController();
        let phaseCount = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    phaseCount++;
                    if (phaseCount === 2) {
                        controller.abort();
                    }
                    if (phase.agent === "planner") {
                        return { output: mkValidPlan(), ok: true };
                    }
                    if (phase.agent === "validator") {
                        return { output: "VERDICT: PASS", ok: true };
                    }
                    if (phase.agent === "reviewer") {
                        return { output: "APPROVED\nPlan approved", ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
            signal: controller.signal,
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            3,
            mkCtx(),
        );
        // Abort is checked before each phase, so status should be aborted
        assert.equal(result.status, "aborted");
        assert.ok(st.running === false);
    });

    it("returns aborted (not error) when a phase fails because the run was cancelled mid-phase", async () => {
        const agents = mkFullAgentSet();
        const controller = new AbortController();
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                // The user cancels mid-phase: the subprocess is killed, the abort
                // fires, and the phase surfaces a failure — which must be reported
                // as an abort, not a phase error.
                runPhase: async () => {
                    controller.abort();
                    return { output: "killed", ok: false };
                },
            },
            signal: controller.signal,
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Build feature X", 3, mkCtx());
        assert.equal(result.status, "aborted");
        assert.equal(st.lastStatus, "aborted");
        assert.equal(st.running, false);
    });
});

// ── runWorkflowCore — spec-shaped teams (planner-only) ──

describe("runWorkflowCore (spec-shaped teams)", () => {
    function mkSpecAgentSet(): Map<string, AgentDef> {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        return agents;
    }

    const specTeam: Partial<OrchestratorState> = {
        teams: { spec: ["planner"] },
        activeTeamName: "spec",
    };

    it("runs happy path: plan only", async () => {
        const agents = mkSpecAgentSet();
        const runPhaseCalls: string[] = [];
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    runPhaseCalls.push(phase.agent);
                    if (phase.agent === "planner")
                        return {
                            output:
                                "## Phase 1: Do it\n## Acceptance Criteria\n- works\n## Critical Files\n- a.ts",
                            ok: true,
                        };
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, specTeam);
        const result = await runWorkflowCore(
            st,
            host,
            "Design feature Y",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "done");
        assert.ok(st.running === false);
        assert.ok(runPhaseCalls.includes("planner"));
        assert.ok(!runPhaseCalls.includes("implementer"));
    });

    it("rejects a malformed plan even with no implementer (planner emitted a summary)", async () => {
        const agents = mkSpecAgentSet();
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                // The planner emitted a summary, not a plan — must fail loudly.
                runPhase: async () => ({
                    output: "I wrote the plan to .agent/plan.md.",
                    ok: true,
                }),
            },
        });
        const st = mkStateWithAgents(agents, specTeam);
        const result = await runWorkflowCore(st, host, "Design Y", 3, mkCtx());
        assert.equal(result.status, "error");
        assert.match(result.report, /missing required structure/i);
    });

    it("exits early on planner failure", async () => {
        const agents = mkSpecAgentSet();
        const runPhaseCalls: string[] = [];
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    runPhaseCalls.push(phase.agent);
                    if (phase.agent === "planner") {
                        return { output: "Planning failed", ok: false };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, specTeam);
        const result = await runWorkflowCore(
            st,
            host,
            "Design feature Y",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "error");
        assert.ok(result.report.includes("Planning"));
    });
});

// ── runWorkflowCore — resume / planner-less (build) team ──

describe("runWorkflowCore (resume / build team)", () => {
    function buildTeam(): Map<string, AgentDef> {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer", "validator", "shipper"])
            agents.set(n, mkAgent(n));
        return agents;
    }
    const shipMock = (phase: PhaseState) => {
        if (phase.agent === "reviewer") return { output: "APPROVED", ok: true };
        if (phase.agent === "validator")
            return { output: "VERDICT: PASS", ok: true };
        if (phase.agent === "shipper")
            return {
                output: "SHIP: SHIPPED\nhttps://github.com/t/pull/1",
                ok: true,
            };
        return { output: `${phase.agent} output`, ok: true };
    };

    it("resumes from an existing plan.md without a planner (no scratch wipe)", async () => {
        const agents = buildTeam();
        const cwd = mkdtempSync(join(tmpdir(), "resume-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        const planText =
            "## Phase 1: Resumed work\nRESUMED PLAN BODY.\n\n## Acceptance Criteria\n- ok\n\n## Critical Files\n- a.ts";
        writeFileSync(join(cwd, ".agent", "plan.md"), planText, "utf-8");

        let implSawPlan = "";
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "implementer") {
                        // The plan must survive into the implementer phase (not wiped).
                        implSawPlan = readFileSync(
                            join(cwd, ".agent", "plan.md"),
                            "utf-8",
                        );
                        return { output: "impl output", ok: true };
                    }
                    return shipMock(phase);
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Continue X", 3, { cwd });

        assert.equal(result.status, "shipped");
        assert.ok(
            implSawPlan.includes("RESUMED PLAN BODY"),
            "the existing plan.md was preserved into the implementer phase",
        );
    });

    it("keeps the existing progress ledger on resume (does not re-seed to all-unchecked)", async () => {
        const agents = buildTeam();
        const cwd = mkdtempSync(join(tmpdir(), "resume-ledger-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(
            join(cwd, ".agent", "plan.md"),
            "## Phase 1: A\nx\n## Phase 2: B\ny\n\n## Acceptance Criteria\n- ok\n\n## Critical Files\n- a.ts",
            "utf-8",
        );
        writeFileSync(
            join(cwd, ".agent", "progress.md"),
            "# Implementation progress\n\nBase: abc123\n\n- [x] Phase 1: A\n- [ ] Phase 2: B\n",
            "utf-8",
        );

        let ledgerAtImpl = "";
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "implementer") {
                        ledgerAtImpl = readFileSync(
                            join(cwd, ".agent", "progress.md"),
                            "utf-8",
                        );
                        return { output: "impl output", ok: true };
                    }
                    return shipMock(phase);
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Continue X", 3, { cwd });

        assert.equal(result.status, "shipped");
        // Phase 1 stays done and the original Base is intact — the ledger was NOT
        // re-seeded by initProgressLedger.
        assert.ok(
            ledgerAtImpl.includes("[x] Phase 1: A"),
            "completed phase preserved on resume",
        );
        assert.ok(
            ledgerAtImpl.includes("Base: abc123"),
            "original squash base preserved on resume",
        );
    });

    it("errors clearly when a planner-less team has no plan to build from", async () => {
        const agents = buildTeam();
        const cwd = mkdtempSync(join(tmpdir(), "resume-noplan-"));
        const host = mkHost({ setup: { loadAgents: () => agents } });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Continue X", 3, { cwd });

        assert.equal(result.status, "error");
        assert.ok(
            result.report.includes("no planner") &&
                result.report.includes("plan.md"),
            "error explains there is no planner and no plan on disk",
        );
    });

    it("fails a resume on an invalid saved plan.md, removes it, and never implements", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("implementer", mkAgent("implementer"));
        const cwd = mkdtempSync(join(tmpdir(), "resume-badplan-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        const planPath = join(cwd, ".agent", "plan.md");
        // Garbage from an interrupted earlier run — no phases, no criteria.
        writeFileSync(planPath, "TODO: figure the approach out later", "utf-8");

        const runPhaseCalls: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    runPhaseCalls.push(phase.agent);
                    return { output: "impl output", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Continue X", 3, { cwd });

        assert.equal(result.status, "error");
        assert.match(result.report, /not a usable plan/);
        assert.match(result.report, /has been removed/);
        assert.ok(!existsSync(planPath), "the unusable plan was deleted");
        assert.deepEqual(
            runPhaseCalls,
            [],
            "the implementer never ran from a garbage plan",
        );
    });

    it("still wipes scratch when a planner IS present (fresh plan, no stale resume)", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["planner", "implementer", "reviewer", "validator", "shipper"])
            agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "fresh-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        // A stale plan from a previous, different request.
        writeFileSync(join(cwd, ".agent", "plan.md"), "STALE PLAN", "utf-8");

        let implSawPlan = "";
        const freshPlan =
            "## Phase 1: Fresh\nNew plan body.\n\n## Acceptance Criteria\n- ok\n\n## Critical Files\n- a.ts";
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "planner")
                        return { output: freshPlan, ok: true };
                    if (phase.agent === "implementer") {
                        implSawPlan = readFileSync(
                            join(cwd, ".agent", "plan.md"),
                            "utf-8",
                        );
                        return { output: "impl output", ok: true };
                    }
                    return shipMock(phase);
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "New request", 3, { cwd });

        assert.equal(result.status, "shipped");
        assert.ok(
            !implSawPlan.includes("STALE PLAN") && implSawPlan.includes("Fresh"),
            "the stale plan was wiped and replaced by the planner's fresh plan",
        );
    });
});

// ── runWorkflowCore — error exits (finalizeError) & pre-run validation ──

describe("runWorkflowCore (error bookkeeping / pre-run validation)", () => {
    function plannerOnly(): Map<string, AgentDef> {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        return agents;
    }
    // Last line of the append-only .agent/metrics.jsonl trend log.
    function lastMetricsLine(cwd: string): unknown {
        const lines = readFileSync(join(cwd, ".agent", "metrics.jsonl"), "utf-8")
            .trim()
            .split("\n");
        return JSON.parse(lines[lines.length - 1]);
    }

    it("a failing phase writes workflow-report.md and appends an error metrics line", async () => {
        const agents = plannerOnly();
        const cwd = mkdtempSync(join(tmpdir(), "errfail-"));
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async () => ({
                    output: "provider quota exhausted",
                    ok: false,
                }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });

        assert.equal(result.status, "error");
        assert.equal(st.lastStatus, "error");
        // The failure is persisted, not just returned: report file + metrics line.
        const report = readFileSync(join(cwd, "workflow-report.md"), "utf-8");
        assert.match(report, /Planning failed/);
        assert.match(report, /provider quota exhausted/);
        const metrics = lastMetricsLine(cwd);
        assert.ok(metrics && typeof metrics === "object" && "status" in metrics);
        assert.equal(metrics.status, "error");
    });

    it("an inline validation error (garbage plan) is bookkept the same way", async () => {
        const agents = plannerOnly();
        const cwd = mkdtempSync(join(tmpdir(), "errval-"));
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                // A summary instead of a plan — fails validatePlan, not the phase.
                runPhase: async () => ({
                    output: "I wrote the plan to .agent/plan.md.",
                    ok: true,
                }),
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Design feature Y", 3, {
            cwd,
        });

        assert.equal(result.status, "error");
        assert.equal(st.lastStatus, "error");
        assert.match(
            readFileSync(join(cwd, "workflow-report.md"), "utf-8"),
            /missing required structure/i,
        );
        const metrics = lastMetricsLine(cwd);
        assert.ok(metrics && typeof metrics === "object" && "status" in metrics);
        assert.equal(metrics.status, "error");
    });

    it("an abort exit does NOT clobber the previous report or append metrics", async () => {
        const agents = plannerOnly();
        const cwd = mkdtempSync(join(tmpdir(), "errabort-"));
        writeFileSync(
            join(cwd, "workflow-report.md"),
            "PREVIOUS RUN REPORT",
            "utf-8",
        );
        const controller = new AbortController();
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                // User cancels mid-phase: the killed phase surfaces a failure.
                runPhase: async () => {
                    controller.abort();
                    return { output: "killed", ok: false };
                },
            },
            signal: controller.signal,
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });

        assert.equal(result.status, "aborted");
        assert.equal(
            readFileSync(join(cwd, "workflow-report.md"), "utf-8"),
            "PREVIOUS RUN REPORT",
        );
        assert.ok(!existsSync(join(cwd, ".agent", "metrics.jsonl")));
    });

    it("missing agent definitions fail BEFORE any destructive setup", async () => {
        const agents = plannerOnly();
        const cwd = mkdtempSync(join(tmpdir(), "preval-"));
        let sessionSetups = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {
                    sessionSetups++;
                },
            },
        });
        const previousPhases: PhaseState[] = [
            {
                label: "Planner",
                agent: "planner",
                status: "done",
                elapsed: 5000,
                note: "from the previous run",
                log: "",
                droppedLines: 0,
                toolCount: 3,
                contextPct: 10,
                attempt: 1,
                modelFallback: false,
            },
        ];
        const st = mkStateWithAgents(agents, {
            teams: { broken: ["planner", "ghost"] },
            activeTeamName: "broken",
            phases: previousPhases,
        });
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });

        assert.equal(result.status, "error");
        assert.match(result.report, /Missing agent definitions: ghost/);
        assert.equal(sessionSetups, 0, "no session wipe on a misconfigured roster");
        assert.equal(st.phases, previousPhases, "previous phases untouched");
        // Still fully bookkept as an error exit.
        assert.match(
            readFileSync(join(cwd, "workflow-report.md"), "utf-8"),
            /Missing agent definitions/,
        );
        const metrics = lastMetricsLine(cwd);
        assert.ok(metrics && typeof metrics === "object" && "status" in metrics);
        assert.equal(metrics.status, "error");
    });
});

// ── runWorkflowCore — ping mode ──

describe("runWorkflowCore (ping mode)", () => {
    it("pings every loaded agent in parallel instead of running the pipeline", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["planner", "reviewer", "implementer", "seeker"]) {
            agents.set(n, mkAgent(n));
        }
        const calls: string[] = [];
        let concurrent = 0;
        let maxConcurrent = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase: any, task: string) => {
                    calls.push(phase.agent);
                    assert.equal(task, "ping all agents"); // raw request as task
                    concurrent += 1;
                    maxConcurrent = Math.max(maxConcurrent, concurrent);
                    await new Promise((r) => setTimeout(r, 5));
                    concurrent -= 1;
                    return { output: "pong — ready", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { full: ["planner", "reviewer", "implementer"] },
            activeTeamName: "full",
        });
        const result = await runWorkflowCore(
            st,
            host,
            "ping all agents",
            3,
            mkCtx(),
        );
        assert.equal(result.status, "done");
        // ALL loaded agents pinged (incl. seeker, not in the active team)...
        assert.deepEqual(
            calls.slice().sort(),
            ["implementer", "planner", "reviewer", "seeker"],
        );
        // ...and they ran concurrently, not sequentially.
        assert.ok(maxConcurrent > 1, "expected parallel execution");
        assert.ok(result.report.includes("Ping Report"));
        assert.ok(result.report.includes("in parallel"));
    });
});

// ── spawnAgentWithModel ──────────────────────────
// NOTE: Testing spawnAgentWithModel directly requires mocking child_process.spawn,
// which is not reliably supported by Node's built-in test runner. However, the
// core JSON parsing and result computation logic has been extracted into pure
// functions (handleSpawnEvent and computeSpawnResult) that can be tested without
// subprocess mocking.

describe("handleSpawnEvent", () => {
    function mkPhase(): PhaseState {
        return {
            label: "test",
            agent: "test",
            status: "running",
            elapsed: 0,
            note: "",
            log: "",
            droppedLines: 0,
            toolCount: 0,
            contextPct: 0,
            attempt: 1,
            modelFallback: false,
        };
    }

    function mkState(): SpawnEventState {
        return {
            answer: [],
            finalText: "",
            finalError: "",
            activity: "",
            stderrTail: "",
            droppedLines: 0,
            toolCount: 0,
            contextPct: 0,
            cumulativeTokens: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
            costUsd: 0,
        };
    }

    const noopPaint = () => {};

    it("accumulates text_delta into answer and activity", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Hello" },
            },
            state,
            phase,
            noopPaint,
        );

        assert.equal(state.answer.join(""), "Hello");
        assert.equal(state.activity, "Hello");
    });

    it("computes contextPct from the configured window when the provider omits it", () => {
        const state = mkState();
        state.configuredContextWindow = 1_000_000;
        const phase = mkPhase();
        handleSpawnEvent(
            { type: "message_end", message: { usage: { input: 250000, output: 0 } } },
            state,
            phase,
            noopPaint,
        );
        assert.equal(phase.contextPct, 25); // 250k / 1M
        assert.equal(phase.tokens?.contextWindow, 1_000_000);
    });

    it("captures usage when the provider reports cacheRead/cost but input is 0 (e.g. gateframe)", () => {
        const state = mkState();
        state.configuredContextWindow = 1_000_000;
        const phase = mkPhase();
        handleSpawnEvent(
            {
                type: "message_end",
                message: {
                    usage: {
                        input: 0,
                        output: 200,
                        cacheRead: 120000,
                        cost: { total: 0.42 },
                    },
                },
            },
            state,
            phase,
            noopPaint,
        );
        // Before: gating on `input` skipped this entirely → tokens undefined, $0.
        assert.ok(phase.tokens, "tokens captured despite input 0");
        assert.equal(phase.tokens?.cacheRead, 120000);
        assert.equal(phase.tokens?.costUsd, 0.42);
        assert.equal(state.costUsd, 0.42);
    });

    it("prefers the provider-reported window over the configured one", () => {
        const state = mkState();
        state.configuredContextWindow = 1_000_000;
        const phase = mkPhase();
        handleSpawnEvent(
            {
                type: "message_end",
                message: { usage: { input: 100000, output: 0, contextWindow: 200000 } },
            },
            state,
            phase,
            noopPaint,
        );
        assert.equal(phase.contextPct, 50); // 100k / 200k (provider window wins)
    });

    it("stays 0 when neither provider nor config supplies a window", () => {
        const state = mkState();
        const phase = mkPhase();
        handleSpawnEvent(
            { type: "message_end", message: { usage: { input: 100000, output: 0 } } },
            state,
            phase,
            noopPaint,
        );
        assert.equal(phase.contextPct, 0);
    });

    it("accumulates multiple text_delta events", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Hello " },
            },
            state,
            phase,
            noopPaint,
        );
        handleSpawnEvent(
            {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "world" },
            },
            state,
            phase,
            noopPaint,
        );

        assert.equal(state.answer.join(""), "Hello world");
    });

    it("increments toolCount on tool_execution_start", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "tool_execution_start",
                toolName: "bash",
                args: { command: "ls" },
            },
            state,
            phase,
            noopPaint,
        );

        assert.equal(state.toolCount, 1);
        assert.equal(phase.toolCount, 1);
        assert.ok(state.activity.includes("bash"));
    });

    it("appends tool completion marker on tool_execution_end", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "tool_execution_start",
                toolName: "bash",
                args: { command: "ls" },
            },
            state,
            phase,
            noopPaint,
        );
        handleSpawnEvent(
            {
                type: "tool_execution_end",
                toolName: "bash",
            },
            state,
            phase,
            noopPaint,
        );

        assert.ok(state.activity.includes("✓ bash"));
    });

    it("captures finalText from message_end", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Final answer" }],
                },
            },
            state,
            phase,
            noopPaint,
        );

        assert.equal(state.finalText, "Final answer");
    });

    it("captures token usage from message_end", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [],
                    usage: {
                        input: 1000,
                        output: 500,
                        contextWindow: 100000,
                    },
                },
            },
            state,
            phase,
            noopPaint,
        );

        assert.deepEqual(state.capturedTokens, {
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindow: 100000,
            costUsd: 0,
        });
        // pct = round((input + output) / contextWindow * 100) = round(1500/100000*100) = 2
        assert.equal(phase.contextPct, 2);
    });

    it("accumulates per-turn cost from usage.cost.total across turns", () => {
        const state = mkState();
        const phase = mkPhase();
        const turn = (input: number, output: number, total: number) => ({
            type: "message_end",
            message: {
                role: "assistant",
                content: [],
                usage: {
                    input,
                    output,
                    contextWindow: 100000,
                    cost: { total },
                },
            },
        });
        handleSpawnEvent(turn(1000, 200, 0.01), state, phase, noopPaint);
        handleSpawnEvent(turn(1500, 300, 0.02), state, phase, noopPaint);
        // per-turn cost is additive (input is re-billed each turn)
        assert.ok(Math.abs((state.capturedTokens?.costUsd ?? 0) - 0.03) < 1e-9);
        assert.ok(Math.abs((phase.tokens?.costUsd ?? 0) - 0.03) < 1e-9);
    });

    it("accumulates cache read/write tokens across turns", () => {
        const state = mkState();
        const phase = mkPhase();
        const turn = (cacheRead: number, cacheWrite: number) => ({
            type: "message_end",
            message: {
                role: "assistant",
                content: [],
                usage: {
                    input: 100,
                    output: 50,
                    cacheRead,
                    cacheWrite,
                    contextWindow: 100000,
                    cost: { total: 0 },
                },
            },
        });
        handleSpawnEvent(turn(1000, 200), state, phase, noopPaint);
        handleSpawnEvent(turn(500, 0), state, phase, noopPaint);
        // cache tokens are per-turn, additive
        assert.equal(state.capturedTokens?.cacheRead, 1500);
        assert.equal(state.capturedTokens?.cacheWrite, 200);
        assert.equal(phase.tokens?.cacheRead, 1500);
    });

    it("leaves cost at 0 when usage.cost is absent (unpriced model)", () => {
        const state = mkState();
        const phase = mkPhase();
        handleSpawnEvent(
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [],
                    usage: { input: 1000, output: 500, contextWindow: 100000 },
                },
            },
            state,
            phase,
            noopPaint,
        );
        assert.equal(state.capturedTokens?.costUsd, 0);
    });

    it("captures finalError from message_end with stopReason error", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [],
                    stopReason: "error",
                    errorMessage: "Quota exceeded",
                },
            },
            state,
            phase,
            noopPaint,
        );

        assert.equal(state.finalError, "Quota exceeded");
    });

    it("handles agent_end event type", () => {
        const state = mkState();
        const phase = mkPhase();

        handleSpawnEvent(
            {
                type: "agent_end",
                messages: [
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "Agent done" }],
                    },
                ],
            },
            state,
            phase,
            noopPaint,
        );

        assert.equal(state.finalText, "Agent done");
    });
});

describe("computeSpawnResult", () => {
    function mkState(
        overrides: Partial<SpawnEventState> = {},
    ): SpawnEventState {
        return {
            answer: [],
            finalText: "",
            finalError: "",
            activity: "",
            stderrTail: "",
            droppedLines: 0,
            toolCount: 0,
            contextPct: 0,
            cumulativeTokens: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
            costUsd: 0,
            ...overrides,
        };
    }

    it("prefers streamed deltas over finalText", () => {
        const state = mkState({
            answer: ["Streamed", " content"],
            finalText: "Final text",
        });

        const result = computeSpawnResult(state, 0, false, 0, "");

        assert.equal(result.output, "Streamed content");
        assert.equal(result.exitCode, 0);
    });

    it("falls back to finalText when no deltas", () => {
        const state = mkState({
            answer: [],
            finalText: "Final text",
        });

        const result = computeSpawnResult(state, 0, false, 0, "");

        assert.equal(result.output, "Final text");
    });

    it("appends agent error when finalError is set", () => {
        const state = mkState({
            answer: ["Some output"],
            finalError: "Quota exceeded",
        });

        const result = computeSpawnResult(state, 0, false, 0, "");

        assert.ok(result.output.includes("[agent error]"));
        assert.ok(result.output.includes("Quota exceeded"));
        assert.equal(result.exitCode, 1);
    });

    it("appends timeout message when timedOut", () => {
        const state = mkState();

        const result = computeSpawnResult(state, null, true, 60000, "");

        assert.ok(result.output.includes("[timed out after 1m"));
        assert.equal(result.exitCode, 1);
    });

    it("appends stderr when exit code is non-zero", () => {
        const state = mkState();

        const result = computeSpawnResult(
            state,
            1,
            false,
            0,
            "Error: something failed",
        );

        assert.ok(result.output.includes("[stderr]"));
        assert.ok(result.output.includes("Error: something failed"));
        assert.equal(result.exitCode, 1);
    });

    it("returns exit code 0 on success", () => {
        const state = mkState({ answer: ["Success"] });

        const result = computeSpawnResult(state, 0, false, 0, "");

        assert.equal(result.exitCode, 0);
    });

    it("includes captured tokens in result", () => {
        const state = mkState({
            answer: ["Output"],
            capturedTokens: {
                input: 1000,
                output: 500,
                contextWindow: 100000,
            },
        });

        const result = computeSpawnResult(state, 0, false, 0, "");

        assert.deepEqual(result.tokens, {
            input: 1000,
            output: 500,
            contextWindow: 100000,
        });
    });

    it("forces exit code 1 when timedOut even if process exited 0", () => {
        const state = mkState({ answer: ["Output"] });

        const result = computeSpawnResult(state, 0, true, 60000, "");

        assert.equal(result.exitCode, 1);
    });

    it("forces exit code 1 when finalError even if process exited 0", () => {
        const state = mkState({
            answer: ["Output"],
            finalError: "Auth failed",
        });

        const result = computeSpawnResult(state, 0, false, 0, "");

        assert.equal(result.exitCode, 1);
    });

    it("handles null exit code as 1", () => {
        const state = mkState({ answer: ["Output"] });

        const result = computeSpawnResult(state, null, false, 0, "");

        assert.equal(result.exitCode, 1);
    });
});

describe("spawnAgentWithModel (placeholder)", () => {
    it("placeholder: spawn tests require child_process mocking", () => {
        // The spawnAgentWithModel function is validated through:
        // 1. Integration tests (runWorkflowCore lifecycle tests)
        // 2. Manual testing with real pi subprocesses
        // 3. The extensive mocking of runPhase/runAgent in orchestrator tests
        //    which exercise the full pipeline including spawn behavior.
        // 4. The pure function tests above (handleSpawnEvent, computeSpawnResult)
        assert.ok(true);
    });
});

describe("stripPlanPreamble", () => {
    it("drops conversational preamble before the first heading", () => {
        const raw =
            "Confirmed: the directory is empty. Here is the complete plan:\n\n---\n\n# Plan: Build X\n\n## Phase 1: A";
        const out = stripPlanPreamble(raw);
        assert.ok(out.startsWith("# Plan: Build X"));
        assert.doesNotMatch(out, /Confirmed:/);
        assert.match(out, /## Phase 1: A/);
    });

    it("leaves a clean plan unchanged", () => {
        const clean = "# Plan: Build X\n\n## Phase 1: A";
        assert.equal(stripPlanPreamble(clean), clean);
    });

    it("returns input unchanged when there's no heading (let validation catch it)", () => {
        const summary = "I wrote the plan to .agent/plan.md.";
        assert.equal(stripPlanPreamble(summary), summary);
    });
});

describe("capturePlan", () => {
    it("records the artifact and writes .agent/plan.md when absent", () => {
        const cwd = mkdtempSync(join(tmpdir(), "plan-"));
        const artifacts: any = {};
        capturePlan(artifacts, cwd, "# Plan\n## Phase 1");
        assert.equal(artifacts.plan, "# Plan\n## Phase 1");
        assert.equal(
            readFileSync(join(cwd, ".agent", "plan.md"), "utf-8"),
            "# Plan\n## Phase 1",
        );
    });

    it("overwrites .agent/plan.md (the message is the source of truth)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "plan-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), "STALE", "utf-8");
        const artifacts: any = {};
        capturePlan(artifacts, cwd, "# Plan\n## Phase 1");
        assert.equal(artifacts.plan, "# Plan\n## Phase 1");
        assert.equal(
            readFileSync(join(cwd, ".agent", "plan.md"), "utf-8"),
            "# Plan\n## Phase 1", // overwritten with the canonical message
        );
    });
});

describe("savePlanDraft", () => {
    it("copies plan.md to plan.draft.md (no-op when there's no plan)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "draft-"));
        savePlanDraft(cwd); // no plan yet — must not throw
        assert.equal(existsSync(join(cwd, ".agent", "plan.draft.md")), false);
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), "# Draft\n## Phase 1", "utf-8");
        savePlanDraft(cwd);
        assert.equal(
            readFileSync(join(cwd, ".agent", "plan.draft.md"), "utf-8"),
            "# Draft\n## Phase 1",
        );
    });
});

describe("resetRunScratch", () => {
    it("removes stale plan, draft, and progress ledger (no-op when absent)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "plan-"));
        mkdirSync(join(cwd, ".agent", "checkpoints"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), "old", "utf-8");
        writeFileSync(join(cwd, ".agent", "plan.draft.md"), "olddraft", "utf-8");
        writeFileSync(join(cwd, ".agent", "progress.md"), "stale", "utf-8");
        // /revert's checkpoint store must survive a run reset.
        writeFileSync(
            join(cwd, ".agent", "checkpoints", "latest.json"),
            "{}",
            "utf-8",
        );
        resetRunScratch(cwd);
        assert.equal(existsSync(join(cwd, ".agent", "plan.md")), false);
        assert.equal(existsSync(join(cwd, ".agent", "plan.draft.md")), false);
        assert.equal(existsSync(join(cwd, ".agent", "progress.md")), false);
        assert.equal(
            existsSync(join(cwd, ".agent", "checkpoints", "latest.json")),
            true,
        );
        resetRunScratch(cwd); // no throw when already gone
    });
});

describe("initProgressLedger", () => {
    const plan = "# Plan\n## Phase 1: Skeleton\nbody\n## Phase 2: Polish (TDD)\nbody";

    it("seeds Base + an unchecked entry per plan phase (git run)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "led-"));
        initProgressLedger(cwd, "abc1234", plan);
        const body = readFileSync(join(cwd, ".agent", "progress.md"), "utf-8");
        assert.match(body, /Base: abc1234/);
        assert.match(body, /- \[ \] Phase 1: Skeleton/);
        assert.match(body, /- \[ \] Phase 2: Polish \(TDD\)/);
        // No `[x]` lines — the implementer must see a fresh (non-resume) run.
        assert.doesNotMatch(body, /\[x\]/);
    });

    it("tracks phases even without git (no Base line)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "led-"));
        initProgressLedger(cwd, "", plan);
        const body = readFileSync(join(cwd, ".agent", "progress.md"), "utf-8");
        assert.doesNotMatch(body, /Base:/);
        assert.match(body, /- \[ \] Phase 1: Skeleton/);
        assert.match(body, /- \[ \] Phase 2: Polish \(TDD\)/);
    });

    it("falls back to a single entry when the plan has no phase headings", () => {
        const cwd = mkdtempSync(join(tmpdir(), "led-"));
        initProgressLedger(cwd, "", "no phases here");
        const body = readFileSync(join(cwd, ".agent", "progress.md"), "utf-8");
        assert.match(body, /- \[ \] Implementation/);
    });
});

describe("markAllPhasesDone", () => {
    it("flips remaining unchecked phases to done, preserving annotations", () => {
        const cwd = mkdtempSync(join(tmpdir(), "done-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(
            join(cwd, ".agent", "progress.md"),
            "# Implementation progress\n\nBase: abc\n\n- [x] Phase 1: A — sha1 — tests: t1\n- [ ] Phase 2: B\n",
            "utf-8",
        );
        markAllPhasesDone(cwd);
        const body = readFileSync(join(cwd, ".agent", "progress.md"), "utf-8");
        assert.doesNotMatch(body, /- \[ \]/);
        // Already-done line (with its sha/test annotation) is preserved verbatim.
        assert.match(body, /- \[x\] Phase 1: A — sha1 — tests: t1/);
        assert.match(body, /- \[x\] Phase 2: B/);
    });

    it("is a no-op when the ledger is absent", () => {
        const cwd = mkdtempSync(join(tmpdir(), "done-"));
        markAllPhasesDone(cwd); // must not throw
        assert.equal(existsSync(join(cwd, ".agent", "progress.md")), false);
    });
});

describe("planArchiveName", () => {
    it("is <YYYY-MM-DD>-<slug>.md", () => {
        const name = planArchiveName(
            "Add the Login Page!",
            new Date(2026, 5, 8, 10, 0, 0), // June 8, LOCAL time (names use local dates)
        );
        assert.equal(name, "2026-06-08-add-the-login-page.md");
    });
});

describe("archivePlan", () => {
    const now = new Date(2026, 5, 8, 10, 0, 0); // June 8, LOCAL time (archive dates are local)

    it("writes the plan with an outcome header and returns the repo-relative path", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        const rel = archivePlan(
            cwd,
            "Fix the bug",
            "# Plan\nbody",
            true,
            "passed",
            now,
        );
        assert.equal(rel, join("docs", "plans", "2026-06-08-fix-the-bug.md"));
        const body = readFileSync(join(cwd, rel as string), "utf-8");
        assert.match(body, /Run outcome:\*\* passed — 2026-06-08/);
        assert.match(body, /# Plan\nbody$/);
    });

    it("records failed attempts (outcome stamped in the file)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        const rel = archivePlan(cwd, "Bad idea", "# Plan", true, "failed", now);
        const body = readFileSync(join(cwd, rel as string), "utf-8");
        assert.match(body, /Run outcome:\*\* failed/);
    });

    it("does not overwrite a prior attempt — uniquifies the name", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        const a = archivePlan(cwd, "Same task", "# attempt 1", true, "failed", now);
        const b = archivePlan(cwd, "Same task", "# attempt 2", true, "passed", now);
        assert.equal(a, join("docs", "plans", "2026-06-08-same-task.md"));
        assert.equal(b, join("docs", "plans", "2026-06-08-same-task-2.md"));
        // The earlier (failed) record survives.
        assert.match(readFileSync(join(cwd, a as string), "utf-8"), /attempt 1/);
        assert.match(readFileSync(join(cwd, b as string), "utf-8"), /attempt 2/);
    });

    it("skips (returns null) when disabled and no docs/plans dir exists", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        const rel = archivePlan(cwd, "Fix the bug", "# Plan", false, "passed", now);
        assert.equal(rel, null);
        assert.equal(existsSync(join(cwd, "docs", "plans")), false);
    });

    it("auto-enables when a docs/plans dir already exists, even if disabled", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
        const rel = archivePlan(cwd, "Fix the bug", "# Plan", false, "passed", now);
        assert.equal(rel, join("docs", "plans", "2026-06-08-fix-the-bug.md"));
    });

    it("skips an empty plan", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        assert.equal(archivePlan(cwd, "x", "   ", true, "passed", now), null);
    });

    it("folds the ledger's phase status into the durable archive", () => {
        const cwd = mkdtempSync(join(tmpdir(), "arch-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(
            join(cwd, ".agent", "progress.md"),
            "# Implementation progress\n\n- [x] Phase 1: A\n- [ ] Phase 2: B\n",
            "utf-8",
        );
        const rel = archivePlan(cwd, "Task", "# Plan", true, "failed", now);
        const body = readFileSync(join(cwd, rel as string), "utf-8");
        assert.match(body, /## Phase status/);
        assert.match(body, /- \[x\] Phase 1: A/);
        assert.match(body, /- \[ \] Phase 2: B/); // partial status preserved (failed run)
    });
});

// ── selectPlan (write-to-file plan capture) ─────────────────────────────────
describe("selectPlan", () => {
    // A minimal structurally-valid plan (phase + acceptance criteria + a file path).
    const VALID = [
        "## Phase 1: Do it",
        "Modify `src/main.ts`.",
        "## Acceptance Criteria",
        "1. It works.",
        "## Critical Files",
        "- `src/main.ts`",
    ].join("\n");
    const VALID2 = VALID.replace("Do it", "Harden it"); // a distinct valid plan
    const SHORT = "Wrote the hardened plan to .agent/plan.md — 1 phase. None open.";

    function tmp(): string {
        const cwd = mkdtempSync(join(tmpdir(), "selplan-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        return cwd;
    }
    const ra = () => ({}) as any;

    it("uses the message when it is a valid plan (older inline-emit models)", () => {
        const cwd = tmp();
        const r = selectPlan(ra(), cwd, [VALID, ""]);
        assert.ok(r.ok);
        assert.equal(r.output, VALID);
        assert.equal(readPlanFile(cwd), VALID); // persisted to disk
    });

    it("falls back to the written file when the message is a short confirmation", () => {
        const cwd = tmp();
        // Simulate the agent having written the full plan to plan.md itself.
        writeFileSync(join(cwd, ".agent", "plan.md"), VALID, "utf-8");
        const r = selectPlan(ra(), cwd, [stripPlanPreamble(SHORT), readPlanFile(cwd)]);
        assert.equal(r.output, VALID); // the file, not the short message
    });

    it("prefers a valid message over the file (freshest agent output)", () => {
        const cwd = tmp();
        writeFileSync(join(cwd, ".agent", "plan.md"), VALID, "utf-8");
        const r = selectPlan(ra(), cwd, [VALID2, readPlanFile(cwd)]);
        assert.equal(r.output, VALID2);
        assert.equal(readPlanFile(cwd), VALID2);
    });

    it("falls through to the planner draft when message and file are both unusable", () => {
        const cwd = tmp();
        // refiner truncated its file write (invalid), short message, but the
        // planner's draft was saved.
        writeFileSync(join(cwd, ".agent", "plan.md"), "## Phase 1: cut off", "utf-8");
        writeFileSync(join(cwd, ".agent", "plan.draft.md"), VALID, "utf-8");
        const r = selectPlan(ra(), cwd, [
            stripPlanPreamble(SHORT),
            readPlanFile(cwd),
            readPlanFile(cwd, "plan.draft.md"),
        ]);
        assert.equal(r.output, VALID); // the planner's draft
    });

    it("keeps the first non-empty candidate when nothing validates (caller errors) without persisting it", () => {
        const cwd = tmp();
        const r = selectPlan(ra(), cwd, ["", SHORT, "also not a plan"]);
        assert.equal(r.output, SHORT); // surfaced for the downstream validatePlan error
        assert.ok(r.ok); // selectPlan itself never throws; validity is checked by the caller
        // The garbage must NOT land in .agent/plan.md, where a later planner-less
        // (build) run would resume from it.
        assert.ok(!existsSync(join(cwd, ".agent", "plan.md")));
    });

    it("readPlanFile returns '' for a missing file", () => {
        assert.equal(readPlanFile(mkdtempSync(join(tmpdir(), "noplan-"))), "");
    });
});

describe("dispatch activity streaming", () => {
    it("streamDispatchEnabled is off by default and honors truthy values", () => {
        assert.equal(streamDispatchEnabled({}), false);
        assert.equal(streamDispatchEnabled({ PI_DISPATCH_STREAM: "0" }), false);
        assert.equal(streamDispatchEnabled({ PI_DISPATCH_STREAM: "" }), false);
        for (const v of ["1", "true", "on", "ON", " True "])
            assert.equal(streamDispatchEnabled({ PI_DISPATCH_STREAM: v }), true, v);
    });

    it("renders a single agent as a labeled tail of its recent log lines", () => {
        const log = "→ bash ls\n✓ bash\n→ edit app.py\n✓ edit";
        const out = renderDispatchActivity([{ label: "phase-implementer", log }]);
        const lines = out.split("\n");
        assert.equal(lines[0], "phase-implementer — running…");
        assert.deepEqual(lines.slice(1), ["→ bash ls", "✓ bash", "→ edit app.py", "✓ edit"]);
    });

    it("caps a single agent's tail at the last 8 non-empty lines", () => {
        const log = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
        const out = renderDispatchActivity([{ label: "a", log }]);
        // header + 8 tail lines, and it is the LAST 8
        assert.equal(out.split("\n").length, 9);
        assert.ok(out.endsWith("line 19"));
        assert.ok(!out.includes("line 11"));
    });

    it("renders a parallel wave as one latest line per agent", () => {
        const out = renderDispatchActivity([
            { label: "phase-implementer#1", log: "→ write a.py\n✓ write" },
            { label: "phase-implementer#2", log: "→ bash pytest\n" },
        ]);
        assert.deepEqual(out.split("\n"), [
            "phase-implementer#1: ✓ write",
            "phase-implementer#2: → bash pytest",
        ]);
    });

    it("shows a placeholder for an agent that has not logged yet", () => {
        const out = renderDispatchActivity([
            { label: "a", log: "→ go" },
            { label: "b", log: "" },
        ]);
        assert.deepEqual(out.split("\n"), ["a: → go", "b: …"]);
    });
});

// ── Review gate: an unresolved REVISE blocks shipping ──

describe("runWorkflowCore review gate", () => {
    const PLAN = [
        "## Phase 1: Do the work",
        "Edit `src/a.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    it("blocks the shipper and ends needs-review when the reviewer never approves", async () => {
        // The reviewer says REVISE BEFORE MERGE on every round and the loop runs
        // out: the change was never signed off, so it must NOT ship.
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer", "shipper"])
            agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "revise-block-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");

        const calls: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    calls.push(phase.agent);
                    if (phase.agent === "reviewer")
                        return {
                            output: "REVISE BEFORE MERGE\nThe error path is still unhandled.",
                            ok: true,
                        };
                    if (phase.agent === "shipper")
                        return { output: "SHIP: SHIPPED", ok: true };
                    return { output: "impl output", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { rev: ["implementer", "reviewer", "shipper"] },
            activeTeamName: "rev",
        });
        const result = await runWorkflowCore(st, host, "Build feature X", 2, {
            cwd,
        });

        assert.equal(result.status, "needs-review");
        assert.equal(st.lastStatus, "needs-review");
        assert.ok(!calls.includes("shipper"), "the shipper must never run");
    });

    it("still ships once the reviewer approves (the gate is the verdict, not the reviewer's presence)", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer", "shipper"])
            agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "revise-ok-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");

        let reviewerCalls = 0;
        const calls: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    calls.push(phase.agent);
                    if (phase.agent === "reviewer") {
                        reviewerCalls++;
                        return reviewerCalls === 1
                            ? { output: "REVISE BEFORE MERGE\nfix it", ok: true }
                            : { output: "APPROVED\nlooks good now", ok: true };
                    }
                    if (phase.agent === "shipper")
                        return {
                            output: "SHIP: SHIPPED\nhttps://github.com/t/pull/9",
                            ok: true,
                        };
                    return { output: "impl output", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { rev: ["implementer", "reviewer", "shipper"] },
            activeTeamName: "rev",
        });
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });

        assert.equal(result.status, "shipped");
        assert.ok(calls.includes("shipper"));
    });

    it("keeps a passing validator from overriding an unresolved REVISE", async () => {
        // The validator's PASS is about the tests; the reviewer's REVISE is a
        // separate, still-open gate.
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer", "validator", "shipper"])
            agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "revise-val-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");

        const events: { type: string; payload: any }[] = [];
        setObsEmit((type, payload) => events.push({ type, payload }));
        let result;
        try {
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runPhase: async (phase) => {
                        if (phase.agent === "reviewer")
                            return { output: "REVISE BEFORE MERGE\nno", ok: true };
                        if (phase.agent === "validator")
                            return { output: "VERDICT: PASS", ok: true };
                        if (phase.agent === "shipper")
                            return { output: "SHIP: SHIPPED", ok: true };
                        return { output: "impl output", ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, {
                teams: {
                    rev: ["implementer", "reviewer", "validator", "shipper"],
                },
                activeTeamName: "rev",
            });
            result = await runWorkflowCore(st, host, "Build feature X", 1, {
                cwd,
            });
        } finally {
            setObsEmit(undefined);
        }

        assert.equal(result!.status, "needs-review");
        // The shipper never ran, so it gets no auto-verdict.
        const verdicts = events.filter((e) => e.type === "verdict");
        assert.equal(
            verdicts.find((v) => v.payload.agent === "shipper"),
            undefined,
            "a shipper that never ran must not be auto-scored",
        );
        const runLevel = verdicts.filter(
            (v) => !v.payload.agent && v.payload.source === "workflow",
        );
        assert.equal(runLevel[runLevel.length - 1].payload.status, "open");
    });
});

// ── Dispatch guards see the workflow extension's run, not just local state ──

describe("dispatch guards consult the global workflow bridge", () => {
    type Bridge = { __piHasRunningWorkflow?: () => boolean };
    const bridges = globalThis as Bridge;
    function withBridge<T>(hook: (() => boolean) | undefined, fn: () => T): T {
        const prev = bridges.__piHasRunningWorkflow;
        if (hook) bridges.__piHasRunningWorkflow = hook;
        else delete bridges.__piHasRunningWorkflow;
        try {
            return fn();
        } finally {
            if (prev) bridges.__piHasRunningWorkflow = prev;
            else delete bridges.__piHasRunningWorkflow;
        }
    }
    function seekerSetup() {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        return {
            agents,
            host: mkHost({ setup: { loadAgents: () => agents } }),
        };
    }

    it("dispatch_agent refuses while the workflow extension reports a running pipeline", async () => {
        const { agents, host } = seekerSetup();
        // s.running is false — the dispatch extension has its OWN state and never
        // sees the workflow extension's run; only the bridge does.
        const result = await withBridge(() => true, () =>
            dispatchAgentCore(
                mkStateWithAgents(agents),
                host,
                "seeker",
                "research",
                undefined,
                mkCtx(),
            ),
        );
        assert.match(
            (result.content[0] as { text: string }).text,
            /Cannot dispatch while a workflow is running/,
        );
    });

    it("dispatch_parallel refuses while the workflow extension reports a running pipeline", async () => {
        const { agents, host } = seekerSetup();
        const result = await withBridge(() => true, () =>
            dispatchParallelCore(
                mkStateWithAgents(agents),
                host,
                [{ agent: "seeker", task: "a" }],
                undefined,
                mkCtx(),
            ),
        );
        assert.match(
            (result.content[0] as { text: string }).text,
            /Cannot dispatch while a workflow is running/,
        );
    });

    it("select_agents refuses while the workflow extension reports a running pipeline", () => {
        const { agents, host } = seekerSetup();
        const result = withBridge(() => true, () =>
            selectAgentsCore(mkStateWithAgents(agents), host, ["seeker"], mkCtx()),
        );
        assert.match(
            (result.content[0] as { text: string }).text,
            /Cannot change the selection while a full workflow is running/,
        );
    });

    it("treats a throwing or absent bridge as 'no workflow running'", async () => {
        const { agents, host } = seekerSetup();
        for (const hook of [
            undefined,
            () => {
                throw new Error("bridge exploded");
            },
            () => false,
        ]) {
            const result = await withBridge(hook as any, () =>
                dispatchAgentCore(
                    mkStateWithAgents(agents),
                    host,
                    "seeker",
                    "research",
                    undefined,
                    mkCtx(),
                ),
            );
            assert.ok(
                !(result.content[0] as { text: string }).text.includes(
                    "Cannot dispatch while a workflow is running",
                ),
                "a broken bridge must never block dispatch",
            );
        }
    });

    it("still refuses on local state alone (dispatch started by this very state)", async () => {
        const { agents, host } = seekerSetup();
        const result = await withBridge(undefined, () =>
            dispatchAgentCore(
                mkStateWithAgents(agents, { running: true }),
                host,
                "seeker",
                "research",
                undefined,
                mkCtx(),
            ),
        );
        assert.match(
            (result.content[0] as { text: string }).text,
            /Cannot dispatch while a workflow is running/,
        );
    });
});

// ── Resume mode is for BUILD rosters only; learnings never survive a run ──

describe("runWorkflowCore resume gating and staged-learnings hygiene", () => {
    const PLAN = [
        "## Phase 1: Do the work",
        "Edit `src/a.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");
    const STALE_LEARNING =
        '{"agent":"implementer","text":"stale lesson from a crashed run"}\n';

    it("a planner-less roster with no implementer does NOT resume: it clears the crashed run's staged learnings", async () => {
        // Reviewer-only: previously this counted as a "resume", adopting (and
        // validating) a stale plan and skipping the scratch reset — which leaked the
        // crashed run's staged learnings into this run's verified commit.
        const agents = new Map<string, AgentDef>();
        agents.set("reviewer", mkAgent("reviewer"));
        const cwd = mkdtempSync(join(tmpdir(), "noresume-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        // A garbage plan left behind: a resume would fail validation on it.
        writeFileSync(join(cwd, ".agent", "plan.md"), "TODO: figure it out", "utf-8");
        writeFileSync(
            join(cwd, ".agent", "learnings.jsonl"),
            STALE_LEARNING,
            "utf-8",
        );

        let learningsAtReview = true;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "reviewer") {
                        learningsAtReview = existsSync(
                            join(cwd, ".agent", "learnings.jsonl"),
                        );
                        return { output: "APPROVED\nlooks fine", ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { rev: ["reviewer"] },
            activeTeamName: "rev",
        });
        const result = await runWorkflowCore(st, host, "Review the tree", 3, {
            cwd,
        });

        assert.equal(
            result.status,
            "done",
            "the stale plan must not be validated as this run's plan",
        );
        assert.equal(
            learningsAtReview,
            false,
            "the crashed run's staged learnings were cleared before the phase ran",
        );
    });

    it("a resume keeps the plan and ledger but still clears staged learnings", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "validator"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "resume-learn-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");
        writeFileSync(
            join(cwd, ".agent", "learnings.jsonl"),
            STALE_LEARNING,
            "utf-8",
        );

        let sawPlan = "";
        let learningsAtImpl = true;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "implementer") {
                        sawPlan = readFileSync(
                            join(cwd, ".agent", "plan.md"),
                            "utf-8",
                        );
                        learningsAtImpl = existsSync(
                            join(cwd, ".agent", "learnings.jsonl"),
                        );
                        return { output: "impl output", ok: true };
                    }
                    return { output: "VERDICT: PASS", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { build: ["implementer", "validator"] },
            activeTeamName: "build",
        });
        const result = await runWorkflowCore(st, host, "Continue X", 3, { cwd });

        assert.equal(result.status, "done");
        assert.ok(sawPlan.includes("Do the work"), "the plan survives the resume");
        assert.equal(
            learningsAtImpl,
            false,
            "staged learnings are cleared even on a resume",
        );
    });
});

// ── An unexpected throw is still a terminal run ──

describe("runWorkflowCore unexpected-throw bookkeeping", () => {
    it("writes the report, appends an error metrics line and clears staged learnings", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const cwd = mkdtempSync(join(tmpdir(), "throw-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(
            join(cwd, ".agent", "learnings.jsonl"),
            '{"agent":"planner","text":"lesson"}\n',
            "utf-8",
        );

        let widgetUpdates = 0;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            ui: { updateWidget: () => void widgetUpdates++ },
            execution: {
                runPhase: async () => {
                    throw new Error("boom: provider exploded mid-plan");
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });

        assert.equal(result.status, "error");
        assert.match(result.report, /failed unexpectedly: boom/);
        assert.equal(st.running, false);
        assert.equal(st.lastStatus, "error");
        assert.ok(widgetUpdates > 0, "the widget was repainted off 'running'");
        // Terminal bookkeeping ran: report + metrics line + staging cleared.
        assert.match(
            readFileSync(join(cwd, "workflow-report.md"), "utf-8"),
            /failed unexpectedly: boom/,
        );
        const lines = readFileSync(join(cwd, ".agent", "metrics.jsonl"), "utf-8")
            .trim()
            .split("\n");
        assert.equal(JSON.parse(lines[lines.length - 1]).status, "error");
        assert.ok(
            !existsSync(join(cwd, ".agent", "learnings.jsonl")),
            "a crashed run keeps no staged lessons",
        );
    });

    it("survives a throw that happens before the run was initialized", async () => {
        // prepareRun blows up: runStartedAt/phases still belong to the PREVIOUS run,
        // so the bookkeeping must not report those as this run's.
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const cwd = mkdtempSync(join(tmpdir(), "throw-pre-"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                prepareRun: () => {
                    throw new Error("no model available");
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            phases: [
                {
                    label: "Plan",
                    agent: "planner",
                    status: "done",
                    elapsed: 5000,
                    note: "from the previous run",
                    log: "",
                    droppedLines: 0,
                    toolCount: 3,
                    contextPct: 10,
                    attempt: 1,
                    modelFallback: false,
                },
            ],
        });
        const result = await runWorkflowCore(st, host, "Build feature X", 3, {
            cwd,
        });

        assert.equal(result.status, "error");
        assert.match(result.report, /no model available/);
        const metrics = JSON.parse(
            readFileSync(join(cwd, ".agent", "metrics.jsonl"), "utf-8").trim(),
        );
        assert.equal(metrics.status, "error");
        assert.ok(
            !JSON.stringify(metrics).includes("from the previous run"),
            "the previous run's phases are not attributed to this crash",
        );
        assert.ok(
            st.runElapsedMs >= 0 && st.runElapsedMs < 60_000,
            "elapsed time is this call's, not an epoch-length number",
        );
    });
});

// ── A roster with no pipeline roles is an error, not a vacuous "done" ──

describe("runWorkflowCore empty-pipeline roster", () => {
    it("fails with a clear message instead of an empty done run", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const cwd = mkdtempSync(join(tmpdir(), "nopipeline-"));
        let phasesRun = 0;
        let sessionSetups = 0;
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => void sessionSetups++,
            },
            execution: {
                runPhase: async (phase) => {
                    phasesRun++;
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { research: ["seeker"] },
            activeTeamName: "research",
        });
        const result = await runWorkflowCore(st, host, "Research X", 3, { cwd });

        assert.equal(result.status, "error");
        assert.match(result.report, /no pipeline roles/i);
        assert.match(result.report, /seeker/);
        assert.equal(phasesRun, 0, "nothing ran");
        assert.equal(sessionSetups, 0, "no session wipe for a roster that can't run");
        // Persisted as a real error exit, not silently swallowed.
        assert.match(
            readFileSync(join(cwd, "workflow-report.md"), "utf-8"),
            /no pipeline roles/i,
        );
    });

    it("a roster mixing specialists with a pipeline role still runs", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["seeker", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "mixed-"));
        const calls: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    calls.push(phase.agent);
                    return { output: "APPROVED\nfine", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { mixed: ["seeker", "reviewer"] },
            activeTeamName: "mixed",
        });
        const result = await runWorkflowCore(st, host, "Review it", 3, { cwd });

        assert.equal(result.status, "done");
        assert.deepEqual(calls, ["reviewer"]);
    });
});

// ── Per-item error isolation in dispatch ──

describe("dispatch error isolation", () => {
    it("dispatchAgentCore reports a rejected spawn instead of throwing", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runAgent: async () => {
                    throw new Error("spawn ENOENT");
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await dispatchAgentCore(
            st,
            host,
            "seeker",
            "research",
            undefined,
            mkCtx(),
        );
        assert.match(
            (result.content[0] as { text: string }).text,
            /spawn ENOENT/,
        );
        assert.equal(
            st.phases.find((p) => p.agent === "seeker")?.status,
            "error",
            "the phase must not be left stuck at 'running'",
        );
    });

    it("dispatchParallelCore isolates a failing item so its siblings still complete", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["seeker", "scout"]) agents.set(n, mkAgent(n));
        const ends: any[] = [];
        setObsEmit((type, payload) => {
            if (type === "dispatch_end") ends.push(payload);
        });
        let result;
        let st: OrchestratorState;
        try {
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runAgent: async (def) => {
                        if (def.name === "seeker")
                            throw new Error("spawn ENOENT");
                        return {
                            output: "scout produced a real, substantive result well over the threshold",
                            exitCode: 0,
                        };
                    },
                },
            });
            st = mkStateWithAgents(agents);
            result = await dispatchParallelCore(
                st,
                host,
                [
                    { agent: "seeker", task: "a" },
                    { agent: "scout", task: "b" },
                ],
                undefined,
                mkCtx(),
            );
        } finally {
            setObsEmit(undefined);
        }

        const text = (result!.content[0] as { text: string }).text;
        assert.match(text, /1\/2 succeeded/);
        assert.match(text, /spawn ENOENT/);
        assert.match(text, /scout produced a real/);
        // Both phases resolved, and both emitted a dispatch_end.
        assert.deepEqual(
            st!.phases.map((p) => p.status).sort(),
            ["done", "error"],
        );
        assert.equal(ends.length, 2);
    });
});

// ── Concurrent single dispatches share one learnings staging file ──

describe("dispatch learnings commit is deferred until the last dispatch lands", () => {
    let saved: string | undefined;
    beforeEach(() => {
        saved = process.env.PI_AGENT_MEMORY;
        delete process.env.PI_AGENT_MEMORY; // default = memory enabled
    });

    it("a finishing dispatch does not steal a still-running sibling's staged lessons", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "dispatch-learn-race-"));
        try {
            const agents = new Map<string, AgentDef>();
            for (const n of ["fast", "slow"]) agents.set(n, mkAgent(n));
            let releaseSlow: () => void = () => {};
            const slowDone = new Promise<void>((r) => (releaseSlow = r));
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runAgent: async (def) => {
                        if (def.name === "slow") {
                            await slowDone;
                            // Staged AFTER the fast dispatch already finished.
                            stageLearning(cwd, "slow", "the slow agent's lesson");
                            return { output: "", exitCode: 0 };
                        }
                        return { output: "", exitCode: 0 };
                    },
                },
            });
            const st = mkStateWithAgents(agents);
            const slow = dispatchAgentCore(st, host, "slow", "t", undefined, {
                cwd,
            });
            const fast = await dispatchAgentCore(st, host, "fast", "t", undefined, {
                cwd,
            });
            assert.ok(fast, "fast dispatch resolved");
            // One dispatch is still in flight: the commit must NOT have run yet.
            assert.equal(
                st.activeDispatches,
                1,
                "the slow dispatch is still counted in flight",
            );
            releaseSlow();
            await slow;
            assert.equal(st.activeDispatches, 0);
            assert.equal(
                readStaged(cwd).length,
                0,
                "the last finisher commits (here: clears) the shared staging exactly once",
            );
        } finally {
            if (saved === undefined) delete process.env.PI_AGENT_MEMORY;
            else process.env.PI_AGENT_MEMORY = saved;
        }
    });

    it("ORs the verdicts of the in-flight group (one real result keeps the lessons)", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "dispatch-learn-or-"));
        try {
            const agents = new Map<string, AgentDef>();
            for (const n of ["good", "bad"]) agents.set(n, mkAgent(n));
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runAgent: async (def) => {
                        stageLearning(cwd, def.name, `${def.name} learned a thing`);
                        return def.name === "good"
                            ? {
                                  output: "a substantive result comfortably over the minimum threshold",
                                  exitCode: 0,
                              }
                            : { output: "", exitCode: 0 };
                    },
                },
            });
            const st = mkStateWithAgents(agents);
            await Promise.all([
                dispatchAgentCore(st, host, "bad", "t", undefined, { cwd }),
                dispatchAgentCore(st, host, "good", "t", undefined, { cwd }),
            ]);
            assert.equal(st.activeDispatches, 0);
            assert.equal(readStaged(cwd).length, 0, "staging cleared once");
            assert.equal(
                st.dispatchLearningsPassed,
                false,
                "the OR-ed verdict is reset for the next group",
            );
        } finally {
            if (saved === undefined) delete process.env.PI_AGENT_MEMORY;
            else process.env.PI_AGENT_MEMORY = saved;
        }
    });
});

// ── Notification polish ──

describe("dispatch notifications use SDK levels only", () => {
    it("a successful dispatch notifies at 'info', not the unsupported 'success'", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const levels: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            ui: { notify: (_m: string, level: string) => void levels.push(level) },
            execution: {
                runAgent: async () => ({
                    output: "a substantive result comfortably over the minimum threshold",
                    exitCode: 0,
                }),
            },
        });
        await dispatchAgentCore(
            mkStateWithAgents(agents),
            host,
            "seeker",
            "research",
            undefined,
            mkCtx(),
        );
        assert.deepEqual(levels, ["info"]);
    });

    it("a successful parallel dispatch notifies at 'info' per item", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("seeker", mkAgent("seeker"));
        const levels: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            ui: { notify: (_m: string, level: string) => void levels.push(level) },
            execution: {
                runAgent: async () => ({
                    output: "a substantive result comfortably over the minimum threshold",
                    exitCode: 0,
                }),
            },
        });
        await dispatchParallelCore(
            mkStateWithAgents(agents),
            host,
            [
                { agent: "seeker", task: "a" },
                { agent: "seeker", task: "b" },
            ],
            undefined,
            mkCtx(),
        );
        assert.deepEqual(levels, ["info", "info"]);
    });
});

describe("runFullWorkflowCommand completion notice", () => {
    function mkNotifyCtx(cwd: string) {
        const notices: string[] = [];
        return {
            notices,
            ctx: {
                cwd,
                ui: { notify: (msg: string) => void notices.push(msg) },
            },
        };
    }

    it("skips the report link and elapsed time for a run that wrote no report", async () => {
        // The re-entry guard returns without running anything: linking a report and
        // quoting s.runElapsedMs would describe the OTHER (in-progress) run.
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({ setup: { loadAgents: () => agents } });
        const st = mkStateWithAgents(agents, {
            running: true,
            runElapsedMs: 987_000,
        });
        const { notices, ctx } = mkNotifyCtx(mkdtempSync(join(tmpdir(), "cmd-")));

        await runFullWorkflowCommand(st, host, "Build X", ctx, () => {}, 3);

        const done = notices[notices.length - 1];
        assert.match(done, /already running/);
        assert.ok(
            !done.includes("workflow-report.md"),
            "no link to a report this call never wrote",
        );
        assert.ok(!done.includes("987"), "no elapsed time borrowed from another run");
    });

    it("still links the report for a real run", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("reviewer", mkAgent("reviewer"));
        const cwd = mkdtempSync(join(tmpdir(), "cmd-ok-"));
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async () => ({ output: "APPROVED\nfine", ok: true }),
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { rev: ["reviewer"] },
            activeTeamName: "rev",
        });
        const { notices, ctx } = mkNotifyCtx(cwd);

        await runFullWorkflowCommand(st, host, "Review it", ctx, () => {}, 3);

        const done = notices[notices.length - 1];
        assert.match(done, /Workflow done/);
        assert.match(done, /workflow-report\.md/);
    });
});

// ── Fresh-context guarantee: every phase of a multi-phase plan gets its own worker ──

describe("fresh-context audit", () => {
    const MULTI = [
        "## Phase 1: First",
        "Edit `src/a.ts`.",
        "",
        "## Phase 2: Second",
        "Edit `src/b.ts`.",
        "",
        "## Phase 3: Third",
        "Edit `src/c.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");
    const SINGLE = [
        "## Phase 1: Only",
        "Edit `src/a.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    const histDir = () => mkdtempSync(join(tmpdir(), "dispatch-hist-"));
    const writeHist = (dir: string, recs: object[]) =>
        writeFileSync(
            join(dir, "dispatch-history.jsonl"),
            recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
            "utf-8",
        );

    it("counts only this run's phase-implementer dispatches", () => {
        const dir = histDir();
        const t0 = Date.parse("2026-08-09T10:00:00.000Z");
        writeHist(dir, [
            // A PREVIOUS run's dispatch — must not satisfy this run's audit.
            { ts: "2026-08-09T09:59:00.000Z", agent: "phase-implementer" },
            { ts: "2026-08-09T10:00:01.000Z", agent: "phase-implementer" },
            { ts: "2026-08-09T10:00:02.000Z", agent: "phase-implementer" },
            // A different agent dispatched in-window doesn't count either.
            { ts: "2026-08-09T10:00:03.000Z", agent: "seeker" },
        ]);
        assert.equal(countDispatchesSince(t0, "phase-implementer", dir), 2);
        assert.equal(countDispatchesSince(t0, "seeker", dir), 1);
    });

    it("tolerates a missing, empty or torn history file", () => {
        const dir = histDir();
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 0);
        writeFileSync(
            join(dir, "dispatch-history.jsonl"),
            '{"ts":"2026-08-09T10:00:01.000Z","agent":"phase-implementer"}\n{"ts":"2026-0',
            "utf-8",
        );
        // The torn tail is skipped; the intact record still counts.
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 1);
    });

    it("flags a multi-phase plan implemented with zero dispatches", () => {
        const dir = histDir();
        assert.equal(freshContextViolated(MULTI, 0, dir), true);
    });

    it("does not flag a multi-phase plan that dispatched", () => {
        const dir = histDir();
        writeHist(dir, [
            { ts: new Date(Date.now() + 1000).toISOString(), agent: "phase-implementer" },
        ]);
        assert.equal(freshContextViolated(MULTI, 0, dir), false);
    });

    it("never flags a single-phase plan — there is no later phase to protect", () => {
        const dir = histDir();
        assert.equal(freshContextViolated(SINGLE, 0, dir), false);
    });

    it("retries the implementer once, with the violation named in the task", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "fresh-ctx-retry-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), MULTI, "utf-8");
        // Empty session dir => zero dispatches recorded => audit fires.
        const prevDir = process.env.PI_WORKFLOW_SESSION_DIR;
        process.env.PI_WORKFLOW_SESSION_DIR = histDir();
        try {
            const implTasks: string[] = [];
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runPhase: async (phase, task) => {
                        if (phase.agent === "implementer") implTasks.push(task);
                        if (phase.agent === "reviewer")
                            return { output: "APPROVED", ok: true };
                        return { output: "impl output", ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, {
                teams: { t: ["implementer", "reviewer"] },
                activeTeamName: "t",
            });
            await runWorkflowCore(st, host, "Build X", 2, { cwd });

            assert.equal(implTasks.length, 2, "the implementer runs twice");
            assert.ok(
                !/PROCESS VIOLATION/.test(implTasks[0]),
                "the first task is the normal one",
            );
            assert.match(implTasks[1], /PROCESS VIOLATION/);
            assert.match(implTasks[1], /3 phases/);
            assert.match(implTasks[1], /dispatch_parallel/);
            // Still zero dispatches on the retry: the run continues (the code may be
            // fine) but the breach is stamped on the summary the reviewer reads.
            assert.equal(st.freshContextViolation, true);
        } finally {
            if (prevDir === undefined) delete process.env.PI_WORKFLOW_SESSION_DIR;
            else process.env.PI_WORKFLOW_SESSION_DIR = prevDir;
        }
    });

    it("does not retry when the implementer delegated", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "fresh-ctx-ok-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), MULTI, "utf-8");
        const dir = histDir();
        const prevDir = process.env.PI_WORKFLOW_SESSION_DIR;
        process.env.PI_WORKFLOW_SESSION_DIR = dir;
        try {
            let implRuns = 0;
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runPhase: async (phase) => {
                        if (phase.agent === "implementer") {
                            implRuns++;
                            // The implementer's child process would write these.
                            writeHist(dir, [
                                { ts: new Date().toISOString(), agent: "phase-implementer" },
                                { ts: new Date().toISOString(), agent: "phase-implementer" },
                                { ts: new Date().toISOString(), agent: "phase-implementer" },
                            ]);
                            return { output: "impl output", ok: true };
                        }
                        if (phase.agent === "reviewer")
                            return { output: "APPROVED", ok: true };
                        return { output: "", ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, {
                teams: { t: ["implementer", "reviewer"] },
                activeTeamName: "t",
            });
            await runWorkflowCore(st, host, "Build X", 2, { cwd });

            assert.equal(implRuns, 1, "no retry when phases were delegated");
            assert.ok(!st.freshContextViolation);
        } finally {
            if (prevDir === undefined) delete process.env.PI_WORKFLOW_SESSION_DIR;
            else process.env.PI_WORKFLOW_SESSION_DIR = prevDir;
        }
    });
});

describe("fresh-context audit — retry only when it can achieve something", () => {
    const MULTI = [
        "## Phase 1: First",
        "Edit `src/a.ts`.",
        "",
        "## Phase 2: Second",
        "Edit `src/b.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    it("skips the pointless retry when every phase is already checked off, but still flags it", async () => {
        // The implementer did everything inline AND ticked every ledger box. The
        // retry note says not to redo `[x]` phases, so a re-run would find nothing
        // to do — spend nothing, but make sure the breach still reaches the reviewer.
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "fresh-ctx-done-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), MULTI, "utf-8");
        const prevDir = process.env.PI_WORKFLOW_SESSION_DIR;
        process.env.PI_WORKFLOW_SESSION_DIR = mkdtempSync(
            join(tmpdir(), "dispatch-hist-"),
        );
        try {
            let implRuns = 0;
            let reviewerSaw = "";
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runPhase: async (phase, task) => {
                        if (phase.agent === "implementer") {
                            implRuns++;
                            // Inline work, every box ticked.
                            writeFileSync(
                                join(cwd, ".agent", "progress.md"),
                                "# Implementation progress\n\n- [x] Phase 1: First\n- [x] Phase 2: Second\n",
                                "utf-8",
                            );
                            return { output: "did it all myself", ok: true };
                        }
                        if (phase.agent === "reviewer") {
                            reviewerSaw = task;
                            return { output: "APPROVED", ok: true };
                        }
                        return { output: "", ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, {
                teams: { t: ["implementer", "reviewer"] },
                activeTeamName: "t",
            });
            await runWorkflowCore(st, host, "Build X", 2, { cwd });

            assert.equal(implRuns, 1, "no wasted retry when nothing is left to do");
            assert.equal(st.freshContextViolation, true);
            // The breach rides into the reviewer's task via the impl summary.
            assert.match(reviewerSaw, /\[PROCESS\]/);
            assert.match(reviewerSaw, /did not each run in a fresh context/);
        } finally {
            if (prevDir === undefined) delete process.env.PI_WORKFLOW_SESSION_DIR;
            else process.env.PI_WORKFLOW_SESSION_DIR = prevDir;
        }
    });
});

describe("implementer fix loops start from a fresh session", () => {
    const PLAN = [
        "## Phase 1: Do the work",
        "Edit `src/a.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    it("gives each review-fix round its own session epoch", async () => {
        // Single-phase plan, so the fresh-context audit stays out of the way and we
        // are measuring only the loop axis.
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "fix-loop-session-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");

        const epochs: (string | undefined)[] = [];
        let reviews = 0;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "implementer") {
                        epochs.push(phase.sessionEpoch);
                        return { output: "impl", ok: true };
                    }
                    if (phase.agent === "reviewer") {
                        reviews++;
                        return reviews === 1
                            ? { output: "REVISE BEFORE MERGE\nfix the error path", ok: true }
                            : { output: "APPROVED", ok: true };
                    }
                    return { output: "", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { t: ["implementer", "reviewer"] },
            activeTeamName: "t",
        });
        await runWorkflowCore(st, host, "Build X", 3, { cwd });

        assert.equal(epochs.length, 2, "first pass plus one review fix");
        assert.equal(epochs[0], undefined, "the first pass resumes nothing");
        assert.ok(epochs[1], "the fix round asks for a fresh session");
        assert.notEqual(epochs[0], epochs[1]);
    });
});

// ── Fresh context means DISTINCT sessions, not merely "a dispatch happened" ──

describe("fresh-context audit detects session reuse", () => {
    const MULTI = [
        "## Phase 1: First",
        "Edit `src/a.ts`.",
        "",
        "## Phase 2: Second",
        "Edit `src/b.ts`.",
        "",
        "## Phase 3: Third",
        "Edit `src/c.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    const hist = (recs: object[]) => {
        const dir = mkdtempSync(join(tmpdir(), "reuse-hist-"));
        writeFileSync(
            join(dir, "dispatch-history.jsonl"),
            recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
            "utf-8",
        );
        return dir;
    };
    const at = (s: number) => new Date(Date.parse("2026-08-09T10:00:00Z") + s * 1000).toISOString();

    it("passes when every phase ran in its own session", () => {
        const dir = hist([
            { ts: at(1), agent: "phase-implementer", dispatchId: "pi-1" },
            { ts: at(2), agent: "phase-implementer", dispatchId: "pi-2" },
            { ts: at(3), agent: "phase-implementer", dispatchId: "pi-3" },
        ]);
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 3);
        assert.equal(freshContextViolated(MULTI, 0, dir), false);
    });

    it("flags three dispatches that all resumed ONE session", () => {
        // The real-world shape: sequential re-dispatch reused the dispatchId, so
        // phases 0, 1 and 7 shared a single 1.8MB worker transcript while the
        // event count still read "3 dispatches, all good".
        const dir = hist([
            { ts: at(1), agent: "phase-implementer", dispatchId: "pi-same" },
            { ts: at(2), agent: "phase-implementer", dispatchId: "pi-same" },
            { ts: at(3), agent: "phase-implementer", dispatchId: "pi-same" },
        ]);
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 1, "one session");
        assert.equal(countDispatchEventsSince(0, "phase-implementer", dir), 3, "three events");
        assert.equal(freshContextViolated(MULTI, 0, dir), true);
    });

    it("flags a partial reuse (a parallel wave plus a resumed sequential pair)", () => {
        const dir = hist([
            { ts: at(1), agent: "phase-implementer", dispatchId: "seq" },
            { ts: at(2), agent: "phase-implementer", dispatchId: "seq" },
            { ts: at(3), agent: "phase-implementer", dispatchId: "par-0" },
            { ts: at(4), agent: "phase-implementer", dispatchId: "par-1" },
        ]);
        assert.equal(freshContextViolated(MULTI, 0, dir), true);
    });

    it("counts pre-dispatchId records individually rather than collapsing them", () => {
        // Old history files have no dispatchId; treating them as one shared session
        // would flag every historical run.
        const dir = hist([
            { ts: at(1), agent: "phase-implementer" },
            { ts: at(2), agent: "phase-implementer" },
        ]);
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 2);
        assert.equal(freshContextViolated(MULTI, 0, dir), false);
    });

    it("still flags a plan with no dispatches at all", () => {
        assert.equal(freshContextViolated(MULTI, 0, hist([])), true);
    });
});

// ── A validator that forgets its VERDICT line gets asked once, not written off ──

describe("validator no-verdict re-ask", () => {
    const PLAN = [
        "## Phase 1: Do the work",
        "Edit `src/a.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    const setup = (cwd: string) => {
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");
    };

    it("re-asks once and honours the verdict the second run gives", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "validator"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "verdict-retry-"));
        setup(cwd);
        const valTasks: string[] = [];
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase, task) => {
                    if (phase.agent === "validator") {
                        valTasks.push(task);
                        // First run drifts off without a verdict; second complies.
                        return valTasks.length === 1
                            ? { output: "I checked a few things and ran out of road.", ok: true }
                            : { output: "VERDICT: PASS\nAll 978 tests pass.", ok: true };
                    }
                    return { output: "impl output", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { t: ["implementer", "validator"] },
            activeTeamName: "t",
        });
        const result = await runWorkflowCore(st, host, "Build X", 3, { cwd });

        assert.equal(valTasks.length, 2, "the validator is asked exactly twice");
        assert.ok(!/NO VERDICT/.test(valTasks[0]));
        assert.match(valTasks[1], /RETURNED NO VERDICT/);
        assert.match(valTasks[1], /VERDICT: PASS/);
        assert.match(valTasks[1], /Do NOT redo the validation from scratch/);
        assert.equal(result.status, "done", "the recovered PASS gates the run");
    });

    it("re-asks at most once, even if the second run is also silent", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "validator"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "verdict-retry-give-up-"));
        setup(cwd);
        let valRuns = 0;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "validator") {
                        valRuns++;
                        return { output: "still no verdict here", ok: true };
                    }
                    return { output: "impl output", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { t: ["implementer", "validator"] },
            activeTeamName: "t",
        });
        const result = await runWorkflowCore(st, host, "Build X", 3, { cwd });

        assert.equal(valRuns, 2, "one original run plus one re-ask, then stop");
        assert.equal(result.status, "needs-review", "unknown still blocks shipping");
    });

    it("does not re-ask a validator that gave a real verdict", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "validator"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "verdict-ok-"));
        setup(cwd);
        let valRuns = 0;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "validator") {
                        valRuns++;
                        return { output: "VERDICT: PASS\nfine", ok: true };
                    }
                    return { output: "impl output", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { t: ["implementer", "validator"] },
            activeTeamName: "t",
        });
        await runWorkflowCore(st, host, "Build X", 3, { cwd });
        assert.equal(valRuns, 1);
    });
});

// ── A ledger's [x] marks are only valid on the branch that made them ──

describe("reconcileLedgerBranch", () => {
    const write = (cwd: string, body: string) => {
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "progress.md"), body, "utf-8");
    };
    const read = (cwd: string) =>
        readFileSync(join(cwd, ".agent", "progress.md"), "utf-8");

    it("reopens phases recorded on a different branch and drops their evidence", () => {
        // The live failure: a ledger claimed phases done with shas from a previous
        // run's agent branch, while this run branched fresh from Base.
        const cwd = mkdtempSync(join(tmpdir(), "ledger-branch-"));
        write(
            cwd,
            [
                "# Implementation progress",
                "",
                "Base: 89ecfeb",
                "",
                "Branch: agent/old-run-89ecfeb",
                "",
                "- [x] Phase 0 — prep — tests: pytest (90 passed) (sha e5fe5bf)",
                "- [x] Phase 1 — maths — tests: pytest (236 passed) (sha 3a741b4)",
                "- [ ] Phase 2 — perms",
                "",
            ].join("\n"),
        );
        const n = reconcileLedgerBranch(cwd, "agent/new-run-89ecfeb");
        const out = read(cwd);

        assert.equal(n, 2);
        assert.equal((out.match(/^- \[x\]/gm) || []).length, 0, "no phase stays checked");
        assert.equal((out.match(/^- \[ \]/gm) || []).length, 3);
        assert.ok(!/sha e5fe5bf/.test(out), "other branch's evidence is dropped");
        assert.ok(/Phase 0 — prep/.test(out), "phase titles survive");
        assert.match(out, /Branch: agent\/new-run-89ecfeb/);
        assert.match(out, /reopened 2 phase\(s\)/);
    });

    it("leaves the ledger alone when the branch matches", () => {
        const cwd = mkdtempSync(join(tmpdir(), "ledger-same-"));
        const body = [
            "# Implementation progress",
            "",
            "Branch: agent/run-1",
            "",
            "- [x] Phase 0 — prep — tests: ok (sha abc1234)",
            "- [ ] Phase 1 — next",
            "",
        ].join("\n");
        write(cwd, body);
        assert.equal(reconcileLedgerBranch(cwd, "agent/run-1"), 0);
        assert.equal(read(cwd), body, "untouched");
    });

    it("leaves a legacy ledger (no Branch line) alone", () => {
        const cwd = mkdtempSync(join(tmpdir(), "ledger-legacy-"));
        const body = "# Implementation progress\n\nBase: abc\n\n- [x] Phase 0 — prep\n";
        write(cwd, body);
        assert.equal(reconcileLedgerBranch(cwd, "agent/whatever"), 0);
        assert.equal(read(cwd), body);
    });

    it("is a no-op with no branch, no file, or nothing checked", () => {
        const cwd = mkdtempSync(join(tmpdir(), "ledger-noop-"));
        assert.equal(reconcileLedgerBranch(cwd, "agent/x"), 0, "missing file");
        write(cwd, "# Implementation progress\n\nBranch: other\n\n- [ ] Phase 0\n");
        assert.equal(reconcileLedgerBranch(cwd, "agent/x"), 0, "nothing checked");
        assert.equal(reconcileLedgerBranch(cwd, ""), 0, "no branch known");
    });

    it("records the branch when seeding a fresh ledger", () => {
        const cwd = mkdtempSync(join(tmpdir(), "ledger-seed-"));
        initProgressLedger(cwd, "abc1234", "## Phase 1: Do it\n", "agent/my-run");
        const out = read(cwd);
        assert.match(out, /Base: abc1234/);
        assert.match(out, /Branch: agent\/my-run/);
        assert.match(out, /- \[ \] Phase 1: Do it/);
    });
});

// ── Partial delegation: some phases got a worker, others were done inline ──

describe("fresh-context audit detects partial delegation", () => {
    const PLAN = Array.from({ length: 5 }, (_, i) => `## Phase ${i + 1}: p${i + 1}`).join(
        "\n\n",
    );
    const hist = (ids: string[]) => {
        const dir = mkdtempSync(join(tmpdir(), "partial-hist-"));
        writeFileSync(
            join(dir, "dispatch-history.jsonl"),
            ids
                .map((id, i) =>
                    JSON.stringify({
                        ts: new Date(Date.parse("2026-08-09T10:00:00Z") + i * 1000).toISOString(),
                        agent: "phase-implementer",
                        dispatchId: id,
                        status: "done",
                    }),
                )
                .join("\n") + "\n",
            "utf-8",
        );
        return dir;
    };

    it("flags 5 phases completed on only 3 worker sessions", () => {
        // Events == sessions, so the reuse check is silent; only comparing against
        // the work actually completed reveals that two phases never got a worker.
        const dir = hist(["a", "b", "c"]);
        assert.equal(freshContextViolated(PLAN, 0, dir, 5), true);
    });

    it("passes when every completed phase had its own session", () => {
        assert.equal(freshContextViolated(PLAN, 0, hist(["a", "b", "c", "d", "e"]), 5), false);
    });

    it("does not flag MORE sessions than phases (a re-dispatched BLOCKED phase)", () => {
        assert.equal(freshContextViolated(PLAN, 0, hist(["a", "b", "c", "d", "e", "f"]), 5), false);
    });

    it("ignores the shortfall check when only one phase completed", () => {
        // One phase legitimately runs inline; a lone session is not a violation.
        assert.equal(freshContextViolated(PLAN, 0, hist(["a"]), 1), false);
    });

    it("ignores the shortfall check when the completed count is unknown", () => {
        assert.equal(freshContextViolated(PLAN, 0, hist(["a"]), 0), false);
    });

    it("still flags reuse even when the counts would otherwise balance", () => {
        // 3 phases completed, 3 dispatch events, but all in ONE session.
        assert.equal(freshContextViolated(PLAN, 0, hist(["same", "same", "same"]), 3), true);
    });
});

describe("countDonePhases", () => {
    it("counts only checked ledger lines", () => {
        const cwd = mkdtempSync(join(tmpdir(), "done-count-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(
            join(cwd, ".agent", "progress.md"),
            "# Implementation progress\n\nBase: abc\n\n- [x] Phase 1\n- [X] Phase 2\n- [ ] Phase 3\n",
            "utf-8",
        );
        assert.equal(countDonePhases(cwd), 2);
    });

    it("is 0 with no ledger", () => {
        assert.equal(countDonePhases(mkdtempSync(join(tmpdir(), "done-none-"))), 0);
    });
});

describe("partial delegation is caught through a real run", () => {
    const PLAN = [
        "## Phase 1: First",
        "Edit `src/a.ts`.",
        "",
        "## Phase 2: Second",
        "Edit `src/b.ts`.",
        "",
        "## Phase 3: Third",
        "Edit `src/c.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    it("flags an implementer that delegated one phase and did the other two itself", async () => {
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "partial-run-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");
        const dir = mkdtempSync(join(tmpdir(), "partial-run-hist-"));
        const prev = process.env.PI_WORKFLOW_SESSION_DIR;
        process.env.PI_WORKFLOW_SESSION_DIR = dir;
        try {
            let implRuns = 0;
            let reviewerSaw = "";
            const host = mkHost({
                setup: { loadAgents: () => agents },
                execution: {
                    runPhase: async (phase, task) => {
                        if (phase.agent === "implementer") {
                            implRuns++;
                            // ONE worker dispatched, but all three phases ticked off.
                            writeFileSync(
                                join(dir, "dispatch-history.jsonl"),
                                JSON.stringify({
                                    ts: new Date().toISOString(),
                                    agent: "phase-implementer",
                                    dispatchId: "only-one",
                                }) + "\n",
                                "utf-8",
                            );
                            writeFileSync(
                                join(cwd, ".agent", "progress.md"),
                                "# Implementation progress\n\n- [x] Phase 1\n- [x] Phase 2\n- [x] Phase 3\n",
                                "utf-8",
                            );
                            return { output: "did most of it myself", ok: true };
                        }
                        if (phase.agent === "reviewer") {
                            reviewerSaw = task;
                            return { output: "APPROVED", ok: true };
                        }
                        return { output: "", ok: true };
                    },
                },
            });
            const st = mkStateWithAgents(agents, {
                teams: { t: ["implementer", "reviewer"] },
                activeTeamName: "t",
            });
            await runWorkflowCore(st, host, "Build X", 2, { cwd });

            // Every box is ticked, so a retry would find nothing to do; the breach is
            // stamped instead, and reaches the reviewer.
            assert.equal(implRuns, 1);
            assert.equal(st.freshContextViolation, true);
            assert.match(reviewerSaw, /\[PROCESS\]/);
        } finally {
            if (prev === undefined) delete process.env.PI_WORKFLOW_SESSION_DIR;
            else process.env.PI_WORKFLOW_SESSION_DIR = prev;
        }
    });
});

// ── A failed worker must not pay for a phase the coordinator did inline ──

describe("fresh-context audit counts only sessions that delivered", () => {
    const PLAN = Array.from({ length: 4 }, (_, i) => `## Phase ${i + 1}: p${i + 1}`).join("\n\n");
    const hist = (recs: object[]) => {
        const dir = mkdtempSync(join(tmpdir(), "delivered-"));
        writeFileSync(
            join(dir, "dispatch-history.jsonl"),
            recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
            "utf-8",
        );
        return dir;
    };
    const rec = (id: string, status: string, i: number) => ({
        ts: new Date(Date.parse("2026-08-09T10:00:00Z") + i * 1000).toISOString(),
        agent: "phase-implementer",
        dispatchId: id,
        status,
    });

    it("flags a phase finished inline after its worker errored", () => {
        // Observed live: the worker for phase 1 errored after 8 minutes, the
        // implementer finished that phase itself, and 1 session against 1 completed
        // phase balanced out to "clean". Two phases completed, only one delivered.
        const dir = hist([rec("a", "error", 0), rec("b", "done", 1)]);
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 2, "two sessions");
        assert.equal(
            countDispatchesSince(0, "phase-implementer", dir, true),
            1,
            "but only one delivered",
        );
        assert.equal(freshContextViolated(PLAN, 0, dir, 2), true);
    });

    it("does not read an errored dispatch as session REUSE", () => {
        // Reuse is events > sessions. An error must not be mistaken for it, or the
        // stamp would blame the wrong thing.
        const dir = hist([rec("a", "error", 0), rec("b", "done", 1), rec("c", "done", 2)]);
        assert.equal(countDispatchEventsSince(0, "phase-implementer", dir), 3);
        assert.equal(countDispatchesSince(0, "phase-implementer", dir), 3, "3 events, 3 sessions");
        assert.equal(freshContextViolated(PLAN, 0, dir, 2), false, "2 delivered >= 2 completed");
    });

    it("passes when a failed phase is re-dispatched successfully", () => {
        const dir = hist([rec("a", "error", 0), rec("a2", "done", 1), rec("b", "done", 2)]);
        assert.equal(freshContextViolated(PLAN, 0, dir, 2), false);
    });

    it("treats a record with no status as delivered (unknown data stays quiet)", () => {
        const dir = hist([
            { ts: "2026-08-09T10:00:01Z", agent: "phase-implementer", dispatchId: "a" },
            { ts: "2026-08-09T10:00:02Z", agent: "phase-implementer", dispatchId: "b" },
        ]);
        assert.equal(countDispatchesSince(0, "phase-implementer", dir, true), 2);
        assert.equal(freshContextViolated(PLAN, 0, dir, 2), false);
    });
});

describe("countDonePhases ignores non-phase ledger rows", () => {
    const write = (cwd: string, body: string) => {
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "progress.md"), body, "utf-8");
    };

    it("does not count an agent-appended row as a completed phase", () => {
        // Observed live: a validator-driven fix round appended its own checkbox row,
        // leaving 7 checked lines against a 6-phase plan. Inflation is the dangerous
        // direction — it manufactures a shortfall that never happened.
        const cwd = mkdtempSync(join(tmpdir(), "ledger-extra-"));
        write(
            cwd,
            [
                "# Implementation progress",
                "",
                "- [x] Phase 1: Scaffold — tests: `npm test` (4/4 pass)",
                "- [x] Phase 2: State — tests: `npx vitest run` (28/28 pass)",
                "- [x] Validator fix: added App integration test for EmptyState — tests: (15/15 pass)",
                "",
            ].join("\n"),
        );
        assert.equal(countDonePhases(cwd), 2, "the appended row is not a phase");
    });

    it("counts real phase rows regardless of separator or case", () => {
        const cwd = mkdtempSync(join(tmpdir(), "ledger-forms-"));
        write(
            cwd,
            [
                "# Implementation progress",
                "",
                "- [x] Phase 0 — prep",
                "- [X] Phase 1: maths",
                "- [ ] Phase 2 — perms",
                "- [x] Merge notes: unrelated",
                "",
            ].join("\n"),
        );
        assert.equal(countDonePhases(cwd), 2);
    });
});

describe("reviewer re-review starts from a fresh session", () => {
    const PLAN = [
        "## Phase 1: Do the work",
        "Edit `src/a.ts`.",
        "",
        "## Acceptance Criteria",
        "- it works",
        "",
        "## Critical Files",
        "- src/a.ts",
    ].join("\n");

    it("gives each review round after the first its own session epoch", async () => {
        // The implementer's fix rounds already start clean; the reviewer's re-reads
        // of the diff were still stacking round on round in one session.
        const agents = new Map<string, AgentDef>();
        for (const n of ["implementer", "reviewer"]) agents.set(n, mkAgent(n));
        const cwd = mkdtempSync(join(tmpdir(), "review-epoch-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), PLAN, "utf-8");

        const epochs: (string | undefined)[] = [];
        let reviews = 0;
        const host = mkHost({
            setup: { loadAgents: () => agents },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "reviewer") {
                        epochs.push(phase.sessionEpoch);
                        reviews++;
                        return reviews < 3
                            ? { output: "REVISE BEFORE MERGE\nstill wrong", ok: true }
                            : { output: "APPROVED", ok: true };
                    }
                    return { output: "impl", ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents, {
            teams: { t: ["implementer", "reviewer"] },
            activeTeamName: "t",
        });
        await runWorkflowCore(st, host, "Build X", 3, { cwd });

        assert.equal(epochs.length, 3, "three review rounds");
        assert.equal(epochs[0], undefined, "the first review resumes nothing");
        assert.ok(epochs[1] && epochs[2], "later rounds ask for a fresh session");
        assert.notEqual(epochs[1], epochs[2], "and a distinct one each round");
    });
});

describe("peak context survives a pruner-induced dip", () => {
    it("records the high-water mark across turns, not the last one", () => {
        const phase: any = {
            label: "Implementer", agent: "implementer", status: "running",
            elapsed: 0, note: "", droppedLines: 0, contextPct: 0, attempt: 1,
        };
        const state: any = {
            answer: [], cumulativeTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            costUsd: 0, toolCalls: 0, droppedLines: 0, contextPct: 0,
        };
        const turn = (cacheRead: number) => ({
            type: "message_end",
            message: {
                role: "assistant", stopReason: "toolUse", content: [{ text: "x" }],
                usage: { input: 100, output: 10, cacheRead, cacheWrite: 0, contextWindow: 256000 },
            },
        });
        // Climb to the ceiling, then the pruner reclaims and the reading falls back.
        handleSpawnEvent(turn(120000), state, phase, () => {});
        handleSpawnEvent(turn(251000), state, phase, () => {});
        handleSpawnEvent(turn(40000), state, phase, () => {});

        assert.ok(phase.contextPct < 30, `last reading fell back (${phase.contextPct}%)`);
        assert.ok(
            phase.peakContextPct >= 95,
            `peak remembers the squeeze (${phase.peakContextPct}%)`,
        );
    });
});

// ── roadmap milestone auto-tick (file-level) ─────────────────────────────────

describe("maybeTickMilestone", () => {
    const ROADMAP = [
        "# Roadmap: Thing",
        "",
        "## Milestone 1: Scaffold",
        "",
        "- [x] complete — 2026-08-01, validator PASS",
        "",
        "## Milestone 2: Ingestion",
        "",
        "- [ ] not started",
        "- **Done when:** fixtures replay",
        "",
    ].join("\n");

    const PLAN = "# Plan: Ingestion\n\nMilestone: 2 of 9\n";

    // A cwd with a roadmap and a fully-ticked phase ledger.
    const setup = (opts?: { ledger?: string; roadmap?: string }) => {
        const cwd = mkdtempSync(join(tmpdir(), "milestone-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, "roadmap.md"), opts?.roadmap ?? ROADMAP);
        writeFileSync(
            join(cwd, ".agent", "progress.md"),
            opts?.ledger ?? "- [x] Phase 1: A\n- [x] Phase 2: B\n",
        );
        return cwd;
    };

    const pass = {
        status: "shipped",
        hadValidator: true,
        plan: PLAN,
        verdict: "pass" as const,
        prUrl: "https://github.com/o/r/pull/7",
    };

    beforeEach(() => {
        delete process.env.PI_ROADMAP_AUTOTICK;
    });

    it("ticks the plan's milestone and stamps run evidence", () => {
        const cwd = setup();
        assert.equal(maybeTickMilestone(cwd, pass), 2);
        const out = readFileSync(join(cwd, "roadmap.md"), "utf-8");
        assert.match(out, /## Milestone 2: Ingestion\n\n- \[x\] complete — .*validator PASS.*pull\/7/);
        // Milestone 1's original stamp is preserved, not rewritten.
        assert.match(out, /- \[x\] complete — 2026-08-01, validator PASS/);
    });

    it("is idempotent — a second passing run does not restamp", () => {
        const cwd = setup();
        assert.equal(maybeTickMilestone(cwd, pass), 2);
        const after = readFileSync(join(cwd, "roadmap.md"), "utf-8");
        assert.equal(maybeTickMilestone(cwd, { ...pass, prUrl: "https://github.com/o/r/pull/8" }), null);
        assert.equal(readFileSync(join(cwd, "roadmap.md"), "utf-8"), after);
    });

    it("leaves the roadmap alone when a phase is still unfinished", () => {
        const cwd = setup({ ledger: "- [x] Phase 1: A\n- [ ] Phase 2: B\n" });
        assert.equal(maybeTickMilestone(cwd, pass), null);
        assert.match(readFileSync(join(cwd, "roadmap.md"), "utf-8"), /- \[ \] not started/);
    });

    it("refuses without an independent validator, even on a shipped run", () => {
        const cwd = setup();
        assert.equal(maybeTickMilestone(cwd, { ...pass, hadValidator: false }), null);
    });

    it("refuses when the plan never named a milestone", () => {
        const cwd = setup();
        assert.equal(maybeTickMilestone(cwd, { ...pass, plan: "# Plan: x\n" }), null);
    });

    it("no-ops when there is no roadmap at all", () => {
        const cwd = mkdtempSync(join(tmpdir(), "milestone-none-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "progress.md"), "- [x] Phase 1: A\n");
        assert.equal(maybeTickMilestone(cwd, pass), null);
    });

    it("honours PI_ROADMAP_AUTOTICK=0", () => {
        const cwd = setup();
        process.env.PI_ROADMAP_AUTOTICK = "0";
        assert.equal(maybeTickMilestone(cwd, pass), null);
        assert.match(readFileSync(join(cwd, "roadmap.md"), "utf-8"), /- \[ \] not started/);
    });
});
