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
import { coerceJsonArrayArg } from "../utils/workflow/tool-args";
import { Text, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "fs";
import { join } from "path";
import { readFileSync } from "fs";
import {
    setupSessions as setupSessionsCore,
    runAgentWithFallback,
    makeExtensionSpawnWrapper,
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
    agentStallMsFromEnv,
    isSmallPlan,
    inlineHandoffDue,
    inlineHandoffNotice,
} from "../utils/workflow/workflow-core";
import {
    readInlineTurns,
    writeInlineTurns,
} from "../utils/workflow/inline-budget";
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
    // pi's model registry (models.json) — used to derive a sub-agent's context
    // window when its provider doesn't report one. Captured at session_start.
    let modelRegistry: any;
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
                      // Which session this dispatch ran in. The fresh-context audit
                      // counts DISTINCT ids, not records: two dispatches sharing one
                      // id means the second resumed the first's context.
                      dispatchId: details.dispatchId,
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
    // Shared with agent-workflow.ts so the two cannot drift apart again.
    const spawnAgentWithModel = makeExtensionSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        // Dispatched agents were spawned with NO stall watchdog, which is where
        // it was needed most: the 2h13m foreground-server hang that armed this
        // by default was a `phase-implementer`, and those only run via dispatch.
        agentStallMs: agentStallMsFromEnv(),
        updateWidget: () => emitUpdate(),
        liveProcs,
        ctx: () => widgetCtx,
        modelRegistry: () => modelRegistry,
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
        // Run one at a time with the rest of the batch: pi executes tool calls in
        // PARALLEL by default, which would let a dispatch overlap a pipeline run
        // (run_agent_workflow) in the same batch — they share the staged-learnings
        // file and the dashboard, so they must never interleave.
        executionMode: "sequential",
        async execute(_id, params, signal, onUpdate, ctx) {
            const { agent, task } = params as { agent: string; task: string };
            widgetCtx = ctx;
            // Listeners added to an ALREADY-aborted signal never fire, so bail out
            // before spawning anything.
            if (signal?.aborted) {
                killAllProcs();
                return {
                    content: [{ type: "text" as const, text: "dispatch cancelled." }],
                    details: undefined,
                };
            }
            // Cancellation: if the turn is aborted, kill every running sub-agent
            // subprocess so none keep running detached in the background. A fresh
            // closure per call — EventTarget dedupes identical listeners, so a
            // shared reference would let the first tool to finish remove the only
            // registration and orphan a concurrent dispatch's children.
            const onAbort = () => killAllProcs();
            signal?.addEventListener?.("abort", onAbort);
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
                signal?.removeEventListener?.("abort", onAbort);
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
        // Some models send `agents` as a JSON-encoded string rather than an
        // array. pi validates against the schema BEFORE any extension hook can
        // see the call, so this is the only place it can be fixed -- and the
        // only reason it needs fixing here is that pi's equivalent fix lives
        // inside its own edit tool. 2 of 6 dispatch_parallel calls in a month
        // died on it, each one a whole parallel wave that never started.
        prepareArguments: (args: unknown) => coerceJsonArrayArg(args, "agents") as any,
        // See dispatch_agent — never overlap a pipeline run in the same batch.
        executionMode: "sequential",
        async execute(_id, params, signal, onUpdate, ctx) {
            const items =
                (params as { agents: { agent: string; task: string }[] })
                    .agents || [];
            widgetCtx = ctx;
            if (signal?.aborted) {
                killAllProcs();
                return {
                    content: [{ type: "text" as const, text: "dispatch cancelled." }],
                    details: undefined,
                };
            }
            // Per-call closure (see dispatch_agent).
            const onAbort = () => killAllProcs();
            signal?.addEventListener?.("abort", onAbort);
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
                signal?.removeEventListener?.("abort", onAbort);
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
        // Same JSON-string-for-array coercion as dispatch_parallel; the shape
        // error does not care what the array holds.
        prepareArguments: (args: unknown) => coerceJsonArrayArg(args, "agents") as any,
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
    // One handoff per session: the notice is a switch of strategy, and
    // repeating it would spend the very context it exists to save.
    let handoffSent = false;
    // Turns earlier implementer instances of this run already spent. Read once
    // per session; null until then.
    let inlineBaseline: number | null = null;
    const cwdOf = () => widgetCtx?.cwd || process.cwd();
    const isImplementer = () =>
        (process.env.PI_AGENT_NAME || "").trim().toLowerCase() === "implementer";

    pi.on("session_start", async (_event, ctx) => {
        widgetCtx = ctx;
        modelRegistry = (ctx as any).modelRegistry;
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

    // ── the inline floor's circuit-breaker ──
    //
    // The floor tells the implementer to do a small plan itself. That is right
    // until it is not: run-mtfy2a2v-lq87f spent 270 turns and $25.13 in ONE
    // implementer context, the per-turn prefix growing 3 tokens -> 127k as it
    // went. Nothing tripped, because context never passed 13% of the window.
    //
    // So the floor gets a bound. `turn_start` carries the index for free;
    // `inlineFloorRefusal` stops refusing once the budget is spent, and the
    // notice below tells the agent to actually use that. Both halves are needed:
    // lifting the ban alone changes nothing, because an agent told not to
    // dispatch does not spontaneously retry.
    pi.on("turn_start", async (event: any) => {
        const sessionTurns = Number(event?.turnIndex) || 0;
        // Cumulative across the run, not this process. Three implementer
        // instances of 55/71/99 turns each counted from zero on
        // run-mtg4oipc-4e984, so 225 inline turns passed and only the last one
        // ever crossed 60. The baseline is read once per session; only the
        // implementer contributes, since a worker's context is bounded by its own
        // session and is not what the budget is protecting against.
        if (isImplementer()) {
            if (inlineBaseline === null) inlineBaseline = readInlineTurns(cwdOf());
            st.inlineTurns = inlineBaseline + sessionTurns;
            st.inlineSessionTurns = sessionTurns;
            writeInlineTurns(cwdOf(), st.inlineTurns);
        } else {
            st.inlineTurns = sessionTurns;
            st.inlineSessionTurns = sessionTurns;
        }
    });

    // A tool result is the only channel that reaches an agent mid-run, so the
    // handoff rides on one. Once, on crossing the line: repeating it every call
    // would spend the context this exists to save.
    pi.on("tool_result", (event: any) => {
        if (
            handoffSent ||
            !inlineHandoffDue(st.inlineTurns, st.inlineSessionTurns)
        )
            return undefined;
        // Only an implementer working a plan the floor actually covers. Every
        // other agent, and every larger plan, is none of this hook's business.
        if (!isImplementer()) return undefined;
        let plan: string;
        try {
            plan = readFileSync(join(cwdOf(), ".agent", "plan.md"), "utf8");
        } catch {
            return undefined;
        }
        if (!isSmallPlan(plan)) return undefined;
        handoffSent = true;
        // RETURN the new content; do not mutate `event.content` in place. pi's
        // runner skips a handler that returns nothing (`if (!handlerResult)
        // continue`) and gates the change on a `modified` flag, so an in-place
        // push reaches the model only by way of a shallow-copy alias that is not
        // part of the contract. `tool_call` is the hook that documents in-place
        // mutation; `tool_result` is not, and this is the pattern edit-repair.ts
        // already uses.
        return {
            content: [
                ...(event.content ?? []),
                {
                    type: "text" as const,
                    text: inlineHandoffNotice(st.inlineTurns),
                },
            ],
        };
    });

    // Teardown: pi fires session_shutdown on /new, /resume, /fork, /reload, and
    // quit. Abort already kills live procs on turn cancellation, but a session
    // switch mid-dispatch would otherwise leave sub-agent subprocesses running
    // detached — so kill them all here too. Idempotent (killAllProcs clears the Set).
    pi.on("session_shutdown", async () => {
        killAllProcs();
    });
}
