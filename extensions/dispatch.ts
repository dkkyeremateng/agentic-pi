// ABOUTME: Standalone `dispatch` extension. Owns the `dispatch_agent` and
// `select_agents` tools so ANY agent can dispatch a specialist — in a plain pi
// session, not just inside the agent-workflow workflow. That workflow depends on
// this extension for free-form dispatch but can no longer register the tools
// itself; instead it subscribes to DISPATCH_UPDATE on pi.events and mirrors the
// phase snapshot into its dashboard.
//
// This extension keeps its OWN orchestrator state and emits a phase snapshot on
// every change — it never reaches into a workflow's state. Default UI is plain
// notifications, so dispatch is fully usable with no dashboard mounted.
//
// The agent-workflow extension depends on this extension for dispatch: it no longer
// registers dispatch_agent/select_agents itself and instead subscribes to
// DISPATCH_UPDATE on pi.events. Load both together (order doesn't matter — the
// dashboard subscribes on pi.events before any dispatch can fire).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "fs";
import { join } from "path";
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
    renderDispatchParallelResult,
    renderSelectAgentsCall,
    renderSelectAgentsResult,
    type AgentDef,
    type PhaseState,
} from "../utils/workflow/workflow-core";
import {
    newOrchestratorState,
    type OrchestratorHost,
    dispatchAgentCore,
    dispatchParallelCore,
    selectAgentsCore,
} from "../utils/workflow/orchestrator-core";
import {
    DISPATCH_UPDATE,
    type DispatchUpdate,
} from "../utils/workflow/dispatch-events";

// Run before any process.env reads below.
loadDotEnv(process.cwd());

// ── Config (mirrors agent-workflow.ts so dispatch behaves identically) ───────
const WORKER_MODEL = process.env.PI_WORKFLOW_MODEL || "";
const AGENT_TIMEOUT_MS =
    Math.max(0, parseFloat(process.env.PI_WORKFLOW_AGENT_TIMEOUT || "0") || 0) *
    60_000;
const MAX_DISPATCHES_PER_TURN = Math.max(
    1,
    parseInt(process.env.PI_MAX_DISPATCHES_PER_TURN || "20", 10) || 20,
);
const MIN_DISPATCH_OUTPUT_CHARS = 40;

// Agents shipped alongside this extension serve as a fallback when the cwd has
// no .pi/agents of its own — the core resolves that install dir itself (relative
// to workflow-core), so no path is passed.
const loadAgents = (cwd: string) => loadAgentsCore(cwd);

export default function (pi: ExtensionAPI) {
    // This extension's OWN dispatch state (never a workflow's).
    const st = newOrchestratorState();
    let widgetCtx: any;
    let sessionDir = "";
    // All live sub-agent subprocesses. A Set (not a single ref) so cancellation
    // kills EVERY running agent — parallel dispatch can have several at once.
    const liveProcs = new Set<any>();
    // Set when the turn is aborted (or the session shuts down) — checked by
    // runAgentWithFallback so a killed agent is never re-spawned by the
    // transient/fallback retry paths. Reset at each turn start.
    let dispatchAborted = false;
    const killAllProcs = () => {
        dispatchAborted = true;
        for (const p of liveProcs) {
            try {
                p.kill("SIGTERM");
                // Escalate if SIGTERM is ignored — unref'd so the timer can't
                // keep the process alive; killing an exited proc is a no-op.
                setTimeout(() => {
                    try {
                        if (p.exitCode == null && p.signalCode == null)
                            p.kill("SIGKILL");
                    } catch {}
                }, 2000).unref?.();
            } catch {}
        }
        liveProcs.clear();
    };

    const setupSessions = (cwd: string, wipe: boolean) => {
        sessionDir = setupSessionsCore(cwd, wipe);
    };

    // Observability: append one JSONL record per dispatched agent to
    // <sessionDir>/dispatch-history.jsonl — what ran, its result, and how deep in
    // the dispatch tree (for debugging recursion/parallel runs). Best-effort.
    const logDispatch = (tool: string, details: any) => {
        if (!sessionDir || !details) return;
        const base = {
            ts: new Date().toISOString(),
            tool,
            depth: parseInt(process.env.PI_DISPATCH_DEPTH || "0", 10) || 0,
            ancestry: process.env.PI_DISPATCH_ANCESTRY || "",
        };
        const recs = details.parallel
            ? (details.results || []).map((r: any) => ({ ...base, ...r }))
            : [
                  {
                      ...base,
                      agent: details.agent,
                      status: details.status,
                      elapsed: details.elapsed,
                  },
              ];
        try {
            appendFileSync(
                join(sessionDir, "dispatch-history.jsonl"),
                recs.map((r: any) => JSON.stringify(r)).join("\n") + "\n",
            );
        } catch {}
    };

    function fallbackModel(): string {
        if (WORKER_MODEL) return WORKER_MODEL;
        const m = widgetCtx?.model;
        return (
            (m?.provider && m?.id ? `${m.provider}/${m.id}` : m?.id) ||
            "default"
        );
    }

    // Broadcast a per-frame snapshot of the dispatch phases to any dashboard
    // listening. Phases are shallow-copied so a subscriber renders a stable frame
    // and can never mutate this extension's live state.
    function emitUpdate() {
        const payload: DispatchUpdate = {
            phases: st.phases.map((p) => ({ ...p })),
            dispatchMode: st.dispatchMode,
            dispatchElapsedMs: st.dispatchElapsedMs,
            dispatchedThisTurn: st.dispatchedThisTurn,
        };
        pi.events.emit(DISPATCH_UPDATE, payload);
    }

    // Thin wrapper around the shared spawnAgentWithModel (per-agent sessions).
    const spawnAgentWithModel = makeSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        updateWidget: () => emitUpdate(),
        setCurrentProc: (p: any) => {
            // Track every spawned proc; it removes itself when it exits, so the
            // spawn's own setCurrentProc(null) calls are harmless no-ops here.
            if (p) {
                liveProcs.add(p);
                p.once?.("close", () => liveProcs.delete(p));
                p.once?.("exit", () => liveProcs.delete(p));
            }
        },
        // pi's authoritative project-trust answer (pi >= 0.79.1) for the --approve
        // decision, instead of re-reading ~/.pi/agent/trust.json by hand. Guarded so
        // older pi (no API) yields undefined and the disk fallback applies.
        isProjectTrusted: () => widgetCtx?.isProjectTrusted?.(),
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
                // Stops in-place transient/fallback retries once cancelled.
                isAborted: () => dispatchAborted,
            },
        );
    }

    // Callbacks the shared dispatch/select logic delegates to. ui.updateWidget
    // emits the snapshot instead of touching a widget directly, so dispatch stays
    // decoupled from any dashboard. runPhase is unused by dispatch/select.
    const host: OrchestratorHost = {
        execution: {
            runPhase: async () => ({ output: "", ok: false }),
            runAgent: (def, task, phase, cwd) =>
                runAgent(def, task, phase, cwd),
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
            // Unused here — ad-hoc dispatch never runs the pipeline (runPhase is a
            // no-op), so the curated-context bundle setting doesn't apply.
            sharedContext: false,
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
        async execute(_id, params, signal, onUpdate, ctx) {
            const { agent, task } = params as { agent: string; task: string };
            widgetCtx = ctx;
            // Cancellation: if the turn is aborted, kill every running sub-agent
            // subprocess so none keep running detached in the background.
            signal?.addEventListener?.("abort", killAllProcs);
            try {
                const result = await dispatchAgentCore(
                    st,
                    host,
                    agent,
                    task,
                    onUpdate,
                    ctx,
                );
                logDispatch("dispatch_agent", (result as any).details);
                return result;
            } finally {
                signal?.removeEventListener?.("abort", killAllProcs);
            }
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

    // ── dispatch_parallel — run several specialists concurrently ─────────────
    pi.registerTool({
        name: "dispatch_parallel",
        label: "Dispatch Parallel",
        description:
            "Dispatch several specialist agents to run CONCURRENTLY, each with its own task, and get all their results back together. Use this instead of multiple dispatch_agent calls when the sub-tasks are independent and can run at the same time. For dependent/sequential work, use dispatch_agent one at a time.",
        parameters: Type.Object({
            agents: Type.Array(
                Type.Object({
                    agent: Type.String({
                        description:
                            "Agent name (case-insensitive). Must be a loaded agent from .pi/agents/.",
                    }),
                    task: Type.String({
                        description: "Task for this agent to execute.",
                    }),
                }),
                {
                    description:
                        "The agents to run in parallel, each with its own task.",
                },
            ),
        }),
        async execute(_id, params, signal, onUpdate, ctx) {
            const items =
                (params as { agents: { agent: string; task: string }[] })
                    .agents || [];
            widgetCtx = ctx;
            signal?.addEventListener?.("abort", killAllProcs);
            try {
                const result = await dispatchParallelCore(
                    st,
                    host,
                    items,
                    onUpdate,
                    ctx,
                );
                logDispatch("dispatch_parallel", (result as any).details);
                return result;
            } finally {
                signal?.removeEventListener?.("abort", killAllProcs);
            }
        },
        renderCall(args, theme) {
            const items = (args?.agents || []) as { agent: string }[];
            const names = items.map((i) => i.agent).join(" ∥ ");
            return new Text(
                theme.fg("toolTitle", theme.bold("dispatch_parallel ")) +
                    theme.fg("accent", names || "?"),
                0,
                0,
            );
        },
        renderResult(result, options, theme) {
            return renderDispatchParallelResult(
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
        st.dispatchedThisTurn = false;
        dispatchAborted = false;
    });

    // Teardown: pi fires session_shutdown on /new, /resume, /fork, /reload, and
    // quit. Abort already kills live procs on turn cancellation, but a session
    // switch mid-dispatch would otherwise leave sub-agent subprocesses running
    // detached — so kill them all here too. Idempotent (killAllProcs clears the Set).
    pi.on("session_shutdown", async () => {
        killAllProcs();
    });
}
