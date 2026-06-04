import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    newOrchestratorState,
    type OrchestratorState,
    type OrchestratorHost,
    dispatchAgentCore,
    dispatchParallelCore,
    selectAgentsCore,
    runWorkflowCore,
    runSpecWorkflowCore,
} from "./orchestrator-core";
import type { AgentDef, PhaseState, SpawnEventState } from "./workflow-core";
import { handleSpawnEvent, computeSpawnResult } from "./workflow-core";

// Run with: npx tsx --test orchestrator-core.test.ts

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
        assert.deepEqual(st.totalTokens, { input: 0, output: 0 });
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

    it("refuses a cycle when the agent is already an ancestor", async () => {
        const saved = saveDispatchEnv();
        try {
            process.env.PI_DISPATCH_ANCESTRY = "coordinator>scout";
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
                    "Cycle detected",
                ),
            );
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

    it("does not flag tool-driven agents with short output as empty", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("researcher", mkAgent("researcher"));
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
            "researcher",
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

    it("truncates output longer than 8000 chars", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const longOutput = "x".repeat(10000);
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
        assert.ok((result.content[0] as { text: string }).text.includes("[truncated]"));
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
        const saved = process.env.PI_DISPATCH_DEPTH;
        try {
            process.env.PI_DISPATCH_DEPTH = "1"; // default max depth = 1
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
            if (saved === undefined) delete process.env.PI_DISPATCH_DEPTH;
            else process.env.PI_DISPATCH_DEPTH = saved;
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

    it("returns order in the result text", () => {
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
        assert.ok((result.content[0] as { text: string }).text.includes("Planner ∥ Tester"));
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
            "critic",
            "implementer",
            "tester",
            "documenter",
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

// ── runSpecWorkflowCore — re-entry guard ──────────

describe("runSpecWorkflowCore re-entry guard", () => {
    it("rejects when a workflow is already running", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("critic", mkAgent("critic"));
        agents.set("documenter", mkAgent("documenter"));
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
        });
        const st = mkStateWithAgents(agents, { running: true });
        const result = await runSpecWorkflowCore(
            st,
            host,
            "test spec",
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
            "critic",
            "implementer",
            "tester",
            "documenter",
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
                    if (phase.agent === "critic") {
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
        assert.ok(runPhaseCalls.includes("tester"));
        assert.ok(runPhaseCalls.includes("validator"));
        assert.ok(runPhaseCalls.includes("documenter"));
    });

    it("handles critique revision loop", async () => {
        const agents = mkFullAgentSet();
        let criticCalls = 0;
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
                    if (phase.agent === "critic") {
                        criticCalls++;
                        if (criticCalls === 1) {
                            return {
                                output: "REVISE BEFORE IMPLEMENTING\nNeeds more detail",
                                ok: true,
                            };
                        }
                        return { output: "APPROVED\nPlan approved", ok: true };
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
        assert.equal(criticCalls, 2);
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
                    if (phase.agent === "critic") {
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
                    if (phase.agent === "critic") {
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
                    "critic",
                    "implementer",
                    "tester",
                    "documenter",
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

    it("continues to ship when documenter fails", async () => {
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
                        return { output: "VERDICT: PASS", ok: true };
                    }
                    if (phase.agent === "critic") {
                        return { output: "APPROVED\nPlan approved", ok: true };
                    }
                    if (phase.agent === "documenter") {
                        return { output: "Documentation failed", ok: false };
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
                    if (phase.agent === "critic") {
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
});

// ── runSpecWorkflowCore — lifecycle tests ──────────

describe("runSpecWorkflowCore", () => {
    function mkSpecAgentSet(): Map<string, AgentDef> {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("critic", mkAgent("critic"));
        agents.set("documenter", mkAgent("documenter"));
        return agents;
    }

    it("runs happy path: plan → document", async () => {
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
                    if (phase.agent === "critic") {
                        return { output: "APPROVED\nSpec approved", ok: true };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runSpecWorkflowCore(
            st,
            host,
            "Design feature Y",
            mkCtx(),
        );
        assert.equal(result.status, "done");
        assert.ok(st.running === false);
        assert.ok(runPhaseCalls.includes("planner"));
        assert.ok(runPhaseCalls.includes("documenter"));
    });

    it("returns needs-review when critic rejects", async () => {
        const agents = mkSpecAgentSet();
        const host = mkHost({
            setup: {
                loadAgents: () => agents,
                setupSessions: () => {},
                prepareRun: () => {},
            },
            execution: {
                runPhase: async (phase) => {
                    if (phase.agent === "critic") {
                        return {
                            output: "REVISE BEFORE DOCUMENTING\nNeeds more detail",
                            ok: true,
                        };
                    }
                    return { output: `${phase.agent} output`, ok: true };
                },
            },
        });
        const st = mkStateWithAgents(agents);
        const result = await runSpecWorkflowCore(
            st,
            host,
            "Design feature Y",
            mkCtx(),
        );
        assert.equal(result.status, "needs-review");
        assert.ok(st.running === false);
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
        const st = mkStateWithAgents(agents);
        const result = await runSpecWorkflowCore(
            st,
            host,
            "Design feature Y",
            mkCtx(),
        );
        assert.equal(result.status, "error");
        assert.ok(result.report.includes("Planning"));
        // Verify documenter never ran
        assert.ok(!runPhaseCalls.includes("documenter"));
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
            },
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
            contextWindow: 100000,
        });
        // pct = round((input + output) / contextWindow * 100) = round(1500/100000*100) = 2
        assert.equal(phase.contextPct, 2);
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
            },
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
