// ABOUTME: The workflow orchestrator — runs a team of agents (scout → plan → … → ship) with a
// ABOUTME: per-agent model (each agent's .md `model:` / PI_AGENT_<NAME>_MODEL, falling back to
// ABOUTME: PI_WORKFLOW_MODEL or the session model) and per-agent sessions.
/**
 * Workflow Team — scout / plan / refine / implement / review / validate / ship orchestrator
 *
 * Runs the agents defined in .pi/agents/*.md, optionally led by a read-only scout
 * recon pass. The implementer writes the tests (TDD); the validator is the gate:
 *   scout? -> planner -> refiner -> implementer -> reviewer -> validator(gate) -> shipper
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
 *   PI_AGENT_<NAME>_MODEL for any pipeline agent — SCOUT, PLANNER, REFINER,
 *   IMPLEMENTER, REVIEWER, VALIDATOR, SHIPPER.
 * Set PI_WORKFLOW_MODEL as a global fallback for all agents.
 *
 * Commands:
 *   /agent-workflow <request>   — run the full lifecycle on a request
 *   /agent-workflow-clear       — clear the progress widget
 *
 * Tool:
 *   run_agent_workflow { request, max_loops? } — same, callable by the primary agent
 *
 * Self-contained: depends only on pi packages + Node builtins, and reads agent
 * definitions straight from .pi/agents/. Drop it in .pi/extensions/ and it loads.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    Text,
    Container,
    Markdown,
    truncateToWidth,
    visibleWidth,
} from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { secs } from "../utils/workflow-utils";
import { emitNotification } from "../utils/notify";
import {
    type Checkpoint,
    createCheckpoint,
    revertCommands,
    describeCheckpoint,
    ensureWorkBranch,
} from "../utils/checkpoint";
import {
    calculateGridLayout,
    renderCardGrid,
    renderPhaseCardsWithArrows,
    renderEmptyAgentMessage,
    renderRichCard,
    MAX_CARD_WIDTH,
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
    statusBadge,
    appendLiveLog as appendLiveLogCore,
    LOG_PANEL_RESERVE,
    renderWorkflowFooter,
    teamsBlock as teamsBlockCore,
    chooseTeam as chooseTeamCore,
    loadedExplicitly as loadedExplicitlyCore,
    isActiveWorkflow as isActiveWorkflowCore,
    loadAgents as loadAgentsCore,
    loadTeams as loadTeamsCore,
    loadSkills,
    sessionLabel,
    loadPromptTemplate,
    renderTemplate,
    allTeamAgents,
    makeSpawnWrapper,
    resolveAgentModel,
    setModelOverride,
    clearModelOverride,
    clearAllModelOverrides,
    getModelOverrides,
} from "../utils/workflow-core";
import {
    newOrchestratorState,
    type OrchestratorHost,
    runWorkflowCore,
    runFullWorkflowCommand,
    resolveAgent,
} from "../utils/orchestrator-core";
import { DISPATCH_UPDATE, type DispatchUpdate } from "../utils/dispatch-events";

// Run before any process.env reads below (WORKER_MODEL, …).
loadDotEnv(process.cwd());

// This file is "agent-workflow". See workflow-core for loadedExplicitly /
// selectedWorkflowExtension / isActiveWorkflow (shared, parameterized over name).
const SELF_NAME = "agent-workflow";

const loadedExplicitly = () =>
    loadedExplicitlyCore(import.meta.url, "agent-workflow.ts");
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
// earlier agents produced (recon, review, etc.) that the task builders do not
// already thread. Set PI_AGENT_WORKFLOW_SHARED_CONTEXT=0 to disable — each agent then
// sees only what its own task prompt carries, matching the pre-port behaviour.
const SHARED_CONTEXT = process.env.PI_AGENT_WORKFLOW_SHARED_CONTEXT !== "0";
// Opt-in: archive each shipped run's final plan to docs/plans/<date>-<slug>.md so
// it's committed with the change (a permanent, reviewable plan record). Off by
// default; also auto-enabled when a docs/plans/ directory already exists (checked
// per-run in the core). Set PI_WORKFLOW_ARCHIVE_PLANS=1 to force it on.
const ARCHIVE_PLANS = process.env.PI_WORKFLOW_ARCHIVE_PLANS === "1";
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
    // The model registry lives on the command/event ctx (not the factory `pi`),
    // so capture it whenever a ctx is available for use in getArgumentCompletions
    // (which receives no ctx of its own).
    let modelRegistry: any;
    // Running USD cost of the PRIMARY (orchestrator) session this session. pi's
    // getContextUsage() exposes tokens but no cost, so accumulate it ourselves from
    // each assistant message's usage.cost (the provider already priced it). The
    // footer adds this to the sub-agent phase total so it reflects all spend.
    let primaryCostUsd = 0;
    // The checkpoint taken before the most recent workflow run (for /revert).
    let lastCheckpoint: Checkpoint | null = null;
    // Run a git command in `cwd`, returning trimmed stdout (throws on failure).
    const git = (cwd: string) => (args: string[]): string =>
        execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    const checkpointPath = (cwd: string) =>
        join(cwd, ".agent", "checkpoints", "latest.json");
    // Append `entry` to the repo's .gitignore if not already present (best-effort).
    const ensureGitignored = (cwd: string, entry: string) => {
        try {
            const file = join(cwd, ".gitignore");
            const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
            const lines = existing.split(/\r?\n/).map((l) => l.trim());
            if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, "")))
                return;
            const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
            writeFileSync(file, `${existing}${prefix}${entry}\n`, "utf8");
        } catch {}
    };
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
            ensureWorkBranch: (cwd, request) => {
                try {
                    const wb = ensureWorkBranch(git(cwd), request);
                    if (!wb) return null;
                    // Keep the .agent/ scratch out of the implementer's commits.
                    ensureGitignored(cwd, ".agent/");
                    return { branch: wb.branch, base: wb.base };
                } catch {
                    // Best-effort — never block a run on branch setup.
                    return null;
                }
            },
        },
        config: {
            sharedContext: SHARED_CONTEXT,
            archivePlans: ARCHIVE_PLANS,
            maxDispatchesPerTurn: MAX_DISPATCHES_PER_TURN,
            minDispatchOutputChars: MIN_DISPATCH_OUTPUT_CHARS,
        },
    };

    // The primary agent keeps its FULL toolset (read/write/edit/bash/grep/find/ls
    // + skills) alongside the dispatch tools (select_agents / dispatch_agent /
    // dispatch_parallel / run_agent_workflow). It does work itself by default and
    // delegates only when warranted (see prompts/orchestrator.md), so we do NOT
    // lock the toolset down to dispatch-only.

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
    // Rich agent card — delegates to the shared renderer. Shows the PER-AGENT model.
    // The context bar is shown only when there's real usage (idle dashboards pass false).
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
                theme.fg("accent", theme.bold("agent-workflow")) +
                theme.fg("dim", "  ·  ") +
                theme.fg(
                    "dim",
                    allOff ? "off-team dispatch: " : "cross-team dispatch: ",
                ) +
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
                theme.fg("accent", theme.bold("agent-workflow")) +
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
                      ? " /agent-workflow [request] — pick a team, then run"
                      : " /agent-workflow <request> to run",
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
                // agent-workflow agents each have their own per-agent model/session, so
                // show the context bar in both idle and working states (idle shows
                // 0%/<the agent's window> until it runs).
                renderAgentCard(m, colWidth, theme, true),
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

    // Coalesce re-renders: parallel dispatch fires a DISPATCH_UPDATE for every
    // stream event of every sub-agent — dozens per second with 3+ agents — which
    // tears the terminal and stacks frames. Collapse a burst into at most one
    // render per WIDGET_MIN_INTERVAL_MS, always trailing so the final state paints.
    let widgetTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWidgetRender = 0;
    const WIDGET_MIN_INTERVAL_MS = 80;

    function updateWidget() {
        const now = Date.now();
        const since = now - lastWidgetRender;
        if (since >= WIDGET_MIN_INTERVAL_MS) {
            if (widgetTimer) {
                clearTimeout(widgetTimer);
                widgetTimer = null;
            }
            lastWidgetRender = now;
            renderWidgetNow();
        } else if (!widgetTimer) {
            widgetTimer = setTimeout(() => {
                widgetTimer = null;
                lastWidgetRender = Date.now();
                renderWidgetNow();
            }, WIDGET_MIN_INTERVAL_MS - since);
        }
    }

    // Cancel a pending trailing render so an explicit widget clear can't be
    // resurrected ~WIDGET_MIN_INTERVAL_MS later.
    function cancelPendingWidget() {
        if (widgetTimer) {
            clearTimeout(widgetTimer);
            widgetTimer = null;
        }
    }

    // Hard safety net: never let the widget grow taller than the screen minus the
    // rows reserved for the editor + footer. A tall team grid or live-log panel
    // would otherwise push the input box and footer off-screen. Clip the overflow
    // with a notice so those always keep their rows.
    function clampWidget(out: string[], theme: any): string[] {
        const rows = process.stdout.rows || 24;
        const max = Math.max(3, rows - LOG_PANEL_RESERVE);
        if (out.length <= max) return out;
        const kept = out.slice(0, Math.max(1, max - 1));
        kept.push(
            theme.fg(
                "dim",
                `   … ${out.length - kept.length} more line(s) — clipped to fit`,
            ),
        );
        return kept;
    }

    // Build the dashboard as a plain line array. Returned to pi via the string[]
    // setWidget overload (below) so pi owns the diffing/redraw — re-issuing a
    // custom component each tick made the sticky widget redraw incorrectly
    // (status lines ghosted frame-over-frame).
    function buildWidgetLines(width: number, theme: any): string[] {
        if (st.phases.length === 0 || st.dispatchMode) {
            // Idle or ad-hoc dispatch: the team grid (selected cards marked once
            // the orchestrator dispatches), with the running agent's live log below.
            const gridLines = renderAgentGrid(width, theme);
            if (st.dispatchMode) appendLiveLog(gridLines, width, theme);
            return clampWidget(gridLines, theme);
        }

        // ── Pipeline view (full run_agent_workflow) ───────────
        const arrowWidth = 3; // "-->" (must match renderPhaseCardsWithArrows)
        const cols = st.phases.length;
        // Cap at MAX_CARD_WIDTH so running cards match the idle grid instead of
        // stretching to fill — left-aligned, connected by arrows. The 14 floor
        // keeps the single (non-wrapping) arrow row fitting when phases are many.
        const colWidth = Math.min(
            MAX_CARD_WIDTH,
            Math.max(14, Math.floor((width - arrowWidth * (cols - 1)) / cols)),
        );
        const cards = st.phases.map((p) => renderAgentCard(p.agent, colWidth, theme));
        const lines: string[] = [];
        const passInfo =
            st.iteration > 1
                ? theme.fg("dim", `  attempt ${st.iteration}/${st.maxLoopsRef}`)
                : "";
        const doneCount = st.phases.filter((p) => p.status === "done").length;
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
        lines.push(...renderPhaseCardsWithArrows(cards, theme, st.phases));
        appendLiveLog(lines, width, theme);
        return clampWidget(lines, theme);
    }

    function renderWidgetNow() {
        if (!widgetCtx || !widgetCtx.hasUI) return; // no chrome without a UI
        const theme = widgetCtx.ui.theme;
        // Reserve 2 columns: pi wraps each widget line in Text(line, 1, 0) (a +1
        // left pad), so a row built to the full terminal width would overflow by one
        // column and wrap — shattering the card borders. Build to columns-2 so the
        // widest row plus the pad still fits with a column to spare.
        const width = Math.max(20, (process.stdout.columns || 80) - 2);
        const lines = buildWidgetLines(width, theme);
        // Use the component (factory) overload, not the string[] one: pi hard-caps
        // string[] widgets at MAX_WIDGET_LINES (10) with "(widget truncated)", which
        // would cut the live-log panel. Build the same per-line Container pi uses
        // internally for string[] (so it redraws cleanly in place — no ghosting),
        // but without the 10-line cap. Our own clampWidget already bounds the height
        // to the screen, so this can't push the editor/footer off.
        widgetCtx.ui.setWidget("agent-workflow", (_tui: any) => {
            const container = new Container();
            for (const line of lines) container.addChild(new Text(line, 1, 0));
            return container;
        });
    }

    // ── Run a single agent as a subprocess ───────

    // Thin wrapper around the shared spawnAgentWithModel from workflow-core.
    // Uses makeSpawnWrapper to accumulate token/tool/dropped-line totals into
    // the module counters after each spawn. Every agent runs in its own session.
    const spawnAgentWithModel = makeSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
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

    // Register commands + tool only when this is the active workflow extension.
    const active = isActiveWorkflow();

    // CLI flags (active extension only, so they register once). They surface the
    // most common env knobs at launch: `--max-loops N` and `--confine-cwd`.
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
        pi.registerCommand("agent-workflow", {
            description:
                "Run a workflow: '/agent-workflow <request>' for full lifecycle, '/agent-workflow spec <request>' for implementation spec only",
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
                    ctx.ui.notify("No agents found in .pi/agents/.", "error");
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
                // The first token may name a team (e.g. `/agent-workflow building
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
                    sessionLabel("agent-workflow", st.activeTeamName, finalRequest),
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
        pi.registerCommand("agent-workflow-clear", {
            description: "Clear the agent-workflow progress widget",
            handler: async (_args, ctx) => {
                widgetCtx = ctx;
                cancelPendingWidget();
                ctx.ui.setWidget("agent-workflow", undefined);
                ctx.ui.notify("Workflow-team widget cleared.", "info");
            },
        });

    // ── /agent-model — change a sub-agent's model on the fly (this session) ──
    // Overrides are in memory only: they apply to every subsequent dispatch/run of
    // that agent and reset when pi restarts. The dashboard cards re-render with the
    // new model immediately.
    if (active)
        pi.registerCommand("agent-model", {
            description:
                "Change a sub-agent's model for this session: '/agent-model' to list, '/agent-model <agent> <model>' to set, '/agent-model <agent> reset' or '/agent-model reset' to clear",
            getArgumentCompletions: (prefix: string) => {
                // First token: the agent name (plus the bare "reset" form).
                if (!/\s/.test(prefix)) {
                    const p = prefix.toLowerCase();
                    return ["reset", ...Array.from(st.agents.keys())]
                        .filter((c) => c.startsWith(p))
                        .map((c) => ({ value: c, label: c }));
                }
                // Second token: the model. Only offered for a known agent, and
                // never after the bare "reset" form.
                const m = prefix.match(/^(\S+)\s+(.*)$/);
                if (!m) return null;
                const [, first, modelPrefix] = m;
                if (first.toLowerCase() === "reset") return null;
                if (!resolveAgent(st.agents, first)) return null;
                // Available models (auth configured), falling back to all known.
                if (!modelRegistry) return null;
                let models: { id: string; provider: string }[] = [];
                try {
                    models = modelRegistry.getAvailable();
                    if (models.length === 0) models = modelRegistry.getAll();
                } catch {
                    return null;
                }
                const q = modelPrefix.toLowerCase();
                const ids = Array.from(
                    new Set(models.map((mm) => `${mm.provider}/${mm.id}`)),
                )
                    .filter((id) => id.toLowerCase().includes(q))
                    .sort();
                // Let "reset" also complete in the model slot (clears the override).
                const opts = "reset".startsWith(q) ? ["reset", ...ids] : ids;
                if (opts.length === 0) return null;
                return opts.map((id) => ({ value: `${first} ${id}`, label: id }));
            },
            handler: async (args, ctx) => {
                widgetCtx = ctx;
                modelRegistry = (ctx as any).modelRegistry;
                st.agents = loadAgents(ctx.cwd);
                const raw = (args || "").trim();

                // No args → list each agent's effective model, marking overrides.
                if (!raw) {
                    const overrides = getModelOverrides();
                    const rows = Array.from(st.agents.values())
                        .map((d) => {
                            const key = d.name.toLowerCase();
                            const mark = overrides.has(key)
                                ? "  *(override)"
                                : "";
                            return `  ${displayName(d.name).padEnd(13)} ${modelFor(d.name)}${mark}`;
                        })
                        .join("\n");
                    ctx.ui.notify(
                        `Sub-agent models (this session)\n${rows}\n\n` +
                            `Set:       /agent-model <agent> <model>\n` +
                            `Reset one: /agent-model <agent> reset\n` +
                            `Reset all: /agent-model reset`,
                        "info",
                    );
                    return;
                }

                // "/agent-model reset" → clear all overrides.
                if (raw.toLowerCase() === "reset") {
                    const n = clearAllModelOverrides();
                    updateWidget();
                    ctx.ui.notify(
                        `Cleared ${n} model override${n === 1 ? "" : "s"} — agents back to their configured models.`,
                        "info",
                    );
                    return;
                }

                const parts = raw.split(/\s+/);
                const def = resolveAgent(st.agents, parts[0]);
                if (!def) {
                    ctx.ui.notify(
                        `Unknown agent "${parts[0]}". Loaded: ${Array.from(st.agents.keys()).join(", ")}`,
                        "error",
                    );
                    return;
                }
                const key = def.name.toLowerCase();
                const rest = parts.slice(1).join(" ").trim();

                // "/agent-model <agent>" → show its current effective model.
                if (!rest) {
                    ctx.ui.notify(
                        `${displayName(def.name)} → ${modelFor(def.name)}`,
                        "info",
                    );
                    return;
                }

                // "/agent-model <agent> reset|default|clear" → clear its override.
                if (/^(reset|default|clear)$/i.test(rest)) {
                    const had = clearModelOverride(key);
                    updateWidget();
                    ctx.ui.notify(
                        had
                            ? `Reset ${displayName(def.name)} to its configured model (${modelFor(def.name)}).`
                            : `${displayName(def.name)} has no override.`,
                        "info",
                    );
                    return;
                }

                // Otherwise set the override to the given model string.
                setModelOverride(key, rest);
                updateWidget();
                ctx.ui.notify(
                    `${displayName(def.name)} model → ${rest} (this session).`,
                    "info",
                );
            },
        });

    // ── /revert — restore the workspace to the pre-run checkpoint ──
    if (active)
        pi.registerCommand("revert", {
            description:
                "Revert the workspace to the checkpoint taken before the last workflow run (current state is backed up to a git stash first)",
            handler: async (_args: string, ctx: any) => {
                let cp = lastCheckpoint;
                if (!cp) {
                    try {
                        cp = JSON.parse(
                            readFileSync(checkpointPath(ctx.cwd), "utf8"),
                        ) as Checkpoint;
                    } catch {
                        cp = null;
                    }
                }
                if (!cp) {
                    ctx.ui.notify(
                        "No checkpoint found — run a workflow first.",
                        "info",
                    );
                    return;
                }
                const run = git(ctx.cwd);
                const choice = await ctx.ui.select(
                    `Revert workspace to ${describeCheckpoint(cp)}? Current state is backed up to a stash first.`,
                    ["Revert", "Cancel"],
                );
                if (choice !== "Revert") {
                    ctx.ui.notify("Revert cancelled.", "info");
                    return;
                }
                let backup = "";
                try {
                    backup = run(["stash", "create"]);
                } catch {}
                try {
                    for (const cmd of revertCommands(cp)) run(cmd);
                    updateWidget();
                    ctx.ui.notify(
                        `Reverted to ${describeCheckpoint(cp)}.` +
                            (backup
                                ? ` Previous state backed up — restore with: git stash apply ${backup.slice(0, 12)}`
                                : "") +
                            " Any untracked files the run created were left in place.",
                        "info",
                    );
                } catch (e: any) {
                    ctx.ui.notify(
                        `Revert failed: ${e?.message || e}.` +
                            (backup
                                ? ` Your state is safe (backup ${backup.slice(0, 12)}).`
                                : ""),
                        "error",
                    );
                }
            },
        });

    // ── Tool — let the primary agent invoke the workflow ──

    if (active)
        pi.registerTool({
            name: "run_agent_workflow",
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

                // Snapshot the workspace before the run so /revert can undo it.
                try {
                    const cp = createCheckpoint(git(ctx.cwd), request);
                    if (cp) {
                        lastCheckpoint = cp;
                        mkdirSync(dirname(checkpointPath(ctx.cwd)), {
                            recursive: true,
                        });
                        writeFileSync(
                            checkpointPath(ctx.cwd),
                            JSON.stringify(cp, null, 2),
                        );
                    }
                } catch {
                    // best-effort; never block a run on checkpointing
                }

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
                    sessionLabel("agent-workflow", st.activeTeamName, request),
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
                    "run_agent_workflow",
                    args,
                    theme,
                    activeMembers,
                    Text,
                );
            },

            renderResult(result, options, theme) {
                return renderRunWorkflowResult(
                    "agent-workflow",
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

    // ── Primary-session cost ──
    // Accumulate the orchestrator's own spend from each assistant message's
    // usage.cost (priced by the provider). Sub-agents run in separate processes,
    // so their messages never fire this on the primary session — no double count.
    if (active)
        pi.on("message_end", async (event: any) => {
            const msg = event?.message;
            const total = msg?.usage?.cost?.total;
            if (msg?.role === "assistant" && typeof total === "number" && total > 0) {
                primaryCostUsd += total;
                updateWidget(); // refresh the footer with the new total
            }
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
            if (st.dispatchedThisTurn || st.pipelineRanThisTurn) {
                updateWidget();
                // Ping the user when real agent work finishes — these runs are long
                // and often unattended. Trivial reply-only turns are skipped.
                const what = st.pipelineRanThisTurn
                    ? `workflow ${st.lastStatus}`
                    : "dispatch done";
                emitNotification(`pi: ${what} (${secs(turnMs)})`);
            }
        });

    // ── Orchestrator System Prompt ─────────────────
    //
    // The primary agent acts as an orchestrator: it receives the user's request,
    // reviews it, and decides whether to run the full pipeline or dispatch
    // individual agents for ad-hoc work. It has access to both run_agent_workflow
    // (for the automated lifecycle) and dispatch_agent (for free-form tasks).
    //
    // This handler injects a system prompt that guides the orchestrator's
    // decision-making and provides a catalog of available agents.

    if (active)
        pi.on("before_agent_start", async (event, _ctx) => {
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

            // Terse summary of a description: the concise lead before the first
            // em-dash separator (falling back to the whole text), capped — keeps the
            // routing signal while cutting the per-turn prompt size sharply vs. the
            // full multi-sentence descriptions.
            const terse = (d: string, max: number): string => {
                const t = (d || "").trim();
                const lead = t.split(" — ")[0]!.trim();
                const base = lead.length >= 12 ? lead : t;
                return base.length > max
                    ? base.slice(0, max - 1).trimEnd() + "…"
                    : base;
            };

            // One compact line per agent: `name` — short capability. The orchestrator
            // routes via the explicit Routing section of the prompt; this is the roster
            // reference, so it stays terse (no full description, no per-agent tools).
            const agentCatalog = dispatchableDefs
                .map((def) => `- \`${def.name}\` — ${terse(def.description, 110)}`)
                .join("\n");

            const teamMembers = dispatchableDefs
                .map((d) => displayName(d.name))
                .join(", ");

            // Skills the orchestrator can use directly (files-only: any SKILL.md).
            const skills = loadSkills(_ctx.cwd);
            const skillCatalog = skills.length
                ? skills
                      .map((s) => `- **${s.name}** — ${terse(s.description, 140)}`)
                      .join("\n")
                : "(none)";

            // APPEND the orchestration layer to Pi's base system prompt instead of
            // replacing it. The base prompt carries the tool-calling scaffolding the
            // model needs to actually emit tool calls; replacing it wholesale made
            // weaker models narrate a plan as text instead of dispatching. A short,
            // imperative directive goes first so the very next action is a tool call.
            // Load the orchestrator prompt from an external template file
            const template = loadPromptTemplate("orchestrator", "", _ctx.cwd);
            const orchestratorAddendum = renderTemplate(template, {
                run_tool_name: "run_agent_workflow",
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

    pi.on("session_start", async (_event, ctx) => {
        widgetCtx = ctx;
        modelRegistry = (ctx as any).modelRegistry;
        // /agent-model overrides are session-scoped: drop any carried over by the
        // process-global store so they clear on a fresh start and on /reload (which
        // re-fires session_start), while still persisting across turns within a
        // session. Restart clears them too (new process).
        clearAllModelOverrides();
        primaryCostUsd = 0; // fresh per-session spend tally
        loadDotEnv(ctx.cwd); // pick up cwd/.env in case pi launched from elsewhere
        st.agents = loadAgents(ctx.cwd);
        st.teams = loadTeams(ctx.cwd);
        // Fall back to an "all" team if teams.yaml is absent/empty, so the
        // dashboard still has something to show.
        if (Object.keys(st.teams).length === 0) {
            st.teams = { all: Array.from(st.agents.keys()) };
        }
        // No team is active on startup — the user must pick one (the picker, or
        // naming a team as the first token of /agent-workflow). The idle dashboard
        // still shows every agent across all teams.
        st.activeTeamName = "";
        st.dispatchMode = false;
        st.phases = [];

        // Only the active workflow extension owns the chrome. When both are
        // auto-discovered, the inactive one clears its widget and bows out so it
        // never stacks a second dashboard, footer, or cancellation hook.
        if (!isActiveWorkflow()) {
            ctx.ui.setWidget("agent-workflow", undefined);
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
            "agent-workflow",
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
                        `Missing agents in .pi/agents/: ${missing.join(", ")} — add them to enable /agent-workflow.`,
                    "warning",
                );
            } else {
                ctx.ui.notify(
                    `Workflow Team\n` +
                        `Teams:\n${teamsBlock()}\n\n` +
                        `/agent-workflow [request]   Pick a team (Select Team), then run the lifecycle\n` +
                        `/agent-workflow-clear       Clear the progress widget\n` +
                        `run_agent_workflow          Tool — the agent can launch the workflow for non-trivial tasks\n` +
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
        // is the model running the orchestrator that pi was loaded with. TUI/RPC
        // only — skip the chrome in print/json modes.
        if (ctx.hasUI)
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
                        selfName: "agent-workflow",
                        model: primaryFull,
                        running: st.running,
                        lastStatus: st.lastStatus,
                        iteration: st.iteration,
                        maxLoopsRef: st.maxLoopsRef,
                        dispatchMode: st.dispatchMode,
                        phases: st.phases,
                        dispatchElapsedMs: st.dispatchElapsedMs,
                        runElapsedMs: st.runElapsedMs,
                        primaryCostUsd,
                        contextUsage: () => ctx.getContextUsage?.(),
                        visibleWidth,
                        truncateToWidth,
                    });
                },
            }));
    });
}
