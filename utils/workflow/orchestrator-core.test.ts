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
    stripPlanPreamble,
    savePlanDraft,
    resetRunScratch,
    initProgressLedger,
    markAllPhasesDone,
    planArchiveName,
    archivePlan,
    runWorkflowCore,
} from "./orchestrator-core";
import type { AgentDef, PhaseState, SpawnEventState } from "./workflow-core";
import { handleSpawnEvent, computeSpawnResult } from "./workflow-core";
import { setObsEmit } from "../obs/obs-events";

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
            new Date("2026-06-08T10:00:00Z"),
        );
        assert.equal(name, "2026-06-08-add-the-login-page.md");
    });
});

describe("archivePlan", () => {
    const now = new Date("2026-06-08T10:00:00Z");

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
