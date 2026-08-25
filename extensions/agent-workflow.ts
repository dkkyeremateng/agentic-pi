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
 *   /agent-workflow <request>   — pick a team (or name one first), then run it
 *   /agent-workflow-clear       — clear the progress widget
 *
 * Tool:
 *   run_agent_workflow { request, max_loops? } — same, callable by the primary agent
 *
 * Self-contained: depends only on pi packages + Node builtins, and reads agent
 * definitions straight from .pi/agents/. Drop it in .pi/extensions/ and it loads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    Text,
    Container,
    Markdown,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "path";
import { execFileSync } from "child_process";
import {
    writeFileSync,
    mkdirSync,
    readFileSync,
    existsSync,
    appendFileSync,
} from "fs";
import { homedir } from "os";
import { secs } from "../utils/workflow/workflow-utils";
import { emitNotification } from "../utils/shared/notify";
import {
    createCheckpoint,
    isGitRepo,
    ensureWorkBranch,
} from "../utils/workflow/checkpoint";
import {
    calculateGridLayout,
    renderCardGrid,
    renderPhaseCardsWithArrows,
    renderEmptyAgentMessage,
    renderRichCard,
    renderTodos,
    renderStatusWidget,
    STATUS_WIDGET_MAX_LINES,
    DEFAULT_ACTIVITY_LINES,
    shouldRepaint,
    repaintIntervalFor,
    type RepaintPulseState,
    MAX_CARD_WIDTH,
} from "../utils/workflow/workflow-widgets";
import {
    REQUIRED_AGENTS,
    DEFAULT_MAX_LOOPS,
    WORKFLOW_REPORT_TYPE,
    WORKFLOW_REPORT_MAX,
    WORKFLOW_TOOL_REPORT_MAX,
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
    WORKFLOW_FOOTER_GLOBAL,
    type WorkflowFooterState,
    teamsBlock as teamsBlockCore,
    chooseTeam as chooseTeamCore,
    inferWorkflowTeam,
    loadedExplicitly as loadedExplicitlyCore,
    loadAgents as loadAgentsCore,
    loadTeams as loadTeamsCore,
    loadSkills,
    sessionLabel,
    loadPromptTemplate,
    renderTemplate,
    allTeamAgents,
    makeExtensionSpawnWrapper,
    resolveAgentModel,
    contextWindowForModel,
    setModelOverride,
    clearModelOverride,
    clearAllModelOverrides,
    getModelOverrides,
    parseProgressLedger,
    buildReviewChecklist,
    REVIEW_CHECKLIST,
} from "../utils/workflow/workflow-core";
import {
    newOrchestratorState,
    type OrchestratorHost,
    runWorkflowCore,
    runFullWorkflowCommand,
    resolveAgent,
    streamWorkflowActivity,
} from "../utils/workflow/orchestrator-core";
import {
    DISPATCH_UPDATE,
    type DispatchUpdate,
} from "../utils/workflow/dispatch-events";

// Run before any process.env reads below (WORKER_MODEL, …).
loadDotEnv(process.cwd());

// Whether the user launched pi with `-e …/agent-workflow.ts` explicitly (vs.
// auto-discovered) — gates the startup banner only.
const loadedExplicitly = () =>
    loadedExplicitlyCore(import.meta.url, "agent-workflow.ts");

// Typed view of the cross-extension globalThis bridges this extension installs.
// `as unknown as`: globalThis has no declared shape for these slots.
const bridges = globalThis as unknown as {
    __piKillWorkflowProc?: () => boolean;
    __piHasRunningWorkflow?: () => boolean;
} & Record<string, unknown>;

// The agents shipped alongside this extension serve as a fallback so the
// pipeline works when launched (e.g. via `-e`) from a project that has no
// .pi/agents of its own — the cwd still wins when it does. The core resolves
// that install dir itself (relative to workflow-core), so no path is passed.
const loadAgents = (cwd: string) => loadAgentsCore(cwd);
const loadTeams = (cwd: string) => loadTeamsCore(cwd);

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
// Stall watchdog (PI_WORKFLOW_AGENT_STALL, in minutes). 0 / unset = off. Kills a
// child that has emitted NOTHING for this long — see the rationale at the stall
// timer in workflow-core: silence separates "blocked" from "slow", which a
// wall-clock limit cannot. 20 is a sane opt-in value; a healthy agent streams
// events every few seconds, so even a long model call stays far under it.
const AGENT_STALL_MS =
    Math.max(0, parseFloat(process.env.PI_WORKFLOW_AGENT_STALL || "0") || 0) *
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
    // extension's widget and hooks, and published for the footer extension
    // (extensions/footer.ts) via WORKFLOW_FOOTER_GLOBAL.
    const st = newOrchestratorState();
    // Extension-local: live ctx, session dir, subprocess.
    let widgetCtx: any;
    // The primary session's model, tracked live via the model_select event so
    // sub-agents that fall back to "the primary's model" follow /model changes.
    let primaryModel: string | undefined;
    // Memo for the dashboard widget: pi may re-invoke the widget factory on
    // every redraw (theme change, resize, frame), so cache the (disk-reading)
    // built lines and only rebuild when the state generation, theme, or width
    // changes. updateWidget() bumps widgetGen to force a rebuild.
    let widgetGen = 0;
    const widgetMemo: {
        gen: number;
        width: number;
        theme: any;
        lines: string[];
    } = { gen: -1, width: -1, theme: null, lines: [] };
    // The model registry lives on the command/event ctx (not the factory `pi`),
    // so capture it whenever a ctx is available for use in getArgumentCompletions
    // (which receives no ctx of its own).
    let modelRegistry: any;
    // Running USD cost of the PRIMARY (orchestrator) session this session. pi's
    // getContextUsage() exposes tokens but no cost, so accumulate it ourselves from
    // each assistant message's usage.cost (the provider already priced it). Published
    // for the footer extension, which adds it to the sub-agent phase total so the
    // footer reflects all spend.
    let primaryCostUsd = 0;
    // Primary (orchestrator) session prompt-cache accounting, summed from each
    // assistant message's usage, for the footer's cache-hit-rate (CH).
    let primaryCacheRead = 0;
    let primaryInputTokens = 0;
    // Run a git command in `cwd`, returning trimmed stdout (throws on failure).
    const git =
        (cwd: string) =>
        (args: string[]): string =>
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
            if (
                lines.includes(entry) ||
                lines.includes(entry.replace(/\/$/, ""))
            )
                return;
            const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
            writeFileSync(file, `${existing}${prefix}${entry}\n`, "utf8");
        } catch {}
    };

    // Snapshot the workspace before a run so /revert can undo it (best-effort;
    // never blocks a run on checkpointing). Used by BOTH the /agent-workflow
    // command and the run_agent_workflow tool.
    const writeCheckpoint = (cwd: string, request: string) => {
        try {
            const cp = createCheckpoint(git(cwd), request);
            if (cp) {
                mkdirSync(dirname(checkpointPath(cwd)), { recursive: true });
                writeFileSync(checkpointPath(cwd), JSON.stringify(cp, null, 2));
            }
        } catch {}
    };
    let sessionDir = "";
    // ALL live pipeline sub-agent subprocesses. A Set (not a single ref): the
    // pipeline runs its phases sequentially, but ping mode runs every agent in
    // PARALLEL through the same spawn wrapper — cancellation must kill them all.
    type ChildProc = {
        kill(signal?: string): void;
        once?: (event: string, listener: () => void) => void;
        exitCode?: number | null;
        signalCode?: string | null;
    };
    const liveProcs = new Set<ChildProc>();
    // SIGTERM every live proc, escalating to SIGKILL after 2s if one ignores it
    // (unref'd timers; killing an exited proc is a harmless no-op).
    const killLiveProcs = () => {
        for (const p of liveProcs) {
            try {
                p.kill("SIGTERM");
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
    // The command path's cancellation controller: escape-cancel's kill hook and
    // session teardown abort it so the pipeline stops at the next between-phase
    // check (the tool path composes it with pi's own turn AbortSignal).
    let runAbort: AbortController | null = null;
    // The bridge closures THIS instance installed — teardown compares against
    // them so a stale shutdown never deletes a newer instance's bridges.
    let installedKillHook: (() => boolean) | undefined;
    let installedHasRunning: (() => boolean) | undefined;
    let installedFooterState: (() => WorkflowFooterState) | undefined;

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
            // Assume a repo if the probe itself fails, so a broken `git` can never
            // produce a spurious "not a git repository" warning.
            isGitRepo: (cwd) => {
                try {
                    return isGitRepo(git(cwd));
                } catch {
                    return true;
                }
            },
            // `rev-parse HEAD` throws on a repo with no commits — which IS the case
            // this exists to catch, so the throw must read as "no commits" rather
            // than being swallowed. A broken git therefore also reports false, but
            // the cost is one extra warning, never a blocked run.
            hasCommits: (cwd) => {
                try {
                    return !!git(cwd)(["rev-parse", "HEAD"]).trim();
                } catch {
                    return false;
                }
            },
            // Read-only git for core decisions (see SetupCallbacks.git). Bound to
            // cwd and handed over as-is: the core only ever asks questions with it.
            git: (cwd) => git(cwd),
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

    // The primary session's current model as a "provider/id" string. Prefers the
    // value tracked from model_select (always live), falling back to ctx.model.
    function primaryModelStr(): string {
        if (primaryModel) return primaryModel;
        const m = widgetCtx?.model;
        return (
            (m?.provider && m?.id ? `${m.provider}/${m.id}` : m?.id) ||
            "default"
        );
    }
    function fallbackModel(): string {
        if (WORKER_MODEL) return WORKER_MODEL;
        return primaryModelStr();
    }
    function modelFor(agentKey: string): string {
        return resolveAgentModel(
            agentKey,
            st.agents,
            WORKER_MODEL,
            fallbackModel(),
        );
    }
    // A real team of this name? `st.teams` is a plain object, so a bare
    // truthiness check would accept Object.prototype keys ("constructor",
    // "toString", …) and hand the run a non-array "roster".
    function isTeam(name: string): boolean {
        return (
            !!name &&
            Object.hasOwn(st.teams, name) &&
            Array.isArray(st.teams[name])
        );
    }
    // Members of the active team that actually resolve to a loaded agent .md.
    function activeMembers(): string[] {
        const raw = isTeam(st.activeTeamName) ? st.teams[st.activeTeamName] : [];
        return raw.filter((m) => st.agents.has(m.toLowerCase()));
    }
    // Pick a team, falling back to the first defined team if the name is unknown.
    function activateTeam(name: string) {
        const names = Object.keys(st.teams);
        st.activeTeamName = isTeam(name) ? name : (names[0] ?? "");
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
        phase?: PhaseState,
    ): string[] {
        const def = st.agents.get(agentKey.toLowerCase());
        const model = modelFor(agentKey);
        // The bar's denominator (shown even when idle, before the agent runs):
        // the agent's configured window (env/frontmatter), else pi's model registry
        // (models.json) — so the card shows e.g. /1.0M without a run or .env.
        const contextWindow =
            def?.contextWindow ||
            contextWindowForModel(modelRegistry?.getAll?.(), model);
        return renderRichCard({
            agentKey,
            def: def ? { ...def, contextWindow } : def,
            phases: st.phases,
            colWidth,
            theme,
            model,
            showContext,
            // Bind to this specific phase so parallel instances of one agent each
            // render their own live state (and settle independently).
            phase,
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

        // At bootup show the full roster from all teams; once dispatching, show one
        // card PER PHASE (so parallel instances of the same agent — e.g. two seekers
        // — each get their own card bound to their own phase, instead of collapsing
        // to a single by-name card). Idle cards carry no phase (by-name is fine).
        const members: { key: string; phase?: PhaseState }[] = selecting
            ? st.phases
                  .filter((p) => st.agents.has(p.agent.toLowerCase()))
                  .map((p) => ({ key: p.agent, phase: p }))
            : allRoster.map((k) => ({ key: k }));

        const anyRunning = st.phases.some((p) => p.status === "running");
        const doneCount = st.phases.filter((p) => p.status === "done").length;
        const errCount = st.phases.filter((p) => p.status === "error").length;
        const allSettled =
            selectedCount > 0 &&
            st.phases.every((p) => p.status === "done" || p.status === "error");
        // Badge reflects the determined plan: queued before any run, working
        // while an agent runs, done once every selected agent finished — and
        // flagged failed (not a success check) when any of them errored.
        const [selIcon, selColor, selWord] = anyRunning
            ? ["●", "accent", "working"]
            : allSettled
              ? errCount > 0
                  ? ["✗", "error", `done, ${errCount} failed`]
                  : ["✓", "success", "done"]
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
                renderAgentCard(m.key, colWidth, theme, true, m.phase),
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
    // Set by /agent-workflow-clear: suppresses every repaint until real work
    // (a pipeline run or a dispatch) starts, so the widget stays gone instead of
    // being resurrected by the next message_end / model_select / DISPATCH_UPDATE.
    let clearedWidget = false;

    function updateWidget() {
        if (clearedWidget) return;
        // No interactive surface (print `-p` / JSON mode → hasUI false) means the
        // widget would never paint anyway — bail before scheduling the coalescing
        // timer so headless runs don't churn setTimeout per stream event. setWidget
        // works in both TUI and RPC, so hasUI (not mode==="tui") is the right gate.
        if (!widgetCtx?.hasUI) return;
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

    // The sticky widget is a STATUS LINE by default (<= 6 rows). The old five-card
    // dashboard is ~40 rows -- four times pi's MAX_WIDGET_LINES budget -- and a
    // sticky region that size competes with the renderer for the screen.
    // PI_WORKFLOW_WIDGET=full restores it.
    const WIDGET_STYLE = process.env.PI_WORKFLOW_WIDGET === "full" ? "full" : "compact";

    // Absolute-repaint pulse — the fix for the dashboard's stale rows.
    //
    // pi re-renders only a LIVE REGION (this widget + editor + footer). Everything
    // above is terminal scrollback it does not own, so when a previously drawn live
    // region ends up pushed up instead of overwritten in place, its rows stay on
    // screen. That is the duplicated "# Todos" header, with an OLDER frame number
    // above the current one, and the agent card growing a "running Ns" row a second.
    //
    // Only `fullRender(true)` clears that (it wipes screen AND scrollback), and pi
    // reaches it solely via `clearOnShrink` — i.e. when the composed frame gets
    // SHORTER. A dashboard whose height is stable never shrinks, so upstream emits
    // ZERO absolute clears in a whole session (measured: 0 in 90 frames) and
    // anything stale persists until you restart.
    //
    // So make it shrink on purpose. At most once every PULSE_MS we drop the
    // trailing spacer row; the frame is one row shorter, pi's own clearOnShrink
    // fires, and the screen is repainted absolutely. Verified against an
    // UNMODIFIED pi-tui: 0 clears in 90 frames without the pulse, 2 with it.
    //
    // Timed, not every-N-builds: builds run at WIDGET_MIN_INTERVAL_MS (80ms) plus
    // extra rebuilds on theme/width changes, so a build counter would make the
    // repaint rate depend on how busy the run is. A clock gives the same cadence
    // on an idle dashboard and a noisy one.
    //
    // Requires clearOnShrink to be on (run.sh exports PI_CLEAR_ON_SHRINK=1; pi's
    // own `terminal.clearOnShrink` setting outranks it). Without it the pulse is
    // harmless but does nothing. PI_WORKFLOW_REPAINT_MS=0 disables.
    const PULSE_MS_EXPLICIT = (() => {
        const raw = Number(process.env.PI_WORKFLOW_REPAINT_MS);
        return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    })();
    const pulseState: RepaintPulseState = { last: 0 };

    // Hard safety net: never let the widget grow taller than the screen minus the
    // rows reserved for the editor + footer. A tall team grid or live-log panel
    // would otherwise push the input box and footer off-screen. Clip the overflow
    // with a notice so those always keep their rows.
    //
    // NOTE: deliberately does NOT pad to a stable height. That was tried against
    // this same bug and disproved — pinned to a constant 40 rows, the dumps showed
    // ONE header per frame while the screen still showed two. A stable height is in
    // fact what SUPPRESSES pi's clearOnShrink, which is why the pulse below exists.
    function clampWidget(out: string[], theme: any): string[] {
        const rows = process.stdout.rows || 24;
        // One row of headroom so the pulse frame is always strictly shorter than a
        // normal frame, even when the widget is clipped at full height.
        const max = Math.max(3, rows - LOG_PANEL_RESERVE);
        const cap = Math.max(2, max - 1);
        let lines = out;
        if (lines.length > cap) {
            const kept = lines.slice(0, Math.max(1, cap - 1));
            kept.push(
                theme.fg(
                    "dim",
                    `   … ${lines.length - kept.length} more line(s) — clipped to fit`,
                ),
            );
            lines = kept;
        }
        // Arm the pulse only when the widget is over pi's MAX_WIDGET_LINES budget.
        // Inside the budget the renderer does not strand rows and a periodic
        // full repaint would be pure flicker; past it, the pulse is what clears
        // the rows a displaced live region leaves behind. An explicit
        // PI_WORKFLOW_REPAINT_MS overrides the coupling in both directions.
        const interval = repaintIntervalFor(lines.length, PULSE_MS_EXPLICIT);
        const pulse = shouldRepaint(pulseState, Date.now(), interval);
        // A zero-width space, not "": pi-tui's Text renders ZERO rows for a line
        // whose .trim() is empty, so a plain "" would not occupy a row and the
        // frame would not actually change height.
        return pulse ? lines : lines.concat("\u200b");
    }

    // Live review-checklist progress (Option D): the reviewer is read-only, so it
    // can't tick a ledger — instead it emits a `[review-check] <item>` marker line as
    // it finishes each check, and we scan its streamed output (phase.log, a rolling
    // tail) for them. Sticky: once seen, a mark persists here even after it scrolls
    // out of the capped buffer. Reset between reviewer runs (see buildWidgetLines).
    const reviewMarks = new Set<string>();
    function scanReviewMarkers(text: string) {
        if (!text) return;
        for (const line of text.match(/\[review-check\][^\n]*/gi) || []) {
            const low = line.toLowerCase();
            for (const item of REVIEW_CHECKLIST) {
                if (low.includes(item.toLowerCase())) reviewMarks.add(item);
            }
        }
    }

    // The implementer's phase checklist, read fresh from .agent/progress.md so the
    // dashboard ticks each phase as it's marked done mid-run. Cheap (small file),
    // best-effort. Empty when there's no ledger yet.
    function readProgressItems() {
        try {
            const cwd = widgetCtx?.cwd;
            if (!cwd) return [];
            return parseProgressLedger(
                readFileSync(join(cwd, ".agent", "progress.md"), "utf8"),
            );
        } catch {
            return [];
        }
    }

    // The reviewer's checklist panel ("# Review"), shown whenever a reviewer phase is
    // running or done — in both the full pipeline AND an ad-hoc dispatch of the
    // reviewer. While it runs, items tick live from the `[review-check]` markers
    // scanned out of its stream (best-effort; reconciles to all-checked once the phase
    // finishes). Scanned only while running; the sticky set is reset otherwise so a
    // re-review starts fresh. Returns [] (with no leading blank) when there's nothing
    // to show, so the caller can splice it unconditionally.
    function reviewPanelLines(width: number, theme: any): string[] {
        const reviewerPhase = st.phases.find((p) => p.agent === "reviewer");
        if (reviewerPhase?.status === "running") {
            scanReviewMarkers(reviewerPhase.log || "");
        } else {
            reviewMarks.clear();
        }
        const reviewItems = buildReviewChecklist(st.phases, reviewMarks);
        if (!reviewItems.length) return [];
        return [
            "\u200b",
            ...renderTodos(reviewItems, theme, {
                running: reviewerPhase?.status === "running",
                width,
                title: " # Review",
            }),
        ];
    }

    // Build the dashboard as a plain line array. Returned to pi via the string[]
    // setWidget overload (below) so pi owns the diffing/redraw — re-issuing a
    // custom component each tick made the sticky widget redraw incorrectly
    // (status lines ghosted frame-over-frame).
    // The sticky widget is a STATUS LINE by default (<= 6 rows). The old
    // five-card dashboard is ~40 rows -- four times pi's MAX_WIDGET_LINES budget
    // -- and a sticky region that size competes with the renderer for the screen;
    // every rendering problem this dashboard had came from its size. The detail it
    // showed lives in obs/ui (runs, live agents, analytics, history) and in the
    // transcript, both of which can scroll. PI_WORKFLOW_WIDGET=full restores it.

    // One line of "what is it doing right now", taken from the running phase's
    // streamed tail. Streamed output carries ANSI and control characters -- a
    // stray \r or cursor-move makes the whole terminal jump -- so strip them the
    // same way the live-log panel does before putting the text on a sticky row.
    // How many trailing activity rows the status widget shows. The slash-command
    // path cannot stream into the transcript -- pi exposes only `notify` to a
    // command, which appends a message rather than updating a block -- so on that
    // path this tail is the ONLY live view of a run. 0 shows just the status.
    // Rows the transcript keeps for itself. The widget grows into the space below
    // it, but not all of it -- the conversation above still has to be readable.
    const TRANSCRIPT_MIN_ROWS = 6;

    // The widget's row budget for THIS terminal. Defaults to filling the space
    // below the transcript rather than pi's 10-row budget, because a tall window
    // otherwise leaves most of the screen empty while the tool trail is truncated
    // to five lines. Growing past STATUS_WIDGET_MAX_LINES re-enters the regime
    // where the renderer strands rows, so clampWidget arms the repaint pulse
    // whenever the budget is exceeded -- the two are deliberately coupled.
    function widgetBudget(): number {
        const rows = process.stdout.rows || 24;
        return Math.max(
            STATUS_WIDGET_MAX_LINES,
            rows - LOG_PANEL_RESERVE - TRANSCRIPT_MIN_ROWS,
        );
    }

    // Explicit setting wins; otherwise fill whatever the budget leaves after the
    // header, the running-agent row(s) and the ledger summary.
    function activityLineCount(): number {
        const raw = Number(process.env.PI_WORKFLOW_ACTIVITY_LINES);
        if (Number.isFinite(raw) && raw >= 0) return raw;
        return Math.max(DEFAULT_ACTIVITY_LINES, widgetBudget() - 4);
    }

    function recentActivity(): string[] {
        const live = st.phases.find((p) => p.status === "running");
        const log = live?.log;
        const want = activityLineCount();
        if (!log || want === 0) return [];
        const clean = log
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
            .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
            .replace(/\x1b[@-Z\\-_]/g, "")
            .replace(/\t/g, "  ")
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        const rows = clean
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        return rows.slice(-want);
    }

    function buildCompactLines(width: number, theme: any): string[] {
        const items = readProgressItems();
        const reviewItems = buildReviewChecklist(st.phases, reviewMarks);
        const live = st.phases.find((p) => p.status === "running");
        const tokens = live?.tokens;
        const chDen = (tokens?.cacheRead || 0) + (tokens?.input || 0);
        return renderStatusWidget(
            {
                team: st.activeTeamName,
                phases: st.phases,
                running: st.running,
                lastStatus: st.lastStatus,
                iteration: st.iteration,
                maxLoops: st.maxLoopsRef,
                elapsedMs: st.dispatchMode ? st.dispatchElapsedMs : st.runElapsedMs,
                costUsd: st.totalCostUsd,
                contextPct: live?.contextPct ?? 0,
                contextWindow: tokens?.contextWindow,
                cacheHitPct: chDen > 0 ? ((tokens?.cacheRead || 0) / chDen) * 100 : 0,
                todos: {
                    done: items.filter((i) => i.done).length,
                    total: items.length,
                    items,
                    // One [•] per phase worker actually in flight, so a parallel
                    // wave marks every phase it is on rather than just the first.
                    inProgress: st.phases.filter(
                        (p) => p.agent === "phase-implementer" && p.status === "running",
                    ).length,
                },
                review: {
                    done: reviewItems.filter((i) => i.done).length,
                    total: reviewItems.length,
                    items: reviewItems,
                    // The reviewer ticks items as it scans, so mark the first
                    // unchecked one only while it is actually running -- the same
                    // rule the old "# Review" panel used.
                    active:
                        st.phases.find((p) => p.agent === "reviewer")?.status ===
                        "running",
                },
                activity: recentActivity(),
                dispatchMode: st.dispatchMode,
                agentCount: st.agents.size,
                teamCount: Object.keys(st.teams).length,
                // Every agent across all teams that actually has a loaded .md def,
                // with the model it will run on -- the same resolution the cards
                // used to show (frontmatter -> env/team override -> fallback).
                roster: allTeamAgents(st.teams)
                    .filter((m) => st.agents.has(m.toLowerCase()))
                    .map((m) => {
                        const key = m.toLowerCase();
                        const model = modelFor(key);
                        return {
                            name: displayName(m),
                            model,
                            // Same resolution the cards used: the agent's own
                            // frontmatter wins, else the registry's window for
                            // whatever model it resolved to.
                            contextWindow:
                                st.agents.get(key)?.contextWindow ||
                                contextWindowForModel(modelRegistry?.getAll?.(), model),
                        };
                    }),
                width,
                maxLines: widgetBudget(),
            },
            theme,
        );
    }

    function buildWidgetLines(width: number, theme: any): string[] {
        if (WIDGET_STYLE === "compact") return buildCompactLines(width, theme);
        return buildFullWidgetLines(width, theme);
    }

    function buildFullWidgetLines(width: number, theme: any): string[] {
        if (st.phases.length === 0 || st.dispatchMode) {
            // Idle or ad-hoc dispatch: the team grid (selected cards marked once
            // the orchestrator dispatches), with the running agent's live log below.
            const gridLines = renderAgentGrid(width, theme);
            if (st.dispatchMode) {
                // An ad-hoc dispatch of the reviewer still gets its checklist panel.
                gridLines.push(...reviewPanelLines(width, theme));
                appendLiveLog(gridLines, width, theme);
                return clampWidget(gridLines, theme);
            }
            // The project's LSP servers + install status now live inline in the
            // footer (always visible, including during runs), not as a panel above
            // the grid.
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
        const cards = st.phases.map((p) =>
            renderAgentCard(p.agent, colWidth, theme, true, p),
        );
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
        // The implementer's phases as a live todo list — each ticks [ ] -> [x] as it
        // commits them. Separated by a blank ROW: pi-tui's Text renders nothing for an
        // empty/whitespace line, so a visible gap needs a zero-width space (survives
        // .trim() yet is invisible). Omitted until a ledger exists.
        // Count the phase workers actually in flight: a parallel wave gets one
        // PhaseState per instance, so this is the number of [•] rows the ledger
        // should show. Falls back to 1 between waves.
        const workersRunning = st.phases.filter(
            (p) => p.agent === "phase-implementer" && p.status === "running",
        ).length;
        // While a run is live, claim the block's rows before the ledger exists —
        // the planner writes .agent/progress.md partway through, and letting the
        // block appear then is the height jump that stranded a duplicate header.
        // Once the run ends there is nothing to wait for, so it collapses again.
        const todos = renderTodos(readProgressItems(), theme, {
            running: st.running,
            width,
            inProgress: workersRunning,
            placeholder: st.running ? "waiting for the plan…" : undefined,
            // Under PI_WORKFLOW_DEBUG_WIDGET the header carries the frame number.
            // Two headers on screen then answer, with no log reading, WHICH bug
            // this is: DIFFERENT numbers mean two different frames are visible at
            // once (a stale row the renderer never erased), IDENTICAL numbers mean
            // one frame's content was composed twice. Those need opposite fixes.
            title:
                process.env.PI_WORKFLOW_DEBUG_WIDGET === "1"
                    ? ` # Todos [frame ${widgetGen}]`
                    : undefined,
        });
        if (todos.length) {
            lines.push("\u200b");
            lines.push(...todos);
        }
        // The reviewer's checklist panel (also shown in ad-hoc dispatch above).
        lines.push(...reviewPanelLines(width, theme));
        appendLiveLog(lines, width, theme);
        return clampWidget(lines, theme);
    }

    function renderWidgetNow() {
        if (!widgetCtx || !widgetCtx.hasUI) return; // no chrome without a UI
        // Use the component (factory) overload, not the string[] one: pi hard-caps
        // string[] widgets at MAX_WIDGET_LINES (10) with "(widget truncated)", which
        // would cut the live-log panel. Build the same per-line Container pi uses
        // internally for string[] (so it redraws cleanly in place — no ghosting),
        // but without the 10-line cap. Our own clampWidget already bounds the height
        // to the screen, so this can't push the editor/footer off.
        //
        // Build the lines INSIDE the factory using the theme (and width) pi passes
        // in on each (re)render — like the footer — so the cards restyle on /theme
        // and reflow on resize. Reserve 2 columns: pi wraps each line in
        // Text(line, 1, 0) (a +1 left pad), so building to columns-2 keeps the
        // widest row + pad from wrapping and shattering the card borders.
        widgetGen++; // a state change → rebuild on the next factory call
        widgetCtx.ui.setWidget("agent-workflow", (_tui: any, theme?: any) => {
            const t = theme || widgetCtx.ui.theme;
            // columns-4, not columns-2. pi wraps each line in Text(line, 1, 0),
            // which adds a 1-column margin on BOTH sides, so columns-2 fits
            // exactly and leaves nothing spare. A single line one column over
            // wraps to a second physical row while pi counts one -- and every row
            // below it is then drawn one place off, permanently. Two spare
            // columns cost nothing visible across five cards and remove that
            // whole failure mode.
            const width = Math.max(20, (process.stdout.columns || 80) - 4);
            // Rebuild only when state, theme, or width changed; reuse the
            // cached lines on plain redraws so we don't re-read disk per frame.
            if (
                widgetMemo.gen !== widgetGen ||
                widgetMemo.theme !== t ||
                widgetMemo.width !== width
            ) {
                widgetMemo.gen = widgetGen;
                widgetMemo.theme = t;
                widgetMemo.width = width;
                widgetMemo.lines = buildWidgetLines(width, t);
                // PI_WORKFLOW_DEBUG_WIDGET=1 dumps the array we hand pi, ANSI
                // stripped, one row per line. Ground truth for "is a duplicated
                // row ours or the renderer's?" — if the dump has one "# Todos"
                // and the screen shows two, the strand is below us and no amount
                // of widget-side work will fix it.
                if (process.env.PI_WORKFLOW_DEBUG_WIDGET === "1") {
                    try {
                        const dump = widgetMemo.lines
                            .map(
                                (l, i) =>
                                    `${String(i).padStart(3)}| ${l.replace(/\x1b\[[0-9;]*m/g, "").replace(/​/g, "<ZWSP>")}`,
                            )
                            .join("\n");
                        appendFileSync(
                            join(homedir(), ".pi", "agent", "pi-widget.log"),
                            `\n=== ${new Date().toISOString()} rows=${widgetMemo.lines.length} cols=${width} ===\n${dump}\n`,
                        );
                    } catch {}
                }
            }
            const container = new Container();
            for (const line of widgetMemo.lines)
                container.addChild(new Text(line, 1, 0));
            return container;
        });
    }

    // ── Run a single agent as a subprocess ───────

    // Thin wrapper around the shared spawnAgentWithModel from workflow-core.
    // Accumulates token/tool/dropped-line totals into the module counters after
    // each spawn. Every agent runs in its own session. Shared with dispatch.ts.
    const spawnAgentWithModel = makeExtensionSpawnWrapper({
        state: st,
        sessionDir: () => sessionDir,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        agentStallMs: AGENT_STALL_MS,
        updateWidget: () => updateWidget(),
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
        // Per-agent model — same resolution the dashboard cards show
        // (frontmatter → env/team override → global fallback).
        const agentKey = agentDef.name.toLowerCase();
        const agentModel = modelFor(agentKey);
        // Fallback: the model the current pi session is running on (the primary
        // agent's model). If an agent's configured model fails to load, we retry
        // with the session model since it's known to work — pi itself is using it.
        const sm = widgetCtx?.model;
        const sessionModel =
            sm?.provider && sm?.id ? `${sm.provider}/${sm.id}` : sm?.id || "";
        const modelFallback =
            sessionModel && sessionModel !== agentModel ? sessionModel : "";

        // Delegate to shared core (eliminates ~50 lines of near-identical
        // fallback logic with notification API drift).
        return runAgentWithFallback(
            agentDef,
            task,
            phase,
            cwd,
            agentModel,
            modelFallback,
            spawnAgentWithModel,
            {
                updateWidget,
                notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
                // The composed turn/escape-cancel signal — stops in-place
                // transient/fallback retries once the run is cancelled.
                isAborted: () => host.signal?.aborted === true,
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

    // CLI flags — surface the most common env knobs at launch: `--max-loops N`
    // and `--confine-cwd`.
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

    // A startup `--confine-cwd` flag is equivalent to PI_CONFINE_CWD=1; set the env
    // early so subagentExtArgs picks it up when spawning sub-agents.
    if (pi.getFlag?.("confine-cwd")) process.env.PI_CONFINE_CWD = "1";

    // `--max-loops N` sets the default retry limit (inline `loops=N` still wins).
    const flagMaxLoops = parseInt(String(pi.getFlag?.("max-loops") ?? ""), 10);
    const defaultMaxLoops = flagMaxLoops > 0 ? flagMaxLoops : DEFAULT_MAX_LOOPS;

    pi.registerCommand("agent-workflow", {
        description:
            "Run a workflow: '/agent-workflow <request>' to pick a team then run; name a team first to skip the picker (e.g. '/agent-workflow spec <request>')",
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
            // The first token may name a team (e.g. `/agent-workflow spec
            // <request>`); otherwise show the Select Team picker. The chosen
            // team's roster IS the pipeline — the team is the only "mode".
            const firstTok = rawArgs.split(/\s+/)[0] || "";
            const namedTeam = isTeam(firstTok) ? firstTok : "";

            // A team is selected per job: naming a team selects it, otherwise
            // the picker does. The team is deactivated once the job finishes
            // (below), so each run starts from a clean "no team" state.
            let request: string;
            const inferredTeam = namedTeam
                ? ""
                : inferWorkflowTeam(rawArgs, st.teams);
            if (namedTeam) {
                activateTeam(namedTeam);
                request = rawArgs.slice(firstTok.length).trim();
            } else if (inferredTeam) {
                // "build/implement the (implementation) plan" → the build team,
                // no picker: it resumes from the saved .agent/plan.md.
                activateTeam(inferredTeam);
                request = rawArgs;
            } else {
                const picked = await chooseTeam(ctx);
                if (picked === null) return; // user cancelled the picker
                // A run may have started (tool path) while the picker was
                // open — bail rather than clobber the live run's team.
                if (st.running) {
                    ctx.ui.notify("A workflow is already running.", "warning");
                    return;
                }
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
                if (!typed || !typed.trim()) {
                    // Cancelled: drop the just-activated team so the idle
                    // dashboard returns to its clean no-team state (mirrors
                    // the post-run deactivation below). Never while another
                    // run is live — that team is its, not ours.
                    if (!st.running) {
                        st.activeTeamName = "";
                        updateWidget();
                    }
                    return;
                }
                finalRequest = typed.trim();
                // Re-check after the prompt: a run started meanwhile owns the
                // team, the widget and host.signal — don't start a second one.
                if (st.running) {
                    ctx.ui.notify("A workflow is already running.", "warning");
                    return;
                }
            }

            pi.setSessionName?.(
                sessionLabel(
                    "agent-workflow",
                    st.activeTeamName,
                    finalRequest,
                ),
            );
            // Snapshot the workspace before the run so /revert can undo it
            // (the run_agent_workflow tool path does the same).
            writeCheckpoint(ctx.cwd, finalRequest);
            // Command runs get no turn AbortSignal from pi — wire our own so
            // escape-cancel (via __piKillWorkflowProc) also stops the
            // pipeline between phases and the run reports "aborted" instead
            // of a phase error.
            const controller = new AbortController();
            runAbort = controller;
            const runSignal = controller.signal;
            host.signal = runSignal;
            clearedWidget = false; // a run repaints the dashboard
            try {
                await runFullWorkflowCommand(
                    st,
                    host,
                    finalRequest,
                    ctx,
                    publishReport,
                    maxLoops,
                );
            } finally {
                // Identity-guarded like runAbort: if the core refused this
                // start (re-entry guard) the LIVE run's signal is installed —
                // clearing it would disarm its escape-cancel.
                if (host.signal === runSignal) host.signal = undefined;
                if (runAbort === controller) runAbort = null;
            }
            // Another run is still live (ours was refused): its status/team are
            // not ours to report or reset.
            if (st.running) return;
            // OS-level ping: agent_end (which pings for tool runs) only
            // wraps agent turns, so command runs never reach it.
            emitNotification(
                `pi: workflow ${st.lastStatus} (${secs(st.runElapsedMs)})`,
            );
            // Deactivate the team after the job so the next run re-selects and
            // the orchestrator is unscoped again when idle.
            st.activeTeamName = "";
            updateWidget();
        },
    });

    pi.registerCommand("agent-workflow-clear", {
        description: "Clear the agent-workflow progress widget",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            cancelPendingWidget();
            ctx.ui.setWidget("agent-workflow", undefined);
            // Stay cleared: message_end / model_select / DISPATCH_UPDATE all
            // call updateWidget(), which would re-install the widget within a
            // frame. Reset when a run or a dispatch actually starts.
            clearedWidget = true;
            ctx.ui.notify("Workflow-team widget cleared.", "info");
        },
    });

    // ── /agent-model — change a sub-agent's model on the fly (this session) ──
    // Overrides are in memory only: they apply to every subsequent dispatch/run of
    // that agent and reset when pi restarts. The dashboard cards re-render with the
    // new model immediately.
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
            return opts.map((id) => ({
                value: `${first} ${id}`,
                label: id,
            }));
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

    // /revert lives in its own extension (extensions/revert.ts) — it reads the
    // checkpoint this run persists to .agent/checkpoints/latest.json, so it needs
    // none of the orchestrator's in-memory state.

    // ── Tool — let the primary agent invoke the workflow ──

    pi.registerTool({
        name: "run_agent_workflow",
        label: "Run Workflow (Team)",
        description:
            "Run the plan -> refine -> implement -> review -> validate -> ship lifecycle on a request (bug fix, new feature, or new app). The validator gates the result: it loops back to the implementer on FAIL, pauses if there is no GitHub remote, and opens a PR on PASS. Use this for any non-trivial change; do simple lookups yourself. Pass `team` when the user names one (e.g. 'use the plan-build team'); omit it to auto-select from the request — the full pipeline by default, or the `build` team when the request asks to implement an existing plan. When the user asks to build or implement an existing plan ('build the plan', 'implement the plan/spec', or when .agent/plan.md already exists), pass team='build' — it skips planning, keeps the saved .agent/plan.md, and resumes the implementer from the first unfinished phase.",
        parameters: Type.Object({
            request: Type.String({
                description: "The bug, feature, or app to deliver",
            }),
            team: Type.Optional(
                Type.String({
                    description:
                        "Optional team name from teams.yaml whose roster defines which pipeline phases run (e.g. when the user says 'use the X team'). Omit to auto-select from the request: the full pipeline by default, or the `build` team when the request asks to implement an existing plan.",
                }),
            ),
            max_loops: Type.Optional(
                Type.Number({
                    description: `Max implement/validate retries (default ${DEFAULT_MAX_LOOPS})`,
                }),
            ),
        }),
        // pi executes a tool batch in PARALLEL by default; a pipeline run must not
        // overlap another run or a dispatch in the same batch (they share the
        // dashboard state and the staged-learnings file). One sequential tool in a
        // batch serializes the whole batch, which is exactly the guarantee the
        // st.running / core re-entry guards assume.
        executionMode: "sequential",
        async execute(_id, params, signal, onUpdate, ctx) {
            const { request, max_loops, team } = params as {
                request: string;
                max_loops?: number;
                team?: string;
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
            st.teams = loadTeams(ctx.cwd);
            // Scope the run to a named team when the caller passed one; its
            // roster IS the pipeline. An unknown name is an error (don't silently
            // run the full pipeline — that hides the mistake). Omitted => no team,
            // and runWorkflowCore falls back to the full roster.
            if (team) {
                if (!isTeam(team)) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Unknown team "${team}". Available teams: ${Object.keys(st.teams).join(", ") || "(none defined)"}. Omit team to auto-select (full pipeline, or the build team for an "implement the plan" request).`,
                            },
                        ],
                        details: undefined,
                    };
                }
                st.activeTeamName = team;
            } else {
                // No explicit team: infer "build/implement the plan" intent from
                // the request (→ build team); otherwise "" runs the full pipeline.
                st.activeTeamName = inferWorkflowTeam(request, st.teams);
            }
            widgetCtx = ctx;
            st.pipelineRanThisTurn = true; // fold the primary's turn time into the total

            // Snapshot the workspace before the run so /revert can undo it.
            writeCheckpoint(ctx.cwd, request);

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
            const onAbort = () => bridges.__piKillWorkflowProc?.();
            signal?.addEventListener?.("abort", onAbort);
            // Pass the abort signal to the orchestrator so it stops between
            // phases — composed with our own controller so escape-cancel
            // (which calls __piKillWorkflowProc without aborting the turn)
            // also stops the pipeline, not just the live subprocess.
            const controller = new AbortController();
            runAbort = controller;
            const runSignal = signal
                ? AbortSignal.any([signal, controller.signal])
                : controller.signal;
            host.signal = runSignal;
            clearedWidget = false; // a run repaints the dashboard
            pi.setSessionName?.(
                sessionLabel("agent-workflow", st.activeTeamName, request),
            );
            // Stream the pipeline's tool trail into the transcript. The sticky
            // widget is a status line now, so without this a run is invisible
            // between "Running workflow" and the final result.
            const stopStream = streamWorkflowActivity(
                () =>
                    st.phases
                        .filter((p) => p.status === "running")
                        .map((p) => ({ label: p.label, log: p.log || "" })),
                onUpdate,
            );
            const result = await runWorkflowCore(
                st,
                host,
                request,
                max_loops && max_loops > 0 ? max_loops : defaultMaxLoops,
                ctx,
            ).finally(() => {
                stopStream();
                signal?.removeEventListener?.("abort", onAbort);
                // Identity-guarded like runAbort: if the core refused this start
                // (re-entry guard), host.signal belongs to the LIVE run and
                // clearing it would disarm its cancellation.
                if (host.signal === runSignal) host.signal = undefined;
                if (runAbort === controller) runAbort = null;
            });
            // Deactivate the team after the job (no-op if none was active) —
            // unless another run is still live and owns it.
            if (!st.running) {
                st.activeTeamName = "";
                updateWidget();
            }
            const truncated =
                result.report.length > WORKFLOW_TOOL_REPORT_MAX
                    ? result.report.slice(0, WORKFLOW_TOOL_REPORT_MAX) +
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
    // we mirror the dispatch phase snapshot the dispatch extension broadcasts on
    // pi.events into our dashboard grid and re-render.
    //
    // Only while NO pipeline is running: pi executes a tool batch in parallel by
    // default, so a dispatch can overlap a pipeline run — and this mirror
    // replaces st.phases/st.dispatchMode wholesale, which would wipe the live
    // pipeline dashboard on every stream event of the dispatched agent. The
    // dispatch extension owns its own state; dropping the frame only costs the
    // dashboard mirror, nothing functional.
    //
    // The unsubscribe is kept and called in session_shutdown: pi's event bus is
    // process-lived across /reload, so discarding it leaks one stale listener per
    // reload, each mutating a dead instance's state and redrawing on a dead ctx.
    const offDispatchUpdate = pi.events.on(DISPATCH_UPDATE, (data) => {
        if (st.running) return;
        const u = data as DispatchUpdate;
        clearedWidget = false; // a dispatch is real work — repaint
        st.phases = u.phases;
        st.dispatchMode = u.dispatchMode;
        st.dispatchElapsedMs = u.dispatchElapsedMs;
        // Restores the dispatch-done ping + turn-time fold in agent_end: since
        // the dispatch tools moved to extensions/dispatch.ts, only its state ever
        // sets this flag — mirror it so our per-turn hooks still see it.
        st.dispatchedThisTurn = u.dispatchedThisTurn ?? st.dispatchedThisTurn;
        updateWidget();
    });

    // ── Cancellation hook (integrates with escape-cancel if present) ──

    // ── Primary-session cost ──
    // Accumulate the orchestrator's own spend from each assistant message's
    // usage.cost (priced by the provider). Sub-agents run in separate processes,
    // so their messages never fire this on the primary session — no double count.
    pi.on("message_end", async (event: any) => {
        const msg = event?.message;
        const u = msg?.usage;
        if (msg?.role !== "assistant" || !u) return;
        const total = u.cost?.total;
        if (typeof total === "number" && total > 0) primaryCostUsd += total;
        // Cache/input token tallies for the footer's hit rate (cached input as
        // a share of all input). Accumulated on every assistant message.
        primaryCacheRead += u.cacheRead ?? 0;
        primaryInputTokens += u.input ?? 0;
        // Repaint the dashboard; the footer reads these live, so it refreshes
        // on the same redraw.
        updateWidget();
    });

    // ── Primary-turn timing ──
    // The orchestrator's turn wraps both its own reasoning and the sub-agent work
    // it triggers, so timing it gives the total INCLUDING the primary agent's time.
    // At turn end we fold that into the dispatch / pipeline totals.
    pi.on("agent_start", async () => {
        st.primaryTurnStartedAt = Date.now();
        st.pipelineRanThisTurn = false;
        st.dispatchedThisTurn = false;
        st.dispatchesThisTurn = 0;
    });
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
            // and often unattended. Trivial reply-only turns are skipped. A
            // cancelled/failed run also pings (intended): `st.lastStatus` carries
            // the outcome, so the notification is still informative.
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
            .map(
                (def) =>
                    `- \`${def.name}\` — ${terse(def.description, 110)}`,
            )
            .join("\n");

        const teamMembers = dispatchableDefs
            .map((d) => displayName(d.name))
            .join(", ");

        // Skills the orchestrator can use directly (files-only: any SKILL.md).
        const skills = loadSkills(_ctx.cwd);
        const skillCatalog = skills.length
            ? skills
                  .map(
                      (s) =>
                          `- **${s.name}** — ${terse(s.description, 140)}`,
                  )
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

    // Track the primary session's model so sub-agents that fall back to it (and
    // the footer) follow /model changes live, not just the session-start model.
    pi.on("model_select", async (event: any) => {
        const m = event?.model;
        if (m)
            primaryModel = m.provider && m.id ? `${m.provider}/${m.id}` : m.id;
        updateWidget();
    });

    pi.on("session_start", async (_event, ctx) => {
        widgetCtx = ctx;
        modelRegistry = (ctx as any).modelRegistry;
        const sm = ctx.model;
        primaryModel = sm
            ? sm.provider && sm.id
                ? `${sm.provider}/${sm.id}`
                : sm.id
            : undefined;
        // /agent-model overrides are session-scoped: drop any carried over by the
        // process-global store so they clear on a fresh start and on /reload (which
        // re-fires session_start), while still persisting across turns within a
        // session. Restart clears them too (new process).
        clearAllModelOverrides();
        primaryCostUsd = 0; // fresh per-session spend tally
        primaryCacheRead = 0;
        primaryInputTokens = 0;
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

        // Show the idle team dashboard (grid of agents + their models). A fresh
        // session starts visible even if the previous one ran /agent-workflow-clear.
        clearedWidget = false;
        updateWidget();
        // Cross-extension bridges via globalThis (also WORKFLOW_FOOTER_GLOBAL below).
        // These are single global slots, so they assume ONE pi session per process
        // (pi's model) — two sessions sharing a process would collide on them.
        installedKillHook = (): boolean => {
            // Kill every live agent subprocess so a cancelled workflow doesn't
            // keep running detached — the pipeline is sequential, but ping mode
            // runs all agents in parallel, so there can be several. (Parallel
            // dispatch procs are owned and killed by extensions/dispatch.ts.)
            // Also stop the pipeline at its next between-phase abort check —
            // the kills only take down the currently-running subprocesses.
            runAbort?.abort();
            runAbort = null;
            killLiveProcs();
            st.running = false;
            return true;
        };
        bridges.__piKillWorkflowProc = installedKillHook;
        installedHasRunning = () => st.running;
        bridges.__piHasRunningWorkflow = installedHasRunning;
        const present = REQUIRED_AGENTS.filter((a) => st.agents.has(a));
        const missing = REQUIRED_AGENTS.filter((a) => !st.agents.has(a));
        ctx.ui.setStatus(
            "agent-workflow",
            `Workflow Team: ${present.length}/${REQUIRED_AGENTS.length} agents`,
        );

        if (ctx.hasUI && loadedExplicitly()) {
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
                    `Workflow Teams:\n${teamsBlock()}\n\n` +
                        `/agent-workflow [request]   Pick a team (Select Team), then run the lifecycle\n` +
                        `/agent-workflow-clear       Clear the progress widget\n\n` +
                        `run_agent_workflow          Tool — the agent can launch the workflow for non-trivial tasks\n` +
                        `dispatch_agent              Tool — dispatch task(s) to any loaded agent(s) outside the pipeline`,
                    "info",
                );
                // The per-agent model list is already visible on the dashboard cards
                // and in the footer, so we don't repeat it as a startup notification.
            }
        }

        // Footer: the status line (workflow status + the PRIMARY/orchestrator model
        // and its context usage) is rendered by the standalone extensions/footer.ts.
        // We only publish the live orchestration state for it to read; the getter
        // closes over `st` (mutated in place), `primaryCostUsd` (a live let), and
        // primaryModelStr()/ctx, so it always returns fresh values per frame. Bridged
        // via globalThis so the footer can be its own `pi -e` extension.
        installedFooterState =
            (): WorkflowFooterState => ({
                model: primaryModelStr(),
                running: st.running,
                lastStatus: st.lastStatus,
                iteration: st.iteration,
                maxLoopsRef: st.maxLoopsRef,
                dispatchMode: st.dispatchMode,
                phases: st.phases,
                dispatchElapsedMs: st.dispatchElapsedMs,
                runElapsedMs: st.runElapsedMs,
                primaryCostUsd,
                cacheHitPct:
                    primaryCacheRead + primaryInputTokens > 0
                        ? (primaryCacheRead /
                              (primaryCacheRead + primaryInputTokens)) *
                          100
                        : undefined,
                contextUsage: () => ctx.getContextUsage?.(),
            });
        bridges[WORKFLOW_FOOTER_GLOBAL] = installedFooterState;
    });

    // ── Teardown ───────────────────────────────────
    // pi fires session_shutdown on /new, /resume, /fork, /reload, and quit, then
    // rebinds a fresh extension instance. Without this, a /reload mid-run would
    // leave a sub-agent subprocess running detached, a trailing widget timer could
    // fire into a dead instance, and the globalThis bridges would keep pointing at
    // this (now-stale) instance's closures. Idempotent: safe to run more than once,
    // and it only deletes the global slots if they are still the ones we installed.
    pi.on("session_shutdown", async () => {
        // Cancel any pending coalesced widget render.
        cancelPendingWidget();
        // Drop the DISPATCH_UPDATE subscription — the event bus outlives this
        // instance (/reload rebinds a fresh one), so leaving it attached leaks a
        // listener per reload that mutates this dead instance's state.
        try {
            offDispatchUpdate?.();
        } catch {}
        // Stop a command-path pipeline at its next between-phase check.
        runAbort?.abort();
        runAbort = null;
        // Kill the pipeline's live sub-agent subprocesses so none outlive the
        // session (SIGTERM → SIGKILL escalation inside killLiveProcs). Parallel-
        // dispatch procs are owned and torn down by extensions/dispatch.ts.
        killLiveProcs();
        st.running = false;
        // Release the cross-extension globalThis bridges we own, but only if
        // they are still ours — identity-checked so a stale shutdown can't
        // delete a newer instance's bridges if teardown ever interleaves with
        // the rebind.
        if (bridges.__piKillWorkflowProc === installedKillHook)
            delete bridges.__piKillWorkflowProc;
        if (bridges.__piHasRunningWorkflow === installedHasRunning)
            delete bridges.__piHasRunningWorkflow;
        if (bridges[WORKFLOW_FOOTER_GLOBAL] === installedFooterState)
            delete bridges[WORKFLOW_FOOTER_GLOBAL];
    });
}
