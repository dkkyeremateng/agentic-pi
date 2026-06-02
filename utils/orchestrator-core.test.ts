import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    newOrchestratorState,
    type OrchestratorState,
    type OrchestratorHost,
    dispatchAgentCore,
    selectAgentsCore,
} from "./orchestrator-core";
import type { AgentDef, PhaseState } from "./workflow-core";

// Run with: npx tsx --test orchestrator-core.test.ts

// ── Test helpers ─────────────────────────────────

function mkAgent(name: string): AgentDef {
    return {
        name,
        description: `Test agent ${name}`,
        tools: "bash",
        model: "test/model",
        systemPrompt: "You are a test agent.",
    };
}

function mkHost(overrides: Partial<OrchestratorHost> = {}): OrchestratorHost {
    return {
        runPhase: async () => ({ output: "", ok: true }),
        runAgent: async () => ({ output: "test output", exitCode: 0 }),
        updateWidget: () => {},
        notify: () => {},
        setupSessions: () => {},
        loadAgents: () => new Map(),
        prepareRun: () => {},
        publishLogs: () => {},
        sharedContext: true,
        maxDispatchesPerTurn: 20,
        minDispatchOutputChars: 40,
        ...overrides,
    };
}

function mkState(
    overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
    return { ...newOrchestratorState(), ...overrides };
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
        assert.ok(result.content[0].text.includes("Cannot dispatch"));
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
        assert.ok(result.content[0].text.includes("Dispatch limit"));
    });

    it("returns error for unknown agent", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({ loadAgents: () => agents });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "nonexistent",
            "do something",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("not found"));
        assert.ok(result.content[0].text.includes("planner"));
    });

    it("dispatches a known agent successfully", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            loadAgents: () => agents,
            runAgent: async () => ({
                output: "Here is a detailed plan output with enough text for the test",
                exitCode: 0,
            }),
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan something",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("done"));
        assert.equal(st.phases.length, 1);
        assert.equal(st.phases[0].agent, "planner");
        assert.equal(st.phases[0].status, "done");
    });

    it("marks dispatch as error when agent returns non-zero exit", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("tester", mkAgent("tester"));
        const host = mkHost({
            loadAgents: () => agents,
            runAgent: async () => ({
                output: "something failed badly",
                exitCode: 1,
            }),
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "tester",
            "test this",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("error"));
        assert.equal(st.phases[0].status, "error");
    });

    it("flags empty output as failed dispatch", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            loadAgents: () => agents,
            runAgent: async () => ({ output: "   ", exitCode: 0 }),
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("RE-DISPATCH"));
        assert.equal(st.phases[0].status, "error");
    });

    it("does not flag tool-driven agents with short output as empty", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("researcher", mkAgent("researcher"));
        const host = mkHost({
            loadAgents: () => agents,
            minDispatchOutputChars: 40,
            runAgent: async (_def, _task, phase) => {
                // Simulate a tool-driven agent: short output but tool calls made
                phase.toolCount = 5;
                return { output: "Done.", exitCode: 0 };
            },
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "researcher",
            "research this",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("done"));
        assert.equal(st.phases[0].status, "done");
    });

    it("resets phase state on re-dispatch including modelFallback", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        let callCount = 0;
        const host = mkHost({
            loadAgents: () => agents,
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
        });
        const st = mkState();
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
            loadAgents: () => agents,
            runAgent: async () => ({
                output: "enough output text here for testing purposes in this test",
                exitCode: 0,
            }),
        });
        const st = mkState();
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
            loadAgents: () => agents,
            runAgent: async () => ({ output: longOutput, exitCode: 0 }),
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("[truncated]"));
    });

    it("enters dispatch mode on first dispatch", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            loadAgents: () => agents,
            runAgent: async () => ({
                output: "enough output for this test case to pass the minimum character threshold",
                exitCode: 0,
            }),
        });
        const st = mkState({ dispatchMode: false });
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
            loadAgents: () => agents,
            runAgent: async () => ({
                output: "enough output for this test case to pass the minimum character threshold",
                exitCode: 0,
            }),
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
            loadAgents: () => agents,
            runAgent: async () => ({ output: "   ", exitCode: 0 }),
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("RE-DISPATCH"));
    });

    it("signals DONE when all selected agents are complete", async () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({
            loadAgents: () => agents,
            runAgent: async () => ({
                output: "enough output for this test case to pass the minimum character threshold",
                exitCode: 0,
            }),
        });
        const st = mkState();
        const result = await dispatchAgentCore(
            st,
            host,
            "planner",
            "plan",
            undefined,
            mkCtx(),
        );
        // Only one agent dispatched, no pending phases remain
        assert.ok(result.content[0].text.includes("DONE"));
    });
});

// ── selectAgentsCore ─────────────────────────────

describe("selectAgentsCore", () => {
    it("rejects selection when a workflow is running", () => {
        const st = mkState({ running: true });
        const host = mkHost();
        const result = selectAgentsCore(st, host, ["planner"], mkCtx());
        assert.ok(result.content[0].text.includes("Cannot change"));
    });

    it("returns error when no valid agents in selection", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({ loadAgents: () => agents });
        const st = mkState();
        const result = selectAgentsCore(st, host, ["nonexistent"], mkCtx());
        assert.ok(result.content[0].text.includes("No valid agents"));
    });

    it("selects valid agents and ignores unknown", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        agents.set("tester", mkAgent("tester"));
        const host = mkHost({ loadAgents: () => agents });
        const st = mkState();
        const result = selectAgentsCore(
            st,
            host,
            ["planner", "nonexistent", "tester"],
            mkCtx(),
        );
        assert.equal(st.phases.length, 2);
        assert.equal(st.phases[0].agent, "planner");
        assert.equal(st.phases[1].agent, "tester");
        assert.ok(result.content[0].text.includes("ignored unknown"));
        assert.ok(result.content[0].text.includes("nonexistent"));
    });

    it("sets dispatch mode", () => {
        const agents = new Map<string, AgentDef>();
        agents.set("planner", mkAgent("planner"));
        const host = mkHost({ loadAgents: () => agents });
        const st = mkState({ dispatchMode: false });
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
        const host = mkHost({ loadAgents: () => agents });
        const st = mkState({
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
        const host = mkHost({ loadAgents: () => agents });
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
        const host = mkHost({ loadAgents: () => agents });
        const st = mkState();
        const result = selectAgentsCore(
            st,
            host,
            ["planner", "tester"],
            mkCtx(),
        );
        assert.ok(result.content[0].text.includes("Planner → Tester"));
    });
});
