// ABOUTME: Standalone `dispatch` extension. Owns the `dispatch_agent` and
// `select_agents` tools so ANY agent can dispatch a specialist — in a plain pi
// session, not just inside the agent-pipeline / agent-team workflows. Those
// workflows depend on this extension for free-form dispatch but can no longer
// register the tools themselves; instead they subscribe to DISPATCH_UPDATE on
// pi.events and mirror the phase snapshot into their dashboard.
//
// This extension keeps its OWN orchestrator state and emits a phase snapshot on
// every change — it never reaches into a workflow's state. Default UI is plain
// notifications, so dispatch is fully usable with no dashboard mounted.
//
// The workflow extensions (agent-pipeline / agent-team) depend on this extension
// for dispatch: they no longer register dispatch_agent/select_agents themselves and
// instead subscribe to DISPATCH_UPDATE on pi.events. Load all three together.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
    setupSessions as setupSessionsCore,
    runAgentWithFallback,
    makeSpawnWrapper,
    loadAgents as loadAgentsCore,
    resolveAgentModel,
    loadDotEnv,
    displayName,
    renderDispatchAgentCall,
    renderDispatchAgentResult,
    renderSelectAgentsCall,
    renderSelectAgentsResult,
    type AgentDef,
    type PhaseState,
} from "../utils/workflow-core";
import {
    newOrchestratorState,
    type OrchestratorHost,
    dispatchAgentCore,
    selectAgentsCore,
} from "../utils/orchestrator-core";
import { DISPATCH_UPDATE, type DispatchUpdate } from "../utils/dispatch-events";

// Run before any process.env reads below.
loadDotEnv(process.cwd());

// ── Config (mirrors agent-team.ts so dispatch behaves identically) ───────────
const WORKER_MODEL = process.env.PI_WORKFLOW_MODEL || "";
const AGENT_TIMEOUT_MS =
    Math.max(0, parseFloat(process.env.PI_WORKFLOW_AGENT_TIMEOUT || "0") || 0) *
    60_000;
const SHARED_CONTEXT = process.env.PI_AGENT_TEAM_SHARED_CONTEXT !== "0";
const MAX_DISPATCHES_PER_TURN = Math.max(
    1,
    parseInt(process.env.PI_MAX_DISPATCHES_PER_TURN || "20", 10) || 20,
);
const MIN_DISPATCH_OUTPUT_CHARS = 40;

// Agents shipped alongside this extension (`<ext>/../agents`), used as a fallback
// when the cwd has no .pi/agents of its own — same resolution as the workflows.
const INSTALL_AGENTS_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "agents",
);
const loadAgents = (cwd: string) => loadAgentsCore(cwd, INSTALL_AGENTS_DIR);

export default function (pi: ExtensionAPI) {
    // This extension's OWN dispatch state (never a workflow's).
    const st = newOrchestratorState();
    let widgetCtx: any;
    let sessionDir = "";
    let currentProc: any = null;

    const setupSessions = (cwd: string, wipe: boolean) => {
        sessionDir = setupSessionsCore(cwd, wipe);
    };

    function fallbackModel(): string {
        if (WORKER_MODEL) return WORKER_MODEL;
        const m = widgetCtx?.model;
        return (
            (m?.provider && m?.id ? `${m.provider}/${m.id}` : m?.id) || "default"
        );
    }

    // Broadcast the current dispatch phase snapshot to any dashboard listening.
    function emitUpdate() {
        const payload: DispatchUpdate = {
            phases: st.phases,
            dispatchMode: st.dispatchMode,
            dispatchElapsedMs: st.dispatchElapsedMs,
        };
        pi.events.emit(DISPATCH_UPDATE, payload);
    }

    // Thin wrapper around the shared spawnAgentWithModel (per-agent sessions).
    const spawnAgentWithModel = makeSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
        sharedSession: false,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        updateWidget: () => emitUpdate(),
        setCurrentProc: (p: any) => {
            currentProc = p;
        },
    });

    function runAgent(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
    ): Promise<{ output: string; exitCode: number }> {
        const agentKey = agentDef.name.toLowerCase();
        const primaryModel = resolveAgentModel(
            agentKey,
            st.agents,
            WORKER_MODEL,
            fallbackModel(),
        );
        const sm = widgetCtx?.model;
        const sessionModel =
            sm?.provider && sm?.id ? `${sm.provider}/${sm.id}` : sm?.id || "";
        const modelFallback =
            sessionModel && sessionModel !== primaryModel ? sessionModel : "";
        return runAgentWithFallback(
            agentDef,
            task,
            phase,
            cwd,
            primaryModel,
            modelFallback,
            spawnAgentWithModel,
            {
                updateWidget: () => emitUpdate(),
                notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
            },
        );
    }

    // Callbacks the shared dispatch/select logic delegates to. ui.updateWidget
    // emits the snapshot instead of touching a widget directly, so dispatch stays
    // decoupled from any dashboard. runPhase is unused by dispatch/select.
    const host: OrchestratorHost = {
        execution: {
            runPhase: async () => ({ output: "", ok: false }),
            runAgent: (def, task, phase, cwd) => runAgent(def, task, phase, cwd),
        },
        ui: {
            updateWidget: () => emitUpdate(),
            notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
            publishLogs: () => {},
        },
        setup: {
            setupSessions: (cwd, wipe) => setupSessions(cwd, wipe),
            loadAgents: (cwd) => loadAgents(cwd),
            prepareRun: () => {},
        },
        config: {
            sharedContext: SHARED_CONTEXT,
            maxDispatchesPerTurn: MAX_DISPATCHES_PER_TURN,
            minDispatchOutputChars: MIN_DISPATCH_OUTPUT_CHARS,
        },
    };

    // ── dispatch_agent — free-form dispatch to any loaded agent ──────────────
    pi.registerTool({
        name: "dispatch_agent",
        label: "Dispatch Agent",
        description:
            "Dispatch a task to a specialist agent. The agent runs with its configured model and tools, and returns the result. Use this for ad-hoc work (quick lookups, one-off analyses, or running a specific agent with a custom task).",
        parameters: Type.Object({
            agent: Type.String({
                description:
                    "Agent name (case-insensitive). Must be a loaded agent from .pi/agents/.",
            }),
            task: Type.String({
                description: "Task description for the agent to execute.",
            }),
        }),
        async execute(_id, params, _signal, onUpdate, ctx) {
            const { agent, task } = params as { agent: string; task: string };
            widgetCtx = ctx;
            return dispatchAgentCore(st, host, agent, task, onUpdate, ctx);
        },
        renderCall(args, theme) {
            return renderDispatchAgentCall(args, theme, Text);
        },
        renderResult(result, options, theme) {
            return renderDispatchAgentResult(
                result,
                options,
                theme,
                Text,
                Markdown,
                getMarkdownTheme(),
            );
        },
    });

    // ── select_agents — declare the agents the work will use (dashboard plan) ─
    pi.registerTool({
        name: "select_agents",
        label: "Select Agents",
        description:
            "Declare which specialist agents the work will use, in the order you intend to dispatch them. Call this once after determining the plan and before dispatching — it marks the chosen agents on the dashboard. You can still dispatch agents not pre-declared.",
        parameters: Type.Object({
            agents: Type.Array(Type.String(), {
                description:
                    "Agent names (case-insensitive), in dispatch order. Must be loaded agents from .pi/agents/.",
            }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const names = (params as { agents: string[] }).agents || [];
            widgetCtx = ctx;
            return selectAgentsCore(st, host, names, ctx);
        },
        renderCall(args, theme) {
            return renderSelectAgentsCall(args, theme, Text, displayName);
        },
        renderResult(result, _options, theme) {
            return renderSelectAgentsResult(result, _options, theme, Text);
        },
    });

    // ── Lifecycle — load agents and reset per-turn dispatch state ────────────
    pi.on("session_start", async (_event, ctx) => {
        widgetCtx = ctx;
        loadDotEnv(ctx.cwd); // pick up cwd/.env if pi launched elsewhere
        st.agents = loadAgents(ctx.cwd);
        st.dispatchMode = false;
        st.phases = [];
    });

    // A new user request rebuilds dispatch phases from scratch (first dispatch of
    // the turn resets), and resets the per-turn dispatch cap.
    pi.on("before_agent_start", async (_event, ctx) => {
        widgetCtx = ctx;
        st.freshDispatchSession = true;
    });
    pi.on("agent_start", async () => {
        st.primaryTurnStartedAt = Date.now();
        st.dispatchesThisTurn = 0;
    });
}
