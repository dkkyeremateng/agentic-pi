// ABOUTME: Orchestrates plan / implement / test / validate (loop) then document / ship as a self-healing pipeline.
// ABOUTME: The validator gates a correctness loop (FAIL -> back to implementer); only after PASS does the documenter
// ABOUTME: run, then the validator ships — commits code+tests+docs and opens the PR (or pauses if there is no remote).

/**
 * Workflow — scout / plan / critique / implement / test / validate / document / ship orchestrator
 *
 * Runs the agents defined in .pi/agents/*.md (the validator twice — to validate,
 * then to ship), optionally led by a read-only scout recon pass:
 *   scout? -> planner -> critic -> implementer -> tester -> validator(gate) -> documenter -> validator(ship)
 *
 * Unlike a static chain, the validator's verdict drives a feedback loop:
 *   - PASS    -> done (PR opened by validator if a remote exists)
 *   - PAUSED  -> stop and report (no GitHub remote; validator did local work only)
 *   - FAIL    -> feed the validator's findings back to the implementer and retry
 *   - UNKNOWN -> stop and surface for human review
 *
 * Handles bug fixes, new features, and new apps — the planner classifies the
 * request and the rest of the pipeline follows.
 *
 * Commands:
 *   /agent-pipeline <request>   — run the full lifecycle on a request
 *   /agent-pipeline-clear       — clear the progress widget
 *
 * Tool:
 *   run_agent_pipeline { request, max_loops? } — same, callable by the primary agent
 *
 * Self-contained: depends only on pi packages + Node builtins, and reads agent
 * definitions straight from .pi/agents/. Drop it in .pi/extensions/ and it loads.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    Text,
    Markdown,
    truncateToWidth,
    visibleWidth,
} from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { secs } from "../utils/workflow-utils";
import {
    calculateGridLayout,
    renderCardGrid,
    renderPipelineTitle,
    renderPhaseCardsWithArrows,
    renderEmptyAgentMessage,
    renderRichCard,
} from "../utils/workflow-widgets";
import {
    REQUIRED_AGENTS,
    DEFAULT_MAX_LOOPS,
    WORKFLOW_REPORT_TYPE,
    WORKFLOW_REPORT_MAX,
    WORKFLOW_LOG_TYPE,
    setupSessions as setupSessionsCore,
    publishReport as publishReportCore,
    publishLogs as publishLogsCore,
    type AgentDef,
    type PhaseState,
    loadDotEnv,
    displayName,
    statusMeta,
    statusBadge,
    agentPhaseStatus,
    appendLiveLog as appendLiveLogCore,
    renderWorkflowFooter,
    teamsBlock as teamsBlockCore,
    chooseTeam as chooseTeamCore,
    runPhaseCore,
    runAgentWithFallback,
    renderRunWorkflowCall,
    renderRunWorkflowResult,
    loadedExplicitly as loadedExplicitlyCore,
    isActiveWorkflow as isActiveWorkflowCore,
    loadAgents as loadAgentsCore,
    loadTeams as loadTeamsCore,
    loadSkills,
    sessionLabel,
    allTeamAgents,
    loadPromptTemplate,
    renderTemplate,
    makeSpawnWrapper,
} from "../utils/workflow-core";
import {
    newOrchestratorState,
    type OrchestratorHost,
    runWorkflowCore,
    runFullWorkflowCommand,
} from "../utils/orchestrator-core";
import { DISPATCH_UPDATE, type DispatchUpdate } from "../utils/dispatch-events";

// Run before any process.env reads below (WORKER_MODEL, …).
loadDotEnv(process.cwd());

// This file is the base "agent-pipeline"; it owns the chrome by default. See
// workflow-core for loadedExplicitly / selectedWorkflowExtension / isActiveWorkflow.
const SELF_NAME = "agent-pipeline";

const loadedExplicitly = () =>
    loadedExplicitlyCore(import.meta.url, "agent-pipeline.ts");
const isActiveWorkflow = () => isActiveWorkflowCore(SELF_NAME);

// The agents shipped alongside this extension (`<ext>/../agents`). Used as a
// fallback so the pipeline works when launched (e.g. via `-e`) from a project
// that has no .pi/agents of its own — the cwd still wins when it does.
const INSTALL_AGENTS_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "agents",
);
const loadAgents = (cwd: string) => loadAgentsCore(cwd, INSTALL_AGENTS_DIR);
const loadTeams = (cwd: string) => loadTeamsCore(cwd, INSTALL_AGENTS_DIR);

// ── Config ───────────────────────────────────────

// Empty string = inherit pi's configured default model. Override with PI_WORKFLOW_MODEL.
const WORKER_MODEL = process.env.PI_WORKFLOW_MODEL || "";
// Optional per-agent watchdog: kill an agent that runs longer than N minutes
// (PI_WORKFLOW_AGENT_TIMEOUT, in minutes). 0 / unset = no timeout.
const AGENT_TIMEOUT_MS =
    Math.max(0, parseFloat(process.env.PI_WORKFLOW_AGENT_TIMEOUT || "0") || 0) *
    60_000;
// Opt-in (off by default): run every phase agent against ONE shared session file
// so each resumes the full accumulated transcript (maximal context sharing),
// instead of the curated context bundle alone. Trades context-window growth — and
// a likely compaction partway through a long run — for complete cross-agent
// history. The curated bundle still applies on top.
const SHARED_SESSION = process.env.PI_AGENT_PIPELINE_SHARED_SESSION === "1";
// Cap dispatches per orchestrator turn so a weak model can't loop forever.
const MAX_DISPATCHES_PER_TURN = Math.max(
    1,
    parseInt(process.env.PI_MAX_DISPATCHES_PER_TURN || "20", 10) || 20,
);
// A dispatched agent that returns fewer than this many chars did no real work,
// so treat the dispatch as failed (steer the orchestrator to re-dispatch).
const MIN_DISPATCH_OUTPUT_CHARS = 40;

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Shared run/session state — mutated by the orchestration in orchestrator-core
    // and read by this extension's widget/footer/hooks. (agents, teams, phases,
    // running, the dispatch/turn timers, totals, …)
    const st = newOrchestratorState();
    // Extension-local: the single model every agent runs on (the pipeline ignores
    // per-agent `model:` frontmatter), the live ctx, the session dir, and the
    // running subprocess handle. None of these belong in the shared state.
    let sessionModel = "";
    let widgetCtx: any;
    let sessionDir = "";
    let currentProc: any = null;

    // Callbacks + config the shared orchestration delegates back to.
    const host: OrchestratorHost = {
        execution: {
            runPhase: (phase, task, cwd) => runPhase(phase, task, cwd),
            runAgent: (def, task, phase, cwd) =>
                runAgent(def, task, phase, cwd),
        },
        ui: {
            updateWidget: () => updateWidget(),
            notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
            publishLogs: () => publishLogs(),
        },
        setup: {
            setupSessions: (cwd, wipe) => setupSessions(cwd, wipe),
            loadAgents: (cwd) => loadAgents(cwd),
            prepareRun: (ctx) => {
                sessionModel = sessionModelOf(ctx);
            },
        },
        config: {
            sharedContext: true, // the pipeline always applies the curated bundle
            maxDispatchesPerTurn: MAX_DISPATCHES_PER_TURN,
            minDispatchOutputChars: MIN_DISPATCH_OUTPUT_CHARS,
        },
    };

    // The primary agent keeps its FULL toolset (read/write/edit/bash/grep/find/ls
    // + skills) alongside the dispatch tools (select_agents / dispatch_agent /
    // dispatch_parallel / run_agent_pipeline). It does work itself by default and
    // delegates only when warranted (see prompts/orchestrator.md), so we do NOT
    // lock the toolset down to dispatch-only.

    const setupSessions = (cwd: string, wipe: boolean) => {
        sessionDir = setupSessionsCore(cwd, wipe);
    };

    // ── Team helpers ─────────────────────────────

    // Build a "provider/id" model string from a pi context, guarding for a
    // model that exposes only an id (or none at all).
    function sessionModelOf(ctx: any): string {
        const m = ctx?.model;
        if (!m) return "";
        return m.provider && m.id ? `${m.provider}/${m.id}` : m.id || "";
    }
    // agent-pipeline uses ONE model for every agent (PI_WORKFLOW_MODEL or the
    // session model) — there are no per-agent models here, so the agent key is
    // irrelevant. Display only.
    function modelFor(_agentKey: string): string {
        return WORKER_MODEL || sessionModel || "default";
    }
    // Members of the active team that actually resolve to a loaded agent .md.
    function activeMembers(): string[] {
        const raw = st.teams[st.activeTeamName] || [];
        return raw.filter((m) => st.agents.has(m.toLowerCase()));
    }
    // Pick a team, falling back to the first defined team if the name is unknown.
    function activateTeam(name: string) {
        const names = Object.keys(st.teams);
        st.activeTeamName = st.teams[name] ? name : (names[0] ?? "");
    }
    const teamsBlock = () =>
        teamsBlockCore(st.teams, st.agents, st.activeTeamName);
    const chooseTeam = (ctx: any) => chooseTeamCore(ctx, st.teams);

    // ── Widget (horizontal cards) ────────────────

    // ── Idle grid dashboard (team roster with per-agent model) ──

    // One agent card: name · status · model · description. Used in the idle
    // dashboard so the whole team and the model each agent runs is visible at
    // a glance before a workflow starts.
    // Rich agent card — delegates to the shared renderer so agent-pipeline and
    // agent-team stay identical. agent-pipeline shows the ONE session model on
    // every card (modelFor ignores the key here).
    function renderAgentCard(
        agentKey: string,
        colWidth: number,
        theme: any,
        showContext = true,
    ): string[] {
        return renderRichCard({
            agentKey,
            def: st.agents.get(agentKey.toLowerCase()),
            phases: st.phases,
            colWidth,
            theme,
            model: modelFor(agentKey),
            showContext,
        });
    }

    // The idle dashboard: a grid of ALL agents across all teams in teams.yaml.
    // Every card shows the model it runs (the primary/session model — agent-pipeline
    // runs all sub-agents on it), its context-usage bar, and its description.
    function renderAgentGrid(width: number, theme: any): string[] {
        // Show every unique agent from all teams, filtered to those with loaded .md defs
        const allMembers = allTeamAgents(st.teams).filter((m) =>
            st.agents.has(m.toLowerCase()),
        );
        const teamNames = Object.keys(st.teams);
        const activeMembers = (st.teams[st.activeTeamName] || []).filter(
            (m: string) => st.agents.has(m.toLowerCase()),
        );

        const header =
            " " +
            theme.fg("accent", theme.bold("agent-pipeline")) +
            theme.fg("dim", "  ·  team ") +
            theme.fg("accent", st.activeTeamName || "—") +
            theme.fg(
                "dim",
                ` (${activeMembers.length}/${allMembers.length} agent${allMembers.length === 1 ? "" : "s"})`,
            ) +
            theme.fg("dim", "  ·  model ") +
            theme.fg("muted", modelFor(""));
        const hint = theme.fg(
            "dim",
            teamNames.length > 1
                ? " /agent-pipeline [request] — pick a team, then run"
                : " /agent-pipeline <request> to run",
        );

        const lines: string[] = [header, hint, ""];

        if (allMembers.length === 0) {
            lines.push(...renderEmptyAgentMessage(theme));
            return lines;
        }

        const { cols, gap, colWidth } = calculateGridLayout(
            allMembers.length,
            width,
        );

        for (let i = 0; i < allMembers.length; i += cols) {
            const rowMembers = allMembers.slice(i, i + cols);
            const cards = rowMembers.map((m) =>
                // Context bar only while dispatching (agents have real usage); a
                // truly idle roster shows no meaningless 0%/window bar.
                renderAgentCard(m, colWidth, theme, st.dispatchMode),
            );
            lines.push(...renderCardGrid(cards, cols, gap, colWidth));
        }
        return lines;
    }

    function updateWidget() {
        if (!widgetCtx || !widgetCtx.hasUI) return; // no chrome without a UI
        widgetCtx.ui.setWidget("agent-pipeline", (_tui: any, theme: any) => {
            const text = new Text("", 0, 1);
            return {
                render(width: number): string[] {
                    const {
                        phases,
                        running,
                        lastStatus,
                        iteration,
                        maxLoopsRef,
                        runElapsedMs,
                    } = st;
                    if (phases.length === 0) {
                        // Idle: show the active team as a grid of agent cards,
                        // each annotated with the model it runs.
                        text.setText(renderAgentGrid(width, theme).join("\n"));
                        return text.render(width);
                    }

                    const arrowWidth = 5; // " ──▸ "
                    const cols = phases.length;
                    const colWidth = Math.max(
                        14,
                        Math.floor((width - arrowWidth * (cols - 1)) / cols),
                    );
                    const arrowRow = 2; // status row of the card

                    // Same rich card as the idle dashboard and agent-team: each
                    // shows its model, a live context-usage bar with token count,
                    // and its description (single source of truth = renderRichCard).
                    const cards = phases.map((p) =>
                        renderAgentCard(p.agent, colWidth, theme),
                    );
                    const lines: string[] = [];

                    // Use shared pipeline title renderer with totalTime enabled
                    lines.push(
                        ...renderPipelineTitle(
                            phases,
                            running,
                            lastStatus,
                            iteration,
                            maxLoopsRef,
                            runElapsedMs,
                            theme,
                            { showTotalTime: true },
                        ),
                    );

                    // Use shared arrow layout renderer
                    lines.push(
                        ...renderPhaseCardsWithArrows(cards, theme, phases),
                    );

                    // Live log of the running agent (stable-height panel — shared
                    // with agent-team via workflow-core).
                    appendLiveLogCore(
                        lines,
                        width,
                        theme,
                        phases,
                        running,
                        visibleWidth,
                    );

                    text.setText(lines.join("\n"));
                    return text.render(width);
                },
                invalidate() {
                    text.invalidate();
                },
            };
        });
    }

    // ── Run a single agent as a subprocess ───────

    // Thin wrapper around the shared spawnAgentWithModel from workflow-core.
    // Uses makeSpawnWrapper to accumulate token/tool/dropped-line totals into
    // the module counters after each spawn.
    const spawnAgentWithModel = makeSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
        sharedSession: true,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        updateWidget: () => updateWidget(),
        setCurrentProc: (proc: any) => {
            currentProc = proc;
        },
    });

    function runAgent(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
    ): Promise<{ output: string; exitCode: number }> {
        // agent-pipeline runs EVERY agent on ONE model: the session model pi was
        // launched with (or PI_WORKFLOW_MODEL when set). Per-agent frontmatter
        // `model:` and PI_AGENT_*_MODEL are intentionally IGNORED here — per-agent
        // models are the agent-team variant's job.
        const primaryModel = WORKER_MODEL || sessionModel;
        // Fallback: the model the current pi session is running on. If the chosen
        // model fails to load, we retry with the session model since it's known to
        // work — pi itself is using it.
        const fallbackModel =
            sessionModel && sessionModel !== primaryModel ? sessionModel : "";
        // Delegate to shared core (eliminates ~50 lines of near-identical
        // fallback logic with notification API drift).
        return runAgentWithFallback(
            agentDef,
            task,
            phase,
            cwd,
            primaryModel,
            fallbackModel,
            spawnAgentWithModel,
            {
                updateWidget,
                notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
            },
        );
    }

    async function runPhase(
        phase: PhaseState,
        task: string,
        cwd: string,
    ): Promise<{ output: string; ok: boolean }> {
        // Delegate to shared core (eliminates behavioral drift across 3 copies:
        // the runtime was resetting phase.log/phase.note; extensions were not).
        return runPhaseCore(st.agents, phase, task, cwd, runAgent, {
            updateWidget,
            notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
            phaseLogs: st.phaseLogs,
        });
    }

    // ── Custom message renderer for workflow reports ──
    // Only the active extension registers renderers — both files use the same
    // customType strings, so registering in both would double up.

    if (isActiveWorkflow())
        pi.registerMessageRenderer(
            WORKFLOW_REPORT_TYPE,
            (message, _options, _theme) => {
                const report = (message.content || "") as string;
                const mdTheme = getMarkdownTheme();
                const trimmed =
                    report.length > WORKFLOW_REPORT_MAX
                        ? report.slice(0, WORKFLOW_REPORT_MAX) +
                          "\n\n... [truncated — full report saved to workflow-report.md]"
                        : report;
                return new Markdown(trimmed, 1, 0, mdTheme);
            },
        );

    const publishReport = (report: string) =>
        publishReportCore(pi, report, st.lastStatus);

    // ── Consolidated activity log → one scrollable conversation message ──

    if (isActiveWorkflow())
        pi.registerMessageRenderer(
            WORKFLOW_LOG_TYPE,
            (message, { expanded }, theme) => {
                const d = (message.details || {}) as { phases?: number };
                if (!expanded) {
                    const count = d.phases
                        ? ` (${d.phases} phase${d.phases === 1 ? "" : "s"})`
                        : "";
                    return new Text(
                        theme.fg("accent", "▤ ") +
                            theme.fg("muted", "Activity logs") +
                            theme.fg("dim", `${count} — expand to read`),
                        0,
                        0,
                    );
                }
                return new Markdown(
                    (message.content || "") as string,
                    1,
                    0,
                    getMarkdownTheme(),
                );
            },
        );

    const publishLogs = () => publishLogsCore(pi, st.phaseLogs);

    // ── Command ──────────────────────────────────

    // Register commands + tool only for the active workflow extension, so when
    // both auto-load you don't see /agent-pipeline and /agent-team at once.
    const active = isActiveWorkflow();

    // CLI flags (active extension only, so they register once): `--max-loops N`
    // and `--confine-cwd`, surfacing the most common env knobs at launch.
    if (active) {
        pi.registerFlag?.("max-loops", {
            description:
                "Default implement/validate retries for workflow runs (overrides DEFAULT_MAX_LOOPS)",
            type: "string",
        });
        pi.registerFlag?.("confine-cwd", {
            description:
                "Confine sub-agents' file tools to the working directory (sets PI_CONFINE_CWD)",
            type: "boolean",
        });
    }

    // A startup `--confine-cwd` flag is equivalent to PI_CONFINE_CWD=1; set the env
    // early so subagentExtArgs picks it up when spawning sub-agents.
    if (pi.getFlag?.("confine-cwd")) process.env.PI_CONFINE_CWD = "1";

    // `--max-loops N` sets the default retry limit (inline `loops=N` still wins).
    const flagMaxLoops = parseInt(String(pi.getFlag?.("max-loops") ?? ""), 10);
    const defaultMaxLoops = flagMaxLoops > 0 ? flagMaxLoops : DEFAULT_MAX_LOOPS;

    if (active)
        pi.registerCommand("agent-pipeline", {
            description:
                "Run a workflow: '/agent-pipeline <request>' for full lifecycle, '/agent-pipeline spec <request>' for implementation spec only",
            handler: async (args, ctx) => {
                widgetCtx = ctx;
                if (st.running) {
                    ctx.ui.notify("A workflow is already running.", "warning");
                    return;
                }

                st.agents = loadAgents(ctx.cwd);
                st.teams = loadTeams(ctx.cwd);
                if (Object.keys(st.teams).length === 0)
                    st.teams = { all: Array.from(st.agents.keys()) };
                // Per-team membership is checked inside runWorkflowCore (every
                // roster member must resolve to a loaded agent). Here we only need
                // at least one agent to exist at all.
                if (st.agents.size === 0) {
                    ctx.ui.notify(
                        "No agents found in .pi/agents/.",
                        "error",
                    );
                    return;
                }

                let rawArgs = (args || "").trim();

                // Optional `loops=N` token (anywhere) overrides the retry limit.
                let maxLoops = defaultMaxLoops;
                const loopsMatch = rawArgs.match(
                    /(?:^|\s)loops=(\d+)(?=\s|$)/i,
                );
                if (loopsMatch) {
                    const n = parseInt(loopsMatch[1], 10);
                    if (n > 0) maxLoops = n;
                    rawArgs = (
                        rawArgs.slice(0, loopsMatch.index!) +
                        rawArgs.slice(loopsMatch.index! + loopsMatch[0].length)
                    ).trim();
                }
                // The first token may name a team (e.g. `/agent-pipeline building
                // <request>`); otherwise show the Select Team picker. The chosen
                // team's roster IS the pipeline — there is no spec/full mode.
                const firstTok = rawArgs.split(/\s+/)[0] || "";
                const namedTeam = st.teams[firstTok] ? firstTok : "";

                // A team is selected per job: naming a team selects it, otherwise
                // the picker does. The team is deactivated once the job finishes
                // (below), so each run starts from a clean "no team" state.
                let request: string;
                if (namedTeam) {
                    activateTeam(namedTeam);
                    request = rawArgs.slice(firstTok.length).trim();
                } else {
                    const picked = await chooseTeam(ctx);
                    if (picked === null) return; // user cancelled the picker
                    activateTeam(picked);
                    request = rawArgs;
                }
                updateWidget();
                // Move the active marker to the selected team and surface it.
                ctx.ui.notify(
                    `Active team → ${st.activeTeamName}\nTeams:\n${teamsBlock()}`,
                    "info",
                );

                // Prompt for the request if it wasn't typed inline, so we never
                // dispatch a workflow on an empty string.
                let finalRequest = request;
                if (!finalRequest) {
                    const typed = await ctx.ui.input(
                        "What should the workflow build, fix, or produce?",
                        "",
                    );
                    if (!typed) return;
                    finalRequest = typed.trim();
                    if (!finalRequest) return;
                }

                pi.setSessionName?.(
                    sessionLabel("agent-pipeline", st.activeTeamName, finalRequest),
                );
                await runFullWorkflowCommand(
                    st,
                    host,
                    finalRequest,
                    ctx,
                    publishReport,
                    maxLoops,
                );
                // Deactivate the team after the job so the next run re-selects and
                // the orchestrator is unscoped again when idle.
                st.activeTeamName = "";
                updateWidget();
            },
        });

    if (active)
        pi.registerCommand("agent-pipeline-clear", {
            description: "Clear the workflow progress widget",
            handler: async (_args, ctx) => {
                widgetCtx = ctx;
                ctx.ui.setWidget("agent-pipeline", undefined);
                ctx.ui.notify("Workflow widget cleared.", "info");
            },
        });

    // ── Tool — let the primary agent invoke the workflow ──

    if (active)
        pi.registerTool({
            name: "run_agent_pipeline",
            label: "Run Workflow",
            description:
                "Run the full plan -> implement -> test -> validate lifecycle on a request (bug fix, new feature, or new app). The validator gates the result: it loops back to the implementer on FAIL, pauses if there is no GitHub remote, and opens a PR on PASS. Use this for any non-trivial change; do simple lookups yourself.",
            parameters: Type.Object({
                request: Type.String({
                    description: "The bug, feature, or app to deliver",
                }),
                max_loops: Type.Optional(
                    Type.Number({
                        description: `Max implement/validate retries (default ${DEFAULT_MAX_LOOPS})`,
                    }),
                ),
            }),
            async execute(_id, params, signal, onUpdate, ctx) {
                const { request, max_loops } = params as {
                    request: string;
                    max_loops?: number;
                };
                if (st.running) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "A workflow is already running.",
                            },
                        ],
                        details: undefined,
                    };
                }
                st.agents = loadAgents(ctx.cwd);
                widgetCtx = ctx;
                st.pipelineRanThisTurn = true; // fold the primary's turn time into the total
                if (onUpdate)
                    onUpdate({
                        content: [
                            {
                                type: "text",
                                text: `Running workflow: ${request}`,
                            },
                        ],
                        details: undefined,
                    });
                // If the turn is aborted, kill the running agent subprocess so the
                // workflow doesn't keep running detached in the background.
                const onAbort = () =>
                    (globalThis as any).__piKillWorkflowProc?.();
                signal?.addEventListener?.("abort", onAbort);
                // Pass the abort signal to the orchestrator so it stops between phases
                host.signal = signal ?? undefined;
                pi.setSessionName?.(
                    sessionLabel("agent-pipeline", st.activeTeamName, request),
                );
                const result = await runWorkflowCore(
                    st,
                    host,
                    request,
                    max_loops && max_loops > 0 ? max_loops : defaultMaxLoops,
                    ctx,
                ).finally(() => {
                    signal?.removeEventListener?.("abort", onAbort);
                    host.signal = undefined;
                });
                // Deactivate the team after the job (no-op if none was active).
                st.activeTeamName = "";
                updateWidget();
                const truncated =
                    result.report.length > 8000
                        ? result.report.slice(0, 8000) +
                          "\n\n... [truncated — see workflow-report.md]"
                        : result.report;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Status: ${result.status} · completed in ${secs(st.runElapsedMs)}\n\n${truncated}`,
                        },
                    ],
                    details: { status: result.status, report: truncated },
                };
            },

            renderCall(args, theme) {
                return renderRunWorkflowCall(
                    "run_agent_pipeline",
                    args,
                    theme,
                    activeMembers,
                    Text,
                );
            },

            renderResult(result, options, theme) {
                return renderRunWorkflowResult(
                    "agent-pipeline",
                    result,
                    options,
                    theme,
                    Text,
                    Markdown,
                    getMarkdownTheme(),
                    WORKFLOW_REPORT_MAX,
                );
            },
        });

    // ── dispatch_agent / select_agents — now owned by the standalone `dispatch`
    // extension (extensions/dispatch.ts), so ANY agent can dispatch, not just this
    // workflow's orchestrator. We no longer register those tools here. Instead,
    // when this is the active workflow, we mirror the dispatch phase snapshot the
    // dispatch extension broadcasts on pi.events into our dashboard and re-render.
    // (Dispatch and the automated pipeline are mutually exclusive in time —
    // dispatchAgentCore refuses while s.running — so replacing st.phases is safe.)

    if (active)
        pi.events.on(DISPATCH_UPDATE, (data) => {
            const u = data as DispatchUpdate;
            st.phases = u.phases;
            st.dispatchMode = u.dispatchMode;
            st.dispatchElapsedMs = u.dispatchElapsedMs;
            updateWidget();
        });

    // ── Primary-turn timing ──
    // The orchestrator's turn wraps both its own reasoning and the sub-agent work
    // it triggers, so timing it gives the total INCLUDING the primary agent's time.
    // At turn end we fold that into the dispatch / pipeline totals.
    if (active)
        pi.on("agent_start", async () => {
            st.primaryTurnStartedAt = Date.now();
            st.pipelineRanThisTurn = false;
            st.dispatchedThisTurn = false;
            st.dispatchesThisTurn = 0;
        });
    if (active)
        pi.on("agent_end", async () => {
            if (st.primaryTurnStartedAt <= 0) return;
            const turnMs = Date.now() - st.primaryTurnStartedAt;
            // Only fold the turn time into a total when work actually ran this turn,
            // so a plain "done" reply doesn't overwrite the last total.
            if (st.dispatchedThisTurn) st.dispatchElapsedMs = turnMs;
            // Only overwrite runElapsedMs if the pipeline is still running (aborted
            // mid-run). When the pipeline completed, runWorkflowCore already set the
            // correct value from runStartedAt; overwriting it with the full turn time
            // (which includes orchestrator reasoning) would inflate the dashboard.
            if (st.pipelineRanThisTurn && st.running) st.runElapsedMs = turnMs;
            if (st.dispatchedThisTurn || st.pipelineRanThisTurn) updateWidget();
        });

    // ── Orchestrator system prompt + tool lockdown ──
    //
    // The primary agent does the work itself by default and dispatches specialist
    // agents (or runs the full pipeline via run_agent_pipeline) when warranted.
    // This hook injects the orchestrator guidance + agent/skill catalog each turn.

    if (active)
        pi.on("before_agent_start", async (event, _ctx) => {
            // A new user request = a new workflow. Mark it so the first
            // dispatch_agent of this request rebuilds the cards from
            // scratch instead of carrying over the previous workflow's state.
            st.freshDispatchSession = true;

            // The agents the orchestrator may dispatch. Only while a team-scoped
            // job is actually running do we restrict it to that team's roster;
            // otherwise (idle, or no team active) the orchestrator may freely pick
            // the right agent for the work from every loaded agent.
            const dispatchableDefs =
                st.activeTeamName && st.running
                    ? (st.teams[st.activeTeamName] || [])
                          .filter((m) => st.agents.has(m.toLowerCase()))
                          .map((m) => st.agents.get(m.toLowerCase())!)
                    : Array.from(st.agents.values());

            const agentCatalog = dispatchableDefs
                .map(
                    (def) =>
                        `### ${displayName(def.name)}\n**Dispatch as:** \`${def.name}\`\n${def.description}\n**Tools:** ${def.tools}`,
                )
                .join("\n\n");

            const teamMembers = dispatchableDefs
                .map((d) => displayName(d.name))
                .join(", ");

            // Skills the orchestrator can use directly (files-only: any SKILL.md).
            const skills = loadSkills(_ctx.cwd);
            const skillCatalog = skills.length
                ? skills.map((s) => `- **${s.name}** — ${s.description}`).join("\n")
                : "(none)";

            // APPEND the orchestration layer to Pi's base system prompt instead of
            // replacing it. The base prompt carries the tool-calling scaffolding the
            // model needs to actually emit tool calls; replacing it wholesale made
            // weaker models narrate a plan as text instead of dispatching. A short,
            // imperative directive goes first so the very next action is a tool call.
            const template = loadPromptTemplate("orchestrator", "", _ctx.cwd);
            const orchestratorAddendum = renderTemplate(template, {
                run_tool_name: "run_agent_pipeline",
                team_name: st.activeTeamName || "none",
                team_members: teamMembers,
                agent_catalog: agentCatalog,
                skill_catalog: skillCatalog,
            });

            // Append our orchestration layer onto Pi's assembled base prompt so the
            // model keeps its tool-calling instructions and gains the role override.
            const base = event.systemPrompt || "";
            return {
                systemPrompt: base
                    ? `${base}\n\n${"=".repeat(60)}\n\n${orchestratorAddendum}`
                    : orchestratorAddendum,
            };
        });

    // ── Cancellation hook (integrates with escape-cancel if present) ──

    pi.on("session_start", async (_event, ctx) => {
        widgetCtx = ctx;
        loadDotEnv(ctx.cwd); // pick up cwd/.env in case pi launched from elsewhere
        st.agents = loadAgents(ctx.cwd);
        st.teams = loadTeams(ctx.cwd);
        // Fall back to an "all" team if teams.yaml is absent/empty, so the
        // dashboard still has something to show.
        if (Object.keys(st.teams).length === 0) {
            st.teams = { all: Array.from(st.agents.keys()) };
        }
        // No team is active on startup — the user must pick one (the picker, or
        // naming a team as the first token of /agent-pipeline). The idle dashboard
        // still shows every agent across all teams.
        st.activeTeamName = "";
        st.phases = [];
        st.dispatchMode = false;

        // Only the active workflow extension owns the chrome. When both are
        // auto-discovered, the inactive one clears its widget and bows out so it
        // never stacks a second dashboard, footer, or cancellation hook.
        if (!isActiveWorkflow()) {
            ctx.ui.setWidget("agent-pipeline", undefined);
            return;
        }

        // Show the idle team dashboard (grid of agents + their models).
        updateWidget();

        (globalThis as any).__piKillWorkflowProc = (): boolean => {
            // Kill the running agent subprocess so a cancelled workflow doesn't
            // keep running detached in the background.
            if (currentProc) {
                try {
                    currentProc.kill("SIGTERM");
                } catch {}
                currentProc = null;
            }
            st.running = false;
            return true;
        };
        (globalThis as any).__piHasRunningWorkflow = (): boolean => st.running;
        const present = REQUIRED_AGENTS.filter((a) => st.agents.has(a));
        const missing = REQUIRED_AGENTS.filter((a) => !st.agents.has(a));
        ctx.ui.setStatus(
            "agent-pipeline",
            `Workflow: ${present.length}/${REQUIRED_AGENTS.length} agents`,
        );

        if (loadedExplicitly()) {
            const flow = REQUIRED_AGENTS.map(
                (a) => a.charAt(0).toUpperCase() + a.slice(1),
            ).join(" → ");
            if (missing.length) {
                ctx.ui.notify(
                    `Workflow\n` +
                        `${flow}\n\n` +
                        `Missing agents in .pi/agents/: ${missing.join(", ")} — add them to enable /agent-pipeline.`,
                    "warning",
                );
            } else {
                ctx.ui.notify(
                    `Workflow\n` +
                        `Teams:\n${teamsBlock()}\n\n` +
                        `/agent-pipeline [request]   Pick a team (Select Team), then run the lifecycle\n` +
                        `/agent-pipeline-clear       Clear the progress widget\n` +
                        `run_agent_pipeline          Tool — the agent can launch the full pipeline for non-trivial tasks\n` +
                        `dispatch_agent              Tools — dispatch task(s) to any loaded agent(s) outside the pipeline`,
                    "info",
                );
            }
        }

        // Footer: model · workflow status · context-usage bar (TUI/RPC only —
        // skip the chrome entirely in print/json modes).
        if (ctx.hasUI)
            ctx.ui.setFooter?.((_tui: any, theme: any, _data: any) => ({
            dispose: () => {},
            invalidate() {},
            render(width: number): string[] {
                // Full `provider/model` of the session (primary) agent.
                const pm = ctx.model;
                const model =
                    pm?.provider && pm?.id
                        ? `${pm.provider}/${pm.id}`
                        : pm?.id || WORKER_MODEL || "default";
                return renderWorkflowFooter({
                    width,
                    theme,
                    selfName: "agent-pipeline",
                    model,
                    running: st.running,
                    lastStatus: st.lastStatus,
                    iteration: st.iteration,
                    maxLoopsRef: st.maxLoopsRef,
                    dispatchMode: st.dispatchMode,
                    phases: st.phases,
                    dispatchElapsedMs: st.dispatchElapsedMs,
                    runElapsedMs: st.runElapsedMs,
                    contextUsage: () => ctx.getContextUsage?.(),
                    visibleWidth,
                    truncateToWidth,
                });
            },
        }));
    });
}
