// ABOUTME: Team-model variant of the workflow orchestrator — identical pipeline to agent-pipeline.ts but allows
// ABOUTME: configuring the model per agent via env vars (PI_AGENT_PLANNER_MODEL, PI_AGENT_IMPLEMENTER_MODEL, …)
// ABOUTME: or a global fallback (PI_WORKFLOW_MODEL). Every other aspect of the pipeline is unchanged.
/**
 * Workflow Team — scout / plan / critique / implement / test / validate / document / ship orchestrator
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
 * Each agent's model can be set individually via env vars or a config block:
 *   PI_AGENT_PLANNER_MODEL, PI_AGENT_IMPLEMENTER_MODEL, PI_AGENT_TESTER_MODEL,
 *   PI_AGENT_VALIDATOR_MODEL, PI_AGENT_DOCUMENTER_MODEL
 * Set PI_WORKFLOW_MODEL as a global fallback for all agents.
 *
 * Commands:
 *   /agent-team <request>   — run the full lifecycle on a request
 *   /agent-team-clear       — clear the progress widget
 *
 * Tool:
 *   run_agent_team { request, max_loops? } — same, callable by the primary agent
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
    runPhaseCore,
    runAgentWithFallback,
    renderRunWorkflowCall,
    renderRunWorkflowResult,
    type AgentDef,
    type PhaseState,
    loadDotEnv,
    displayName,
    statusMeta,
    statusBadge,
    agentPhaseStatus,
    formatContextUsage,
    appendLiveLog as appendLiveLogCore,
    renderWorkflowFooter,
    teamsBlock as teamsBlockCore,
    chooseTeam as chooseTeamCore,
    loadedExplicitly as loadedExplicitlyCore,
    isActiveWorkflow as isActiveWorkflowCore,
    loadAgents as loadAgentsCore,
    loadTeams as loadTeamsCore,
    loadPromptTemplate,
    renderTemplate,
    allTeamAgents,
    makeSpawnWrapper,
    resolveAgentModel,
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

// This file is "agent-team". See workflow-core for loadedExplicitly /
// selectedWorkflowExtension / isActiveWorkflow (shared, parameterized over name).
const SELF_NAME = "agent-team";

const loadedExplicitly = () =>
    loadedExplicitlyCore(import.meta.url, "agent-team.ts");
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

// Empty string = inherit pi's configured default model.
// Per-agent model is set in each agent's .md frontmatter `model:` field.
// PI_WORKFLOW_MODEL is the global env fallback for agents without a model.
const WORKER_MODEL = process.env.PI_WORKFLOW_MODEL || "";
// Optional per-agent watchdog: kill an agent that runs longer than N minutes
// (PI_WORKFLOW_AGENT_TIMEOUT, in minutes). 0 / unset = no timeout.
const AGENT_TIMEOUT_MS =
    Math.max(0, parseFloat(process.env.PI_WORKFLOW_AGENT_TIMEOUT || "0") || 0) *
    60_000;
// Opt-in curated cross-agent context bundle (on by default). When enabled, each
// later phase receives a "Shared run context" block containing the durable artifacts
// earlier agents produced (recon, critique, etc.) that the task builders do not
// already thread. Set PI_AGENT_TEAM_SHARED_CONTEXT=0 to disable — each agent then
// sees only what its own task prompt carries, matching the pre-port behaviour.
const SHARED_CONTEXT = process.env.PI_AGENT_TEAM_SHARED_CONTEXT !== "0";
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
    // Shared run/session state — mutated by orchestrator-core, read by this
    // extension's widget/footer/hooks.
    const st = newOrchestratorState();
    // Extension-local: live ctx, session dir, subprocess.
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
            prepareRun: () => {},
        },
        config: {
            sharedContext: SHARED_CONTEXT,
            maxDispatchesPerTurn: MAX_DISPATCHES_PER_TURN,
            minDispatchOutputChars: MIN_DISPATCH_OUTPUT_CHARS,
        },
    };

    // The only tools the primary agent (orchestrator) may use. It has NO direct
    // codebase tools — it must delegate. This lockdown is re-asserted before every
    // agent turn (see before_agent_start); applying it once at session start is not
    // enough, because the restriction is dropped between turns and the orchestrator
    // would then regain codebase tools and start doing the work itself.
    const ORCHESTRATOR_TOOLS = [
        "select_agents",
        "dispatch_agent",
        "dispatch_parallel",
        "run_agent_team",
    ];

    const setupSessions = (cwd: string, wipe: boolean) => {
        sessionDir = setupSessionsCore(cwd, wipe);
    };

    // ── Team helpers ─────────────────────────────

    function fallbackModel(): string {
        if (WORKER_MODEL) return WORKER_MODEL;
        const m = widgetCtx?.model;
        return (
            (m?.provider && m?.id ? `${m.provider}/${m.id}` : m?.id) ||
            "default"
        );
    }
    function modelFor(agentKey: string): string {
        return resolveAgentModel(
            agentKey,
            st.agents,
            WORKER_MODEL,
            fallbackModel(),
        );
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
    function renderAgentCard(
        agentKey: string,
        colWidth: number,
        theme: any,
    ): string[] {
        const w = colWidth - 2;
        const truncate = (s: string, max: number) =>
            s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;

        const def = st.agents.get(agentKey.toLowerCase());
        const { status, elapsed, toolCount } = agentPhaseStatus(
            st.phases,
            agentKey,
        );

        // "Selected" = the primary agent has chosen this agent for the current
        // work (it has a phase — either declared up front via select_agents or
        // dispatched). A selected agent that hasn't run yet is "queued"; selected
        // cards get a status-colored border and a ▸ marker so the chosen agents
        // stand out from the idle roster.
        const selected = st.phases.some(
            (p) => p.agent === agentKey.toLowerCase(),
        );
        const queued = selected && status === "pending";

        // Resolve the card's icon/colour/word. Queued is distinct from idle so the
        // determined plan is visible before any agent runs.
        let { icon, color } = statusMeta(status);
        let word = status === "pending" ? "idle" : status;
        if (queued) {
            icon = "◌";
            color = "accent";
            word = "queued";
        }

        const borderColor = selected ? color : "dim";
        const marker = selected ? theme.fg(color, "▸ ") : "";
        const markerVisible = selected ? 2 : 0;

        const name = displayName(agentKey);
        const nameStr =
            marker +
            theme.fg("accent", theme.bold(truncate(name, w - markerVisible)));
        const nameVisible =
            markerVisible + Math.min(name.length, w - markerVisible);

        const timeStr = elapsed > 0 ? ` ${secs(elapsed)}` : "";
        const toolNote =
            status === "running" && toolCount > 0
                ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
                : "";
        const statusRaw = `${icon} ${word}${timeStr}${toolNote}`;
        const statusStr = theme.fg(color, truncate(statusRaw, w));
        const statusVisible = Math.min(statusRaw.length, w);

        // The phase whose live state this card reflects: the running one, else the
        // agent's most recent. Drives both the context bar and the active model.
        const own = st.phases.filter((p) => p.agent === agentKey.toLowerCase());
        const livePhase =
            own.find((p) => p.status === "running") ?? own[own.length - 1];

        // Context-usage bar, shown on every card.
        const ctxPct = livePhase?.contextPct ?? 0;
        // Use live context window from the API response if available, otherwise
        // fall back to the agent's declared context_window in its .md frontmatter.
        const ctxWindow =
            livePhase?.tokens?.contextWindow || def?.contextWindow || 0;
        const ctxTotalTok = livePhase?.tokens
            ? (livePhase.tokens.input || 0) + (livePhase.tokens.output || 0)
            : undefined;
        const { bar: ctxBar, display: ctxDisplay } = formatContextUsage({
            contextPct: ctxPct,
            tokenCount: ctxTotalTok,
            contextWindow: ctxWindow || undefined,
            barLength: 5,
        });

        const ctxRaw = `[${ctxBar}] ${ctxDisplay}`;
        const ctxStr = theme.fg("dim", truncate(ctxRaw, w));
        const ctxVisible = Math.min(ctxRaw.length, w);

        // Show the model the agent is actually running on. After a model fallback
        // this is the fallback model, not the originally-configured one; the bullet
        // switches from ◆ to ⚠ (width-neutral) and the text is highlighted so the
        // swap is visible.
        const fellBack = !!livePhase?.modelFallback;
        const effectiveModel = livePhase?.activeModel || modelFor(agentKey);
        const modelRaw = `${fellBack ? "⚠" : "◆"} ${effectiveModel}`;
        const modelStr = theme.fg(
            fellBack ? "accent" : "muted",
            truncate(modelRaw, w),
        );
        const modelVisible = Math.min(modelRaw.length, w);

        // Agent descriptions follow a "Short summary — details" convention;
        // show just the summary (before the em dash) so it fits the card.
        const descRaw = (def?.description || "—").split("—")[0].trim() || "—";
        const descText = truncate(descRaw, w - 1);
        const descLine = theme.fg("dim", descText);
        const descVisible = Math.min(descText.length, w - 1);

        const top = "┌" + "─".repeat(w) + "┐";
        const bot = "└" + "─".repeat(w) + "┘";
        const border = (content: string, visLen: number) =>
            theme.fg(borderColor, "│") +
            content +
            " ".repeat(Math.max(0, w - visLen)) +
            theme.fg(borderColor, "│");

        return [
            theme.fg(borderColor, top),
            border(" " + nameStr, 1 + nameVisible),
            border(" " + statusStr, 1 + statusVisible),
            border(" " + ctxStr, 1 + ctxVisible),
            border(" " + modelStr, 1 + modelVisible),
            border(" " + descLine, 1 + descVisible),
            theme.fg(borderColor, bot),
        ];
    }

    // The idle dashboard: a grid of ALL agents across all teams in teams.yaml.
    // Each card shows the model it will run.
    function renderAgentGrid(width: number, theme: any): string[] {
        // Show every unique agent from all teams, filtered to those with loaded .md defs
        const allRoster = allTeamAgents(st.teams).filter((m) =>
            st.agents.has(m.toLowerCase()),
        );
        const roster = activeMembers();
        const teamNames = Object.keys(st.teams);

        // Agents the primary agent has selected/dispatched this session, resolved
        // from the phases (in selection order). Includes agents that are NOT part of
        // the active team — e.g. an ad-hoc dispatch to a research agent.
        const selectedKeys = st.phases
            .map((p) => p.agent)
            .filter((k) => st.agents.has(k.toLowerCase()));
        const selectedCount = selectedKeys.length;
        const selecting = st.dispatchMode && selectedCount > 0;

        // Agents selected that are NOT in the ACTIVE team — whether they belong to
        // a different team or no team at all. When any are present, the header
        // describes the dispatch by name instead of misclaiming "selected from
        // <active team> (N/M)", which would be wrong for an off-team agent.
        const offActive = selecting
            ? selectedKeys.filter(
                  (k) =>
                      !roster.some((m) => m.toLowerCase() === k.toLowerCase()),
              )
            : [];
        const offTeam = offActive.length > 0;

        // At bootup show the full roster from all teams; once dispatching,
        // show only the dispatched agents (team members or not).
        const members = selecting ? selectedKeys : allRoster;

        const anyRunning = st.phases.some((p) => p.status === "running");
        const doneCount = st.phases.filter((p) => p.status === "done").length;
        const allDone =
            selectedCount > 0 &&
            st.phases.every((p) => p.status === "done" || p.status === "error");
        // Badge reflects the determined plan: queued before any run, working while
        // an agent runs, done once every selected agent has finished.
        const [selIcon, selColor, selWord] = anyRunning
            ? ["●", "accent", "working"]
            : allDone
              ? ["✓", "success", "done"]
              : ["◌", "accent", "queued"];
        const badge =
            selectedCount > 0
                ? theme.fg("dim", "  ·  ") +
                  theme.fg(
                      selColor,
                      `${selIcon} ${selWord}: ${doneCount}/${members.length}`,
                  )
                : "";

        let header: string;
        let hint: string;
        if (offTeam) {
            // One or more selected agents are outside the active team — name the
            // dispatched agent(s) rather than claim a team-relative count.
            const names = selectedKeys.map((k) => displayName(k)).join(", ");
            const allOff = offActive.length === selectedKeys.length;
            header =
                " " +
                theme.fg("accent", theme.bold("agent-team")) +
                theme.fg("dim", "  ·  ") +
                theme.fg("dim", allOff ? "off-team dispatch: " : "cross-team dispatch: ") +
                theme.fg("accent", names) +
                badge;
            const offNames = offActive.map((k) => displayName(k)).join(", ");
            hint = theme.fg(
                "dim",
                ` ${offNames} ${offActive.length === 1 ? "is" : "are"} not in team "${st.activeTeamName || "—"}"`,
            );
        } else {
            // The "(N agents · mode)" descriptor tracks the active set: the full team
            // at bootup, then the selected agents once the orchestrator has chosen
            // them — so the count and workflow mode match the work being done.
            // Count reflects the work: once the orchestrator has selected agents for
            // the job, show how many of the team were chosen (selected/team); at
            // bootup show the active team size out of all available agents (team/all).
            const descNum = selecting ? selectedCount : roster.length;
            const descDen = selecting ? roster.length : allRoster.length;
            header =
                " " +
                theme.fg("accent", theme.bold("agent-team")) +
                theme.fg("dim", "  ·  ") +
                theme.fg("dim", selecting ? "selected from " : "team ") +
                theme.fg("accent", st.activeTeamName || "—") +
                theme.fg(
                    "dim",
                    ` (${descNum}/${descDen} agent${descDen === 1 ? "" : "s"})`,
                ) +
                badge;
            hint = theme.fg(
                "dim",
                selecting
                    ? " primary agent selected these agents for the work"
                    : teamNames.length > 1
                      ? " /agent-team [request] — pick a team, then run"
                      : " /agent-team <request> to run",
            );
        }

        const lines: string[] = [header, hint, ""];

        if (members.length === 0) {
            lines.push(...renderEmptyAgentMessage(theme));
            return lines;
        }

        const { cols, gap, colWidth } = calculateGridLayout(
            members.length,
            width,
        );

        for (let i = 0; i < members.length; i += cols) {
            const rowMembers = members.slice(i, i + cols);
            const cards = rowMembers.map((m) =>
                renderAgentCard(m, colWidth, theme),
            );
            lines.push(...renderCardGrid(cards, cols, gap, colWidth));
        }
        return lines;
    }

    // Append the live log of the currently running agent — delegates to the
    // shared core implementation (pi-tui's visibleWidth is injected).
    const appendLiveLog = (lines: string[], width: number, theme: any) =>
        appendLiveLogCore(
            lines,
            width,
            theme,
            st.phases,
            st.running,
            visibleWidth,
        );

    function updateWidget() {
        if (!widgetCtx) return;
        widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
            const text = new Text("", 0, 1);
            return {
                render(width: number): string[] {
                    if (st.phases.length === 0 || st.dispatchMode) {
                        // Idle or ad-hoc dispatch: keep the full team grid on
                        // screen. At bootup every card is idle; once the primary
                        // agent dispatches work, the selected cards are marked and
                        // reflect live status, while the rest stay idle. The live
                        // log of the running agent is appended below the grid.
                        const gridLines = renderAgentGrid(width, theme);
                        if (st.dispatchMode)
                            appendLiveLog(gridLines, width, theme);
                        text.setText(gridLines.join("\n"));
                        return text.render(width);
                    }

                    // ── Pipeline view (full run_agent_team) ───────────
                    // Use the SAME rich cards as the idle/dispatch dashboard
                    // (name · status · context bar · model · description) so the
                    // view is consistent before and during a run.
                    const arrowWidth = 5; // " ──▸ "
                    const cols = st.phases.length;
                    const colWidth = Math.max(
                        14,
                        Math.floor((width - arrowWidth * (cols - 1)) / cols),
                    );

                    const cards = st.phases.map((p) =>
                        renderAgentCard(p.agent, colWidth, theme),
                    );
                    const lines: string[] = [];

                    const passInfo =
                        st.iteration > 1
                            ? theme.fg(
                                  "dim",
                                  `  attempt ${st.iteration}/${st.maxLoopsRef}`,
                              )
                            : "";
                    // Reflect the agents actually running, not a fixed label.
                    const doneCount = st.phases.filter(
                        (p) => p.status === "done",
                    ).length;
                    const phaseProgress = st.running
                        ? ` (${doneCount}/${st.phases.length})`
                        : "";
                    const workflowTitle =
                        st.phases.map((p) => p.label).join("→") + phaseProgress;
                    lines.push(
                        " " +
                            theme.fg("accent", theme.bold(workflowTitle)) +
                            passInfo +
                            statusBadge(theme, st.running, st.lastStatus),
                    );
                    lines.push("");

                    // Use shared arrow layout renderer
                    lines.push(
                        ...renderPhaseCardsWithArrows(cards, theme, st.phases),
                    );

                    // Live log of the currently running agent — grows to fill the
                    // available vertical space, pushing the editor down, then tails.
                    appendLiveLog(lines, width, theme);

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
    // the module counters after each spawn. agent-team always uses per-agent
    // sessions (sharedSession: false).
    const spawnAgentWithModel = makeSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
        sharedSession: false,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        updateWidget: () => updateWidget(),
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
        // Per-agent model: check the agent's own .md frontmatter first, then the
        // team config (env var override), then fall back to the global default.
        const agentKey = agentDef.name.toLowerCase();
        const primaryModel = resolveAgentModel(
            agentKey,
            st.agents,
            WORKER_MODEL,
            fallbackModel(),
        );
        // Fallback: the model the current pi session is running on (the primary
        // agent's model). If an agent's configured model fails to load, we retry
        // with the session model since it's known to work — pi itself is using it.
        const sm = widgetCtx?.model;
        const sessionModel =
            sm?.provider && sm?.id ? `${sm.provider}/${sm.id}` : sm?.id || "";
        const modelFallback =
            sessionModel && sessionModel !== primaryModel ? sessionModel : "";

        // Delegate to shared core (eliminates ~50 lines of near-identical
        // fallback logic with notification API drift).
        return runAgentWithFallback(
            agentDef,
            task,
            phase,
            cwd,
            primaryModel,
            modelFallback,
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

    if (active)
        pi.registerCommand("agent-team", {
            description:
                "Run a workflow: '/agent-team <request>' for full lifecycle, '/agent-team spec <request>' for implementation spec only",
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
                let maxLoops = DEFAULT_MAX_LOOPS;
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
                // The first token may name a team (e.g. `/agent-team building
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
        pi.registerCommand("agent-team-clear", {
            description: "Clear the agent-team progress widget",
            handler: async (_args, ctx) => {
                widgetCtx = ctx;
                ctx.ui.setWidget("agent-team", undefined);
                ctx.ui.notify("Workflow-team widget cleared.", "info");
            },
        });

    // ── Tool — let the primary agent invoke the workflow ──

    if (active)
        pi.registerTool({
            name: "run_agent_team",
            label: "Run Workflow (Team)",
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
                const result = await runWorkflowCore(
                    st,
                    host,
                    request,
                    max_loops && max_loops > 0 ? max_loops : DEFAULT_MAX_LOOPS,
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
                    "run_agent_team",
                    args,
                    theme,
                    activeMembers,
                    Text,
                );
            },

            renderResult(result, options, theme) {
                return renderRunWorkflowResult(
                    "agent-team",
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
    // dispatch extension broadcasts on pi.events into our dashboard grid and
    // re-render. (Dispatch and the automated pipeline are mutually exclusive in
    // time — dispatchAgentCore refuses while s.running — so replacing st.phases
    // is safe.)

    if (active)
        pi.events.on(DISPATCH_UPDATE, (data) => {
            const u = data as DispatchUpdate;
            st.phases = u.phases;
            st.dispatchMode = u.dispatchMode;
            st.dispatchElapsedMs = u.dispatchElapsedMs;
            updateWidget();
        });

    // ── Cancellation hook (integrates with escape-cancel if present) ──

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

    // ── Orchestrator System Prompt ─────────────────
    //
    // The primary agent acts as an orchestrator: it receives the user's request,
    // reviews it, and decides whether to run the full pipeline or dispatch
    // individual agents for ad-hoc work. It has access to both run_agent_team
    // (for the automated lifecycle) and dispatch_agent (for free-form tasks).
    //
    // This handler injects a system prompt that guides the orchestrator's
    // decision-making and provides a catalog of available agents.

    if (active)
        pi.on("before_agent_start", async (event, _ctx) => {
            // Re-assert the orchestration lockdown every turn. setActiveTools at
            // session start only holds for the first turn — without re-applying it
            // here the primary agent regains codebase tools on later turns and stops
            // delegating, doing the work itself instead.
            pi.setActiveTools(ORCHESTRATOR_TOOLS);

            // A new user request = a new workflow. Mark it so the first
            // select_agents / dispatch_agent of this request rebuilds the cards from
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

            // APPEND the orchestration layer to Pi's base system prompt instead of
            // replacing it. The base prompt carries the tool-calling scaffolding the
            // model needs to actually emit tool calls; replacing it wholesale made
            // weaker models narrate a plan as text instead of dispatching. A short,
            // imperative directive goes first so the very next action is a tool call.
            // Load the orchestrator prompt from an external template file
            const template = loadPromptTemplate("orchestrator", "", _ctx.cwd);
            const orchestratorAddendum = renderTemplate(template, {
                run_tool_name: "run_agent_team",
                team_name: st.activeTeamName || "none",
                team_members: teamMembers,
                agent_catalog: agentCatalog,
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
        // naming a team as the first token of /agent-team). The idle dashboard
        // still shows every agent across all teams.
        st.activeTeamName = "";
        st.dispatchMode = false;
        st.phases = [];

        // Only the active workflow extension owns the chrome. When both are
        // auto-discovered, the inactive one clears its widget and bows out so it
        // never stacks a second dashboard, footer, or cancellation hook.
        if (!isActiveWorkflow()) {
            ctx.ui.setWidget("agent-team", undefined);
            return;
        }

        // Show the idle team dashboard (grid of agents + their models).
        updateWidget();

        // Lock down the primary agent to orchestration tools only. The primary
        // agent must NOT have direct codebase tools — it delegates all work to
        // specialist agents via dispatch_agent or runs the full pipeline via
        // run_agent_team. Without this lockdown, the primary agent would
        // just do the work itself instead of coordinating the team.
        if (active) pi.setActiveTools(ORCHESTRATOR_TOOLS);
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
            "agent-team",
            `Workflow Team: ${present.length}/${REQUIRED_AGENTS.length} agents`,
        );

        if (loadedExplicitly()) {
            const flow = REQUIRED_AGENTS.map(
                (a) => a.charAt(0).toUpperCase() + a.slice(1),
            ).join(" → ");
            if (missing.length) {
                ctx.ui.notify(
                    `Workflow Team\n` +
                        `${flow}\n\n` +
                        `Missing agents in .pi/agents/: ${missing.join(", ")} — add them to enable /agent-team.`,
                    "warning",
                );
            } else {
                ctx.ui.notify(
                    `Workflow Team\n` +
                        `Teams:\n${teamsBlock()}\n\n` +
                        `/agent-team [request]   Pick a team (Select Team), then run the lifecycle\n` +
                        `/agent-team-clear       Clear the progress widget\n` +
                        `run_agent_team          Tool — the agent can launch the workflow for non-trivial tasks\n` +
                        `dispatch_agent          Tool — dispatch task(s) to any loaded agent(s) outside the pipeline`,
                    "info",
                );
                // The per-agent model list is already visible on the dashboard cards
                // and in the footer, so we don't repeat it as a startup notification.
            }
        }

        // Footer: workflow status + the PRIMARY (orchestrator) agent's model and its
        // own context usage. The per-agent models and context bars live on the
        // dashboard cards; the footer shows only the primary session's, since that
        // is the model running the orchestrator that pi was loaded with.
        ctx.ui.setFooter?.((_tui: any, theme: any, _data: any) => ({
            dispose: () => {},
            invalidate() {},
            render(width: number): string[] {
                // Primary (orchestrator) agent's model — the full `provider/model`
                // pi was loaded with.
                const pm = widgetCtx?.model || ctx.model;
                const primaryFull =
                    pm?.provider && pm?.id
                        ? `${pm.provider}/${pm.id}`
                        : pm?.id || "default";
                return renderWorkflowFooter({
                    width,
                    theme,
                    selfName: "agent-team",
                    model: primaryFull,
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
