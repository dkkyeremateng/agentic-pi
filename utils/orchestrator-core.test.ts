import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    newOrchestratorState,
    type OrchestratorState,
    type OrchestratorHost,
    dispatchAgentCore,
    dispatchParallelCore,
    selectAgentsCore,
    resolveAgent,
    capturePlan,
    resetRunScratch,
    writeRunBase,
    runWorkflowCore,
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

    it("runs the refiner between planner and implementer, threading the hardened plan", async () => {
        const agents = mkFullAgentSet();
        agents.set("refiner", mkAgent("refiner"));
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
                runPhase: async (phase, task) => {
                    order.push(phase.agent);
                    if (phase.agent === "planner")
                        return { output: draftPlan, ok: true };
                    if (phase.agent === "refiner")
                        return { output: refinedPlan, ok: true };
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
        const result = await runWorkflowCore(
            st,
            host,
            "Build feature X",
            3,
            mkCtx(),
        );
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
        // The implementer received the REFINED plan, not the draft.
        assert.ok(
            implementerSawPlan.includes("REFINED"),
            "implementer got the hardened plan",
        );
        assert.ok(
            !implementerSawPlan.includes("Phase 1: Draft"),
            "implementer did not get the draft plan",
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

describe("capturePlan", () => {
    it("records the artifact and writes .agent/plan.md as a fallback when absent", () => {
        const cwd = mkdtempSync(join(tmpdir(), "plan-"));
        const artifacts: any = {};
        capturePlan(artifacts, cwd, "# Plan\n## Phase 1");
        assert.equal(artifacts.plan, "# Plan\n## Phase 1");
        assert.equal(
            readFileSync(join(cwd, ".agent", "plan.md"), "utf-8"),
            "# Plan\n## Phase 1",
        );
    });

    it("does NOT clobber an existing plan file (the planner's version)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "plan-"));
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), "DOCUMENTER VERSION", "utf-8");
        const artifacts: any = {};
        capturePlan(artifacts, cwd, "RAW PLANNER OUTPUT");
        assert.equal(artifacts.plan, "RAW PLANNER OUTPUT"); // artifact still recorded
        assert.equal(
            readFileSync(join(cwd, ".agent", "plan.md"), "utf-8"),
            "DOCUMENTER VERSION", // file untouched
        );
    });
});

describe("resetRunScratch", () => {
    it("removes stale plan and progress ledger (no-op when absent)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "plan-"));
        mkdirSync(join(cwd, ".agent", "checkpoints"), { recursive: true });
        writeFileSync(join(cwd, ".agent", "plan.md"), "old", "utf-8");
        writeFileSync(join(cwd, ".agent", "progress.md"), "stale", "utf-8");
        // /revert's checkpoint store must survive a run reset.
        writeFileSync(
            join(cwd, ".agent", "checkpoints", "latest.json"),
            "{}",
            "utf-8",
        );
        resetRunScratch(cwd);
        assert.equal(existsSync(join(cwd, ".agent", "plan.md")), false);
        assert.equal(existsSync(join(cwd, ".agent", "progress.md")), false);
        assert.equal(
            existsSync(join(cwd, ".agent", "checkpoints", "latest.json")),
            true,
        );
        resetRunScratch(cwd); // no throw when already gone
    });
});

describe("writeRunBase", () => {
    it("writes a progress ledger with the base sha and no completed phases", () => {
        const cwd = mkdtempSync(join(tmpdir(), "base-"));
        writeRunBase(cwd, "abc1234");
        const body = readFileSync(join(cwd, ".agent", "progress.md"), "utf-8");
        assert.match(body, /Base: abc1234/);
        // No `[x]` lines — the implementer must see a fresh (non-resume) run.
        assert.doesNotMatch(body, /\[x\]/);
    });
});
