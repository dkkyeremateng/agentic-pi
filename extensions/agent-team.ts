// ABOUTME: Team-model variant of the workflow orchestrator — identical pipeline to agent-pipeline.ts but allows
// ABOUTME: configuring the model per agent via env vars (PI_AGENT_PLANNER_MODEL, PI_AGENT_IMPLEMENTER_MODEL, …)
// ABOUTME: or a global fallback (PI_WORKFLOW_MODEL). Every other aspect of the pipeline is unchanged.
/**
 * Workflow Team — plan / implement / test / validate / document / ship orchestrator
 *
 * Runs the five agents defined in .pi/agents/*.md (the validator twice — to
 * validate, then to ship):
 *   planner -> implementer -> tester -> validator(gate) -> documenter -> validator(ship)
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
import { spawn } from "child_process";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
    type Verdict,
    type CritiqueVerdict,
    detectVerdict,
    detectShip,
    detectCritique,
    secs,
    digest,
    testSignal,
    outcomeLine,
} from "../utils/workflow-utils";
import {
    REQUIRED_AGENTS,
    DEFAULT_MAX_LOOPS,
    LOG_PANEL_RESERVE,
    LOG_CAP_CHARS,
    STDERR_TAIL_CAP,
    WORKFLOW_REPORT_TYPE,
    WORKFLOW_REPORT_MAX,
    WORKFLOW_LOG_TYPE,
    setupSessions as setupSessionsCore,
    publishReport as publishReportCore,
    publishLogs as publishLogsCore,
    contextBundleForPhase,
    type RunArtifacts,
    buildPhaseMap,
    failPhase,
    tokenNote,
    mkPhase as mkPhaseCore,
    freshPhases as freshPhasesCore,
    runPhaseCore,
    runAgentWithFallback,
    renderDispatchAgentCall,
    renderDispatchAgentResult,
    renderRunWorkflowCall,
    renderRunWorkflowResult,
    renderSelectAgentsCall,
    renderSelectAgentsResult,
    type AgentDef,
    type PhaseState,
    loadDotEnv,
    displayName,
    statusMeta,
    statusBadge,
    agentPhaseStatus,
    renderCard,
    teamsBlock as teamsBlockCore,
    chooseTeam as chooseTeamCore,
    loadedExplicitly as loadedExplicitlyCore,
    isActiveWorkflow as isActiveWorkflowCore,
    loadAgents as loadAgentsCore,
    loadTeams as loadTeamsCore,
    loadPromptTemplate,
    renderTemplate,
    teamIsSpec,
    validatePlan,
    scoutTask,
    planTask,
    implementTask,
    fixTask,
    testTask,
    documentTask,
    validateTask,
    shipTask,
    criticTask,
    revisePlanTask,
    specPlanTask,
    specReviseTask,
    specCriticTask,
    specDocumentTask,
    spawnAgentWithModel as coreSpawnAgent,
    type SpawnConfig,
} from "../utils/workflow-core";

// Run before any process.env reads below (WORKER_MODEL, loadAgentModels, …).
loadDotEnv(process.cwd());

let isSpecMode = false; // true during spec-only runs; hides impl/test/validate/ship phases

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
// Per-agent model can be set two ways (env wins over the file):
//   1. Env vars: PI_AGENT_PLANNER_MODEL, PI_AGENT_IMPLEMENTER_MODEL,
//      PI_AGENT_TESTER_MODEL, PI_AGENT_VALIDATOR_MODEL, PI_AGENT_DOCUMENTER_MODEL
//   2. A `.pi/agents/models.yaml` file (handy when pi is launched from an IDE
//      or GUI that doesn't inherit your shell env). Flat `agent: model` lines,
//      plus an optional `default:` for all unset agents. Example:
//        planner: anthropic/claude-opus-4-8
//        documenter: openrouter/google/gemini-3-flash
//        default: anthropic/claude-haiku-4-5
// PI_WORKFLOW_MODEL is the global env fallback for any agent left unset.
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

type AgentName =
    | "scout"
    | "planner"
    | "critic"
    | "implementer"
    | "tester"
    | "validator"
    | "documenter";
// Exactly the known agents — no loose string index, so typos and unknown keys
// are caught. Look up arbitrary agent names via `agentModels[k as AgentName]`.
type AgentModelConfig = Record<AgentName, string>;

// Parse `.pi/agents/models.yaml` — flat `agent: model` key/value lines.
function loadModelOverrides(cwd: string): Record<string, string> {
    const path = join(cwd, ".pi", "agents", "models.yaml");
    if (!existsSync(path)) return {};
    const out: Record<string, string> = {};
    try {
        for (const line of readFileSync(path, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const m = trimmed.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/);
            if (m)
                out[m[1].toLowerCase()] = m[2]
                    .trim()
                    .replace(/^["']|["']$/g, "");
        }
    } catch {}
    return out;
}

// Resolve each agent's model. Precedence: per-agent env var → models.yaml entry
// → PI_WORKFLOW_MODEL → models.yaml `default:` → inherit pi's default ("").
// `cwd` enables the file source; omit it (module-load time) for env-only.
function loadAgentModels(cwd?: string): AgentModelConfig {
    const file = cwd ? loadModelOverrides(cwd) : {};
    const fallback = WORKER_MODEL || file.default || "";
    const pick = (agent: string, envVar: string) =>
        process.env[envVar] || file[agent] || fallback;
    return {
        scout: pick("scout", "PI_AGENT_SCOUT_MODEL"),
        planner: pick("planner", "PI_AGENT_PLANNER_MODEL"),
        critic: pick("critic", "PI_AGENT_CRITIC_MODEL"),
        implementer: pick("implementer", "PI_AGENT_IMPLEMENTER_MODEL"),
        tester: pick("tester", "PI_AGENT_TESTER_MODEL"),
        validator: pick("validator", "PI_AGENT_VALIDATOR_MODEL"),
        documenter: pick("documenter", "PI_AGENT_DOCUMENTER_MODEL"),
    };
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let agents: Map<string, AgentDef> = new Map();
    let agentModels: AgentModelConfig = loadAgentModels();
    let teams: Record<string, string[]> = {};
    let activeTeamName = "";
    let widgetCtx: any;
    let sessionDir = "";
    let phases: PhaseState[] = [];
    let iteration = 0;
    let maxLoopsRef = DEFAULT_MAX_LOOPS;
    let lastStatus = "idle";
    let running = false;
    let currentProc: any = null;
    let abortController: AbortController | null = null;
    let phaseLogs: { label: string; log: string }[] = []; // collected per run, posted as one card at the end
    let totalDroppedLines = 0; // count of JSON lines dropped during this run (diagnostic signal)
    let totalToolCalls = 0; // cumulative tool calls across all phases this run (incl. retries)
    let totalTokens = { input: 0, output: 0 }; // cumulative token usage across all phases
    let runStartedAt = 0; // wall-clock start of the current run
    let runElapsedMs = 0; // total wall-clock of the last completed run (frozen at completion)
    let includeScout = false; // prepend a read-only Scout recon phase (team has `scout`)
    let dispatchMode = false; // true while the primary agent drives ad-hoc dispatches:
    // the full team grid stays on screen and the cards selected for work are marked,
    // instead of collapsing to the linear pipeline view.
    let freshDispatchSession = false; // set on each new user request; the next
    // select_agents / dispatch_agent rebuilds the cards from scratch (drops the
    // previous workflow's cards, resets reused agents to queued) so a new workflow
    // never shows stale state from the last one.
    let dispatchStartedAt = 0; // wall-clock start of the current dispatch session
    let dispatchElapsedMs = 0; // total wall-clock of the dispatch session so far
    let primaryTurnStartedAt = 0; // wall-clock start of the primary agent's turn
    let pipelineRanThisTurn = false; // run_agent_team fired during this turn
    let dispatchedThisTurn = false; // dispatch_agent fired during this turn
    let dispatchesThisTurn = 0;

    // The only tools the primary agent (orchestrator) may use. It has NO direct
    // codebase tools — it must delegate. This lockdown is re-asserted before every
    // agent turn (see before_agent_start); applying it once at session start is not
    // enough, because the restriction is dropped between turns and the orchestrator
    // would then regain codebase tools and start doing the work itself.
    const ORCHESTRATOR_TOOLS = [
        "select_agents",
        "dispatch_agent",
        "run_agent_team",
    ];

    // Delegate to shared core implementations (extracted to eliminate ~60 lines
    // of pure duplication across extensions and runtime).
    const mkPhase = (label: string, agent: string): PhaseState =>
        mkPhaseCore(label, agent);
    const freshPhases = (): PhaseState[] =>
        freshPhasesCore(includeScout, isSpecMode);

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
        return (
            agentModels[agentKey.toLowerCase() as AgentName] || fallbackModel()
        );
    }
    // Members of the active team that actually resolve to a loaded agent .md.
    function activeMembers(): string[] {
        const raw = teams[activeTeamName] || [];
        return raw.filter((m) => agents.has(m.toLowerCase()));
    }
    // Pick a team, falling back to the first defined team if the name is unknown.
    function activateTeam(name: string) {
        const names = Object.keys(teams);
        activeTeamName = teams[name] ? name : (names[0] ?? "");
    }
    const teamsBlock = () => teamsBlockCore(teams, agents, activeTeamName);
    const chooseTeam = (ctx: any) => chooseTeamCore(ctx, teams);
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

        const def = agents.get(agentKey.toLowerCase());
        const { status, elapsed, toolCount } = agentPhaseStatus(
            phases,
            agentKey,
        );

        // "Selected" = the primary agent has chosen this agent for the current
        // work (it has a phase — either declared up front via select_agents or
        // dispatched). A selected agent that hasn't run yet is "queued"; selected
        // cards get a status-colored border and a ▸ marker so the chosen agents
        // stand out from the idle roster.
        const selected = phases.some((p) => p.agent === agentKey.toLowerCase());
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
        const own = phases.filter((p) => p.agent === agentKey.toLowerCase());
        const livePhase =
            own.find((p) => p.status === "running") ?? own[own.length - 1];

        // Context-usage bar, shown on every card (empty `[-----] 0%` until run).
        const ctxPct = livePhase?.contextPct ?? 0;
        const ctxFilled = Math.max(0, Math.min(5, Math.ceil(ctxPct / 20)));
        const ctxBar = "#".repeat(ctxFilled) + "-".repeat(5 - ctxFilled);
        const ctxRaw = `[${ctxBar}] ${ctxPct}%`;
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

    // The idle dashboard: a 2-column grid of the active team's agents, each
    // card showing the model it will run. Mirrors the agent-team layout.
    function renderAgentGrid(width: number, theme: any): string[] {
        const roster = activeMembers();
        const teamNames = Object.keys(teams);

        // Agents the primary agent has selected/dispatched this session, resolved
        // from the phases (in selection order). Includes agents that are NOT part of
        // the active team — e.g. an ad-hoc dispatch to a research agent.
        const selectedKeys = phases
            .map((p) => p.agent)
            .filter((k) => agents.has(k.toLowerCase()));
        const selectedCount = selectedKeys.length;
        const selecting = dispatchMode && selectedCount > 0;

        // Off-team: at least one dispatched agent is not a member of the active
        // team. The team roster/info is then irrelevant, so we hide it (header and
        // the team cards) and show only the dispatched agents.
        const offTeam =
            selecting &&
            selectedKeys.some(
                (k) => !roster.some((m) => m.toLowerCase() === k.toLowerCase()),
            );

        // At bootup show the full team roster; once dispatching, show only the
        // dispatched agents (team members or not).
        const members = selecting ? selectedKeys : roster;

        const anyRunning = phases.some((p) => p.status === "running");
        const doneCount = phases.filter((p) => p.status === "done").length;
        const allDone =
            selectedCount > 0 &&
            phases.every((p) => p.status === "done" || p.status === "error");
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
            // Ad-hoc dispatch outside the workflow team — no team name/count/mode.
            header =
                " " +
                theme.fg("accent", theme.bold("agent-team")) +
                theme.fg("dim", "  ·  ") +
                theme.fg("dim", "ad-hoc dispatch") +
                badge;
            hint = theme.fg(
                "dim",
                " primary agent dispatched work outside the workflow team",
            );
        } else {
            // The "(N agents · mode)" descriptor tracks the active set: the full team
            // at bootup, then the selected agents once the orchestrator has chosen
            // them — so the count and workflow mode match the work being done.
            const countSet = selecting ? selectedKeys : roster;
            header =
                " " +
                theme.fg("accent", theme.bold("agent-team")) +
                theme.fg("dim", "  ·  ") +
                theme.fg("dim", selecting ? "selected from " : "team ") +
                theme.fg("accent", activeTeamName || "—") +
                theme.fg(
                    "dim",
                    ` (${countSet.length} agent${countSet.length === 1 ? "" : "s"}` +
                        `${teamIsSpec(countSet) ? " · spec mode" : " · full pipeline"})`,
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
            lines.push(
                theme.fg(
                    "dim",
                    " No agents in this team. Check .pi/agents/teams.yaml and .pi/agents/*.md.",
                ),
            );
            return lines;
        }

        const cols = Math.min(
            members.length <= 3 ? members.length : 3,
            members.length,
        );
        const gap = 1;
        const colWidth = Math.max(
            18,
            Math.floor((width - gap * (cols - 1)) / cols),
        );

        for (let i = 0; i < members.length; i += cols) {
            const rowMembers = members.slice(i, i + cols);
            const cards = rowMembers.map((m) =>
                renderAgentCard(m, colWidth, theme),
            );
            const cardH = cards[0]?.length ?? 6;
            while (cards.length < cols)
                cards.push(Array(cardH).fill(" ".repeat(colWidth)));
            for (let line = 0; line < cardH; line++) {
                lines.push(
                    cards.map((c) => c[line] || "").join(" ".repeat(gap)),
                );
            }
        }
        return lines;
    }

    // Append the live log of the currently running agent to `lines`. Grows to fill
    // the available vertical space, then tails. Shared by the pipeline and grid views.
    function appendLiveLog(lines: string[], width: number, theme: any) {
        const active = phases.find((p) => p.status === "running");
        // Render the panel whenever a run/dispatch is active, at a STABLE height
        // (padded) so the widget never shrinks between renders. A shrinking widget
        // left stale rows ghosting behind the new frame.
        if (!running && !(active && active.log)) return;
        const toolNote =
            active && active.toolCount > 0
                ? ` · ${active.toolCount} tool${active.toolCount === 1 ? "" : "s"}`
                : "";
        const label = active
            ? ` ─── ${active.label} · live${toolNote} `
            : ` ─── live ─── `;
        const rule = "─".repeat(Math.max(0, width - visibleWidth(label) - 1));
        lines.push("");
        lines.push(theme.fg("dim", label + rule));
        const logLines = (active?.log || "")
            .split("\n")
            .map((l) => l.replace(/\s+$/, ""))
            .filter((l) => l.length);
        const rows = process.stdout.rows || 24;
        // Hard bound so the editor + footer always stay on screen: never taller
        // than half the terminal, and always leaving room below.
        const maxLogRows = Math.max(
            3,
            Math.min(
                Math.floor(rows / 2),
                rows - lines.length - LOG_PANEL_RESERVE,
            ),
        );
        const colW = width - 4;
        // Reserve the first panel row for the "earlier lines" notice (blank when
        // not needed) so the panel height is constant.
        const bodyRows = Math.max(1, maxLogRows - 1);
        const shown = logLines.slice(-bodyRows);
        lines.push(
            logLines.length > shown.length
                ? "   " +
                      theme.fg(
                          "dim",
                          `… ${logLines.length - shown.length} earlier line(s) — full log below`,
                      )
                : "",
        );
        for (const l of shown) {
            const t = l.length > colW ? l.slice(0, colW - 1) + "…" : l;
            lines.push("   " + theme.fg("muted", t));
        }
        // Pad to the stable panel height so the widget never shrinks.
        for (let i = shown.length; i < bodyRows; i++) lines.push("");
    }

    function updateWidget() {
        if (!widgetCtx) return;
        widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
            const text = new Text("", 0, 1);
            return {
                render(width: number): string[] {
                    if (phases.length === 0 || dispatchMode) {
                        // Idle or ad-hoc dispatch: keep the full team grid on
                        // screen. At bootup every card is idle; once the primary
                        // agent dispatches work, the selected cards are marked and
                        // reflect live status, while the rest stay idle. The live
                        // log of the running agent is appended below the grid.
                        const gridLines = renderAgentGrid(width, theme);
                        if (dispatchMode)
                            appendLiveLog(gridLines, width, theme);
                        text.setText(gridLines.join("\n"));
                        return text.render(width);
                    }

                    // ── Pipeline view (full run_agent_team) ───────────
                    // Per-agent model table, shown between the title and the cards.
                    const fallbackModel =
                        WORKER_MODEL || widgetCtx?.model?.id || "default";
                    const agentOrder = [
                        "planner",
                        "implementer",
                        "tester",
                        "validator",
                        "documenter",
                    ] as const;
                    const maxAgentLen = Math.max(
                        ...agentOrder.map((a) => displayName(a).length),
                    ); // "Implementer".length = 11
                    const activeAgent =
                        phases.find((p) => p.status === "running")?.agent ?? "";

                    const modelRows: string[] = agentOrder.map((agentKey) => {
                        const m = agentModels[agentKey] || fallbackModel;
                        const label = displayName(agentKey).padEnd(maxAgentLen);
                        const isActive = agentKey === activeAgent;
                        const bullet = isActive
                            ? theme.fg("accent", " ● ")
                            : theme.fg("dim", "   ");
                        const labelStr = isActive
                            ? theme.fg("accent", theme.bold(label))
                            : theme.fg("dim", label);
                        const modelStr = isActive
                            ? theme.fg("accent", m)
                            : theme.fg("muted", m);
                        return (
                            bullet + labelStr + theme.fg("dim", "  ") + modelStr
                        );
                    });

                    const arrowWidth = 5; // " ──▶ "
                    const cols = phases.length;
                    const colWidth = Math.max(
                        14,
                        Math.floor((width - arrowWidth * (cols - 1)) / cols),
                    );
                    const arrowRow = 2; // middle of the 5-line card

                    const cards = phases.map((p) =>
                        renderCard(p, colWidth, theme),
                    );
                    const cardHeight = cards[0].length;
                    const lines: string[] = [];

                    const passInfo =
                        iteration > 1
                            ? theme.fg(
                                  "dim",
                                  `  attempt ${iteration}/${maxLoopsRef}`,
                              )
                            : "";
                    // Reflect the agents actually running, not a fixed label.
                    const doneCount = phases.filter(
                        (p) => p.status === "done",
                    ).length;
                    const phaseProgress = running
                        ? ` (${doneCount}/${phases.length})`
                        : "";
                    const workflowTitle =
                        phases.map((p) => p.label).join("→") + phaseProgress;
                    lines.push(
                        " " +
                            theme.fg("accent", theme.bold(workflowTitle)) +
                            passInfo +
                            statusBadge(theme, running, lastStatus),
                    );
                    lines.push("");

                    // Model table — between title and phase cards; active agent highlighted
                    lines.push(theme.fg("dim", " Agent models:"));
                    for (const row of modelRows) lines.push(row);
                    lines.push("");

                    for (let line = 0; line < cardHeight; line++) {
                        let row = cards[0][line];
                        for (let c = 1; c < cols; c++) {
                            row +=
                                line === arrowRow
                                    ? theme.fg("dim", " ──▶ ")
                                    : " ".repeat(arrowWidth);
                            row += cards[c][line];
                        }
                        lines.push(row);
                    }

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
    // Builds a SpawnConfig from module-level state and accumulates token/tool/
    // dropped-line totals back into the module counters after each spawn.
    // agent-team always uses per-agent sessions (sharedSession: false).
    function spawnAgentWithModel(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
        model: string,
    ): Promise<{ output: string; exitCode: number }> {
        const cfg: SpawnConfig = {
            sessionDir,
            sharedSession: false,
            agentTimeoutMs: AGENT_TIMEOUT_MS,
            updateWidget,
            setCurrentProc: (p: any) => {
                currentProc = p;
            },
        };
        const prevToolCount = phase.toolCount;
        const prevDroppedLines = phase.droppedLines;
        return coreSpawnAgent(agentDef, task, phase, cwd, model, cfg).then(
            (result) => {
                if (result.tokens) {
                    totalTokens.input += result.tokens.input;
                    totalTokens.output += result.tokens.output;
                    phase.tokens = result.tokens;
                }
                totalToolCalls += phase.toolCount - prevToolCount;
                totalDroppedLines += phase.droppedLines - prevDroppedLines;
                return { output: result.output, exitCode: result.exitCode };
            },
        );
    }

    function runAgent(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
    ): Promise<{ output: string; exitCode: number }> {
        // Per-agent model: check the agent's own .md frontmatter first, then the
        // team config (env var override), then fall back to the global default.
        const agentKey = agentDef.name.toLowerCase();
        const teamModel = agentModels[agentKey as AgentName] ?? WORKER_MODEL;
        const primaryModel = agentDef.model || teamModel;
        // Fallback: the model the current pi session is running on (the primary
        // agent's model). If an agent's configured model fails to load, we retry
        // with the session model since it's known to work — pi itself is using it.
        const sm = widgetCtx?.model;
        const sessionModel =
            sm?.provider && sm?.id ? `${sm.provider}/${sm.id}` : sm?.id || "";
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
        return runPhaseCore(agents, phase, task, cwd, runAgent, {
            updateWidget,
            notify: (msg, level) => widgetCtx?.ui?.notify?.(msg, level),
            phaseLogs,
        });
    }

    // ── Orchestrate the full lifecycle ───────────

    async function runWorkflow(
        request: string,
        maxLoops: number,
        ctx: any,
    ): Promise<{ status: string; report: string }> {
        abortController = new AbortController();
        isSpecMode = false; // never inherit spec mode from a prior invocation
        const cwd = ctx.cwd;
        agentModels = loadAgentModels(cwd);
        includeScout = activeMembers().some((m) => m.toLowerCase() === "scout");
        setupSessions(cwd, true);
        dispatchMode = false; // a full pipeline run uses the linear card view
        phases = freshPhases();
        phaseLogs = [];
        totalDroppedLines = 0;
        totalToolCalls = 0;
        totalTokens = { input: 0, output: 0 };
        runStartedAt = Date.now();
        runElapsedMs = 0;
        iteration = 0;
        maxLoopsRef = maxLoops;
        lastStatus = "running";
        running = true;
        updateWidget();

        const missing = REQUIRED_AGENTS.filter((a) => !agents.has(a));
        if (missing.length) {
            running = false;
            lastStatus = "error";
            return {
                status: "error",
                report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
            };
        }

        // Shared curated context — the artifacts each later agent would not
        // otherwise see (recon, critique). Builders already thread the rest
        // (plan, impl summary, test report) into the phases that need them, so
        // we only accumulate the dropped ones here to avoid duplication.
        // Controlled by PI_AGENT_TEAM_SHARED_CONTEXT (on by default).
        const runArtifacts: RunArtifacts = {};
        const shared = (task: string, phaseAgent: string) => {
            if (!SHARED_CONTEXT) return task;
            const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
            return bundle ? `${bundle}\n\n---\n\n${task}` : task;
        };

        // Type-safe phase access — matched by agent name, not position
        const pm = buildPhaseMap(phases);
        const scoutP = pm.scout ?? null;
        const planP = pm.planner;
        const critiqueP = pm.critic;
        const implP = pm.implementer;
        const testP = pm.tester;
        const valP = pm.validator;
        const docP = pm.documenter;
        const shipP = pm.ship;

        const validatorCount = phases.filter(
            (p) => p.agent === "validator",
        ).length;
        if (validatorCount < 2) {
            widgetCtx?.ui?.notify?.(
                `Only ${validatorCount} validator(s) configured — the ship phase will reuse the validator's session. Add a second validator entry in teams.yaml for independent ship validation.`,
                "warning",
            );
        }

        let scoutFindings = "";
        if (scoutP) {
            const scoutRes = await runPhase(scoutP, scoutTask(request), cwd);
            if (!scoutRes.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Scouting", scoutRes.output);
            }
            scoutFindings = scoutRes.output;
            runArtifacts.recon = scoutFindings;
        }

        // Phase 1 — Plan (once)
        let plan = await runPhase(planP, planTask(request, scoutFindings), cwd);
        if (!plan.ok) {
            running = false;
            lastStatus = "error";
            return failPhase("Planning", plan.output);
        }

        // Structural check: reject clearly malformed plans before handing to implementer.
        const planCheck = validatePlan(plan.output);
        if (!planCheck.ok) {
            running = false;
            lastStatus = "error";
            return {
                status: "error",
                report: `Plan is missing required structure. The planner's output lacks:\n- ${planCheck.missing.join("\n- ")}\n\nThe implementer cannot act reliably on this plan. Re-run with a more specific request, or check that the planner agent definition is complete.`,
            };
        }
        runArtifacts.plan = plan.output;

        // Phase 2 — Critique (plan ⇄ critic loop)
        let critique = { output: "", ok: true };
        let critiqueVerdict: CritiqueVerdict = "unknown";

        for (let loop = 1; loop <= maxLoops; loop++) {
            critiqueP.status = "pending";
            updateWidget();
            critique = await runPhase(
                critiqueP,
                shared(criticTask(request, plan.output), "critic"),
                cwd,
            );
            if (!critique.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Critique", critique.output);
            }

            critiqueVerdict = detectCritique(critique.output);
            if (critiqueVerdict !== "revise") break;

            // REVISE — loop back to the planner unless we are out of attempts
            if (loop === maxLoops) break;
            planP.status = "pending";
            planP.note = "";
            updateWidget();
            plan = await runPhase(
                planP,
                revisePlanTask(request, plan.output, critique.output),
                cwd,
            );
            if (!plan.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Plan revision", plan.output);
            }
            runArtifacts.plan = plan.output;
        }

        // The critic's verdict is now settled — share it with every later agent.
        runArtifacts.critique = critique.output;

        // Phase 3 — Implement (first pass)
        let impl = await runPhase(
            implP,
            shared(implementTask(request, plan.output), "implementer"),
            cwd,
        );
        if (!impl.ok) {
            running = false;
            lastStatus = "error";
            return failPhase("Implementation", impl.output);
        }
        runArtifacts.implSummary = impl.output;

        let test = { output: "", ok: false };
        let val = { output: "", ok: false };
        let doc = { output: "", ok: false };
        let ship = { output: "", ok: false };
        let verdict: Verdict = "unknown";

        // Correctness loop — test ⇄ validate, gated by the validator.
        for (let loop = 1; loop <= maxLoops; loop++) {
            iteration = loop;

            // Test
            testP.status = "pending";
            valP.status = "pending";
            updateWidget();
            test = await runPhase(
                testP,
                shared(testTask(request, plan.output, impl.output), "tester"),
                cwd,
            );
            if (!test.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Testing", test.output);
            }
            runArtifacts.testReport = test.output;

            // Validate (the gate — no commit, no PR yet)
            val = await runPhase(
                valP,
                shared(
                    validateTask(request, plan.output, test.output),
                    "validator",
                ),
                cwd,
            );
            if (!val.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Validation", val.output);
            }

            verdict = detectVerdict(val.output);
            if (verdict !== "fail") break;

            // FAIL — loop back to the implementer unless we are out of attempts
            if (loop === maxLoops) break;
            implP.status = "pending";
            implP.note = "";
            updateWidget();
            impl = await runPhase(
                implP,
                shared(
                    fixTask(request, plan.output, val.output, impl.output),
                    "implementer",
                ),
                cwd,
            );
            if (!impl.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Re-implementation", impl.output);
            }
            runArtifacts.implSummary = `[attempt ${implP.attempt}] ${impl.output}`;
        }

        // Document + ship only once the change has passed validation.
        let status: string;
        if (verdict === "pass") {
            doc = await runPhase(
                docP,
                shared(
                    documentTask(
                        request,
                        plan.output,
                        impl.output,
                        test.output,
                    ),
                    "documenter",
                ),
                cwd,
            );
            if (!doc.ok) {
                // Graceful degradation: doc failure doesn't kill a passing build
                widgetCtx?.ui?.notify?.(
                    "Documenter failed — code changes are valid but docs were not updated. Proceeding to ship.",
                    "warning",
                );
                doc = {
                    output: "[Documenter failed — see activity logs]",
                    ok: false,
                };
            } else {
                runArtifacts.docReport = doc.output;
            }

            ship = await runPhase(
                shipP,
                shared(shipTask(request, test.output, doc.output), "ship"),
                cwd,
            );
            if (!ship.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Shipping", ship.output);
            }

            status =
                detectShip(ship.output) === "paused"
                    ? "paused-no-remote"
                    : "shipped";
        } else {
            status =
                verdict === "fail" ? "failed-after-retries" : "needs-review";
        }

        runElapsedMs = Date.now() - runStartedAt;
        running = false;
        lastStatus = status;
        updateWidget();

        const passes = iteration;
        const passed = verdict === "pass";
        const prUrl =
            (ship.output.match(/https?:\/\/\S*\/pull\/\d+/) || [])[0] || "";

        const report = [
            `# Workflow Report`,
            ``,
            `**Request:** ${request}`,
            `**Outcome:** ${outcomeLine(status, passes)}`,
            `**Result:** ${status} · verdict ${verdict.toUpperCase()} · ${passes} attempt(s) of ${maxLoops}`,
            `**Totals:** ${secs(runElapsedMs)} wall-clock · ${totalToolCalls} tool call(s)${totalTokens.input > 0 ? ` · ${(totalTokens.input + totalTokens.output).toLocaleString()} tokens (${totalTokens.input.toLocaleString()} in / ${totalTokens.output.toLocaleString()} out)` : ""}`,
            ...(prUrl ? [`**Pull request:** ${prUrl}`] : []),
            ...(totalDroppedLines > 0
                ? [
                      ``,
                      `> **Diagnostic:** ${totalDroppedLines} malformed JSON line(s) were dropped from agent output streams during this run. This may indicate a pi subprocess protocol issue. Full agent logs are appended below.`,
                  ]
                : []),
            ``,
            `## Summary of work`,
            ``,
            ...(scoutP
                ? [
                      `- **Scout** (${secs(scoutP.elapsed)}${tokenNote(scoutP)}) — ${digest(scoutFindings)}${scoutP.droppedLines > 0 ? ` [${scoutP.droppedLines} dropped]` : ""}`,
                  ]
                : []),
            `- **Planner** (${secs(planP.elapsed)}${tokenNote(planP)}) — ${digest(plan.output)}${planP.droppedLines > 0 ? ` [${planP.droppedLines} dropped]` : ""}`,
            `- **Critic** (${secs(critiqueP.elapsed)}${tokenNote(critiqueP)}) — ${digest(critique.output)}${critiqueP.droppedLines > 0 ? ` [${critiqueP.droppedLines} dropped]` : ""}`,
            `- **Implementer** (${secs(implP.elapsed)}${tokenNote(implP)}) — ${digest(impl.output)}${implP.droppedLines > 0 ? ` [${implP.droppedLines} dropped]` : ""}`,
            `- **Tester** (${secs(testP.elapsed)}${tokenNote(testP)}) — ${digest(test.output)}${testSignal(test.output)}${testP.droppedLines > 0 ? ` [${testP.droppedLines} dropped]` : ""}`,
            `- **Validator** (${secs(valP.elapsed)}${tokenNote(valP)}) — verdict ${verdict.toUpperCase()}. ${digest(val.output)}${valP.droppedLines > 0 ? ` [${valP.droppedLines} dropped]` : ""}`,
            ...(passed
                ? [
                      `- **Documenter** (${secs(docP.elapsed)}${tokenNote(docP)}) — ${digest(doc.output)}${docP.droppedLines > 0 ? ` [${docP.droppedLines} dropped]` : ""}`,
                      `- **Ship** (${secs(shipP.elapsed)}${tokenNote(shipP)}) — ${digest(ship.output)}${shipP.droppedLines > 0 ? ` [${shipP.droppedLines} dropped]` : ""}`,
                  ]
                : [
                      `- **Documenter / Ship** — skipped (change did not pass validation)`,
                  ]),
            ``,
            `## Details`,
            ``,
            ...(scoutP ? [`### Reconnaissance`, ``, scoutFindings, ``] : []),
            `### Plan`,
            ``,
            plan.output,
            ``,
            `### Critique`,
            ``,
            critique.output,
            ``,
            `### Implementation`,
            ``,
            impl.output,
            ``,
            `### Test Report`,
            ``,
            test.output,
            ``,
            `### Validation`,
            ``,
            val.output,
            ``,
            ...(passed
                ? [
                      `### Documentation`,
                      ``,
                      doc.output,
                      ``,
                      `### Ship`,
                      ``,
                      ship.output,
                      ``,
                  ]
                : []),
        ].join("\n");

        const reportPath = join(cwd, "workflow-report.md");
        try {
            writeFileSync(reportPath, report, "utf-8");
        } catch (e: any) {
            widgetCtx?.ui?.notify?.(
                `Could not write workflow-report.md: ${e.message}`,
                "warning",
            );
        }

        // Post the consolidated, scrollable activity log before returning.
        publishLogs();

        abortController = null;
        return { status, report };
    }

    // ── Orchestrate the spec-only workflow ────────

    async function runSpecWorkflow(
        request: string,
        ctx: any,
    ): Promise<{ status: string; report: string }> {
        abortController = new AbortController();
        isSpecMode = true;
        const cwd = ctx.cwd;
        agentModels = loadAgentModels(cwd);
        includeScout = activeMembers().some((m) => m.toLowerCase() === "scout");
        setupSessions(cwd, true);
        dispatchMode = false; // a full pipeline run uses the linear card view
        phases = freshPhases();
        phaseLogs = [];
        totalDroppedLines = 0;
        totalToolCalls = 0;
        totalTokens = { input: 0, output: 0 };
        runStartedAt = Date.now();
        runElapsedMs = 0;
        iteration = 1;
        maxLoopsRef = 1;
        lastStatus = "running";
        running = true;
        updateWidget();

        const missing = REQUIRED_AGENTS.filter((a) => !agents.has(a));
        if (missing.length) {
            running = false;
            lastStatus = "error";
            return {
                status: "error",
                report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
            };
        }

        // Type-safe phase access — matched by agent name, not position
        const pm = buildPhaseMap(phases);
        const scoutP = pm.scout ?? null;
        const planP = pm.planner;
        const critiqueP = pm.critic;
        const docP = pm.documenter;

        // Shared curated context (recon + critique) — see runWorkflow. Builders
        // already thread the plan, so only the dropped artifacts go in here.
        const runArtifacts: RunArtifacts = {};
        const shared = (task: string, phaseAgent: string) => {
            if (!SHARED_CONTEXT) return task;
            const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
            return bundle ? `${bundle}\n\n---\n\n${task}` : task;
        };

        // Optional Phase 0 — Scout (read-only recon, feeds the planner)
        let scoutFindings = "";
        if (scoutP) {
            const scoutRes = await runPhase(scoutP, scoutTask(request), cwd);
            if (!scoutRes.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Scouting", scoutRes.output);
            }
            scoutFindings = scoutRes.output;
            runArtifacts.recon = scoutFindings;
        }

        // Plan ⇄ Critique loop — the planner revises until the critic approves.
        const maxCritiqueLoops =
            maxLoopsRef > 0 ? maxLoopsRef : DEFAULT_MAX_LOOPS;
        let plan = await runPhase(
            planP,
            specPlanTask(request, scoutFindings),
            cwd,
        );
        if (!plan.ok) {
            running = false;
            lastStatus = "error";
            return failPhase("Planning", plan.output);
        }
        runArtifacts.plan = plan.output;

        let critique = { output: "", ok: true };
        let critiqueVerdict: CritiqueVerdict = "unknown";

        for (let loop = 1; loop <= maxCritiqueLoops; loop++) {
            critiqueP.status = "pending";
            updateWidget();
            critique = await runPhase(
                critiqueP,
                shared(specCriticTask(request, plan.output), "critic"),
                cwd,
            );
            if (!critique.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Critique", critique.output);
            }

            critiqueVerdict = detectCritique(critique.output);
            if (critiqueVerdict !== "revise") break;

            // REVISE — loop back to the planner unless we are out of attempts
            if (loop === maxCritiqueLoops) break;
            planP.status = "pending";
            planP.note = "";
            updateWidget();
            plan = await runPhase(
                planP,
                specReviseTask(request, plan.output, critique.output),
                cwd,
            );
            if (!plan.ok) {
                running = false;
                lastStatus = "error";
                return failPhase("Plan revision", plan.output);
            }
            runArtifacts.plan = plan.output;
        }

        // The critic's verdict is settled — share it with the documenter.
        runArtifacts.critique = critique.output;

        // Phase 3 — Document (produce the spec)
        const doc = await runPhase(
            docP,
            shared(specDocumentTask(request, plan.output), "documenter"),
            cwd,
        );
        if (!doc.ok) {
            running = false;
            lastStatus = "error";
            return failPhase("Documentation", doc.output);
        }
        runArtifacts.docReport = doc.output;

        const critiqueApproved = critiqueVerdict !== "revise";
        const status = critiqueApproved ? "done" : "needs-review";
        runElapsedMs = Date.now() - runStartedAt;
        running = false;
        lastStatus = status;
        updateWidget();

        const outcome = critiqueApproved
            ? "SPEC COMPLETE — implementation spec saved to specs/"
            : `NEEDS REVIEW — the critic did not approve the plan after ${maxCritiqueLoops} attempt(s). The spec was generated from the last plan revision; review the critique before using it.`;

        const report = [
            `# Spec Workflow Report`,
            ``,
            `**Request:** ${request}`,
            `**Outcome:** ${outcome}`,
            `**Totals:** ${secs(runElapsedMs)} wall-clock · ${totalToolCalls} tool call(s)${totalTokens.input > 0 ? ` · ${(totalTokens.input + totalTokens.output).toLocaleString()} tokens (${totalTokens.input.toLocaleString()} in / ${totalTokens.output.toLocaleString()} out)` : ""}`,
            ...(totalDroppedLines > 0
                ? [
                      ``,
                      `> **Diagnostic:** ${totalDroppedLines} malformed JSON line(s) were dropped from agent output streams during this run.`,
                  ]
                : []),
            ``,
            `## Summary`,
            ``,
            ...(scoutP
                ? [
                      `- **Scout** (${secs(scoutP.elapsed)}${tokenNote(scoutP)}) — ${digest(scoutFindings)}`,
                  ]
                : []),
            `- **Planner** (${secs(planP.elapsed)}${tokenNote(planP)}) — ${digest(plan.output)}`,
            `- **Critic** (${secs(critiqueP.elapsed)}${tokenNote(critiqueP)}) — ${digest(critique.output)}`,
            `- **Documenter** (${secs(docP.elapsed)}${tokenNote(docP)}) — ${digest(doc.output)}`,
            ``,
            `## Details`,
            ``,
            ...(scoutP ? [`### Reconnaissance`, ``, scoutFindings, ``] : []),
            `### Plan`,
            ``,
            plan.output,
            ``,
            `### Critique`,
            ``,
            critique.output,
            ``,
            `### Implementation Spec`,
            ``,
            doc.output,
        ].join("\n");

        const reportPath = join(cwd, "workflow-report.md");
        try {
            writeFileSync(reportPath, report, "utf-8");
        } catch (e: any) {
            widgetCtx?.ui?.notify?.(
                `Could not write workflow-report.md: ${e.message}`,
                "warning",
            );
        }

        publishLogs();

        abortController = null;
        return { status, report };
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
        publishReportCore(pi, report, lastStatus);

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

    const publishLogs = () => publishLogsCore(pi, phaseLogs);

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
                if (running) {
                    ctx.ui.notify("A workflow is already running.", "warning");
                    return;
                }

                agents = loadAgents(ctx.cwd);
                agentModels = loadAgentModels(ctx.cwd);
                teams = loadTeams(ctx.cwd);
                if (Object.keys(teams).length === 0)
                    teams = { all: Array.from(agents.keys()) };
                const missing = REQUIRED_AGENTS.filter((a) => !agents.has(a));
                if (missing.length) {
                    ctx.ui.notify(
                        `Missing agents in .pi/agents/: ${missing.join(", ")}`,
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
                const lower = rawArgs.toLowerCase();

                // An explicit `spec ` / `full ` prefix forces the mode and skips the
                // team picker; otherwise we show the Select Team dialog and the
                // chosen team decides the mode (a spec-only team like `info` runs
                // the plan→document workflow).
                const explicitSpec =
                    lower === "spec" || lower.startsWith("spec ");
                const explicitFull =
                    lower === "full" || lower.startsWith("full ");
                const request =
                    explicitSpec || explicitFull
                        ? rawArgs.slice(4).trim()
                        : rawArgs;

                if (explicitSpec || explicitFull) {
                    isSpecMode = explicitSpec;
                } else {
                    const picked = await chooseTeam(ctx);
                    if (picked === null) return; // user cancelled the picker
                    activateTeam(picked);
                    updateWidget();
                    isSpecMode = teamIsSpec(activeMembers());
                    // Move the active marker to the selected team and surface it.
                    ctx.ui.notify(
                        `Active team → ${activeTeamName}\nTeams:\n${teamsBlock()}`,
                        "info",
                    );
                }

                // Prompt for the request if it wasn't typed inline, so we never
                // dispatch a workflow on an empty string.
                let finalRequest = request;
                if (!finalRequest) {
                    const prompt = isSpecMode
                        ? "What should be specified?"
                        : "What should the workflow build or fix?";
                    const typed = await ctx.ui.input(prompt, "");
                    if (!typed) return;
                    finalRequest = typed.trim();
                    if (!finalRequest) return;
                }

                return isSpecMode
                    ? runSpecWorkflowCommand(finalRequest, ctx)
                    : runFullWorkflowCommand(finalRequest, ctx, maxLoops);
            },
        });

    async function runFullWorkflowCommand(
        request: string,
        ctx: any,
        maxLoops: number = DEFAULT_MAX_LOOPS,
    ) {
        ctx.ui.notify(
            `Starting workflow: ${request} (max retries: ${maxLoops})`,
            "info",
        );
        const result = await runWorkflow(request, maxLoops, ctx);

        const level =
            result.status === "shipped"
                ? "success"
                : result.status.startsWith("error") ||
                    result.status === "failed-after-retries"
                  ? "error"
                  : "warning";
        ctx.ui.notify(
            `Workflow ${result.status}. Report is shown below.`,
            level as any,
        );
        if (totalDroppedLines > 0) {
            ctx.ui.notify(
                `Heads up: ${totalDroppedLines} malformed JSON line(s) were dropped from agent output — possible pi subprocess issue (see report diagnostic).`,
                "warning",
            );
        }

        if (result.report && result.report.trim().length > 0) {
            publishReport(result.report);
        }
    }

    async function runSpecWorkflowCommand(request: string, ctx: any) {
        ctx.ui.notify(`Generating implementation spec: ${request}`, "info");
        const result = await runSpecWorkflow(request, ctx);

        const level =
            result.status === "done"
                ? "success"
                : result.status.startsWith("error")
                  ? "error"
                  : "warning";
        ctx.ui.notify(
            `Spec generation ${result.status}. Report is shown below.`,
            level as any,
        );
        if (totalDroppedLines > 0) {
            ctx.ui.notify(
                `Heads up: ${totalDroppedLines} malformed JSON line(s) were dropped from agent output — possible pi subprocess issue (see report diagnostic).`,
                "warning",
            );
        }

        if (result.report && result.report.trim().length > 0) {
            publishReport(result.report);
        }
    }

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
                if (running) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "A workflow is already running.",
                            },
                        ],
                    };
                }
                agents = loadAgents(ctx.cwd);
                widgetCtx = ctx;
                pipelineRanThisTurn = true; // fold the primary's turn time into the total
                if (onUpdate)
                    onUpdate({
                        content: [
                            {
                                type: "text",
                                text: `Running workflow: ${request}`,
                            },
                        ],
                    });
                // If the turn is aborted, kill the running agent subprocess so the
                // workflow doesn't keep running detached in the background.
                const onAbort = () =>
                    (globalThis as any).__piKillWorkflowProc?.();
                signal?.addEventListener?.("abort", onAbort);
                const result = await runWorkflow(
                    request,
                    max_loops && max_loops > 0 ? max_loops : DEFAULT_MAX_LOOPS,
                    ctx,
                ).finally(() =>
                    signal?.removeEventListener?.("abort", onAbort),
                );
                const truncated =
                    result.report.length > 8000
                        ? result.report.slice(0, 8000) +
                          "\n\n... [truncated — see workflow-report.md]"
                        : result.report;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Status: ${result.status}\n\n${truncated}`,
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

    // ── dispatch_agent tool — free-form dispatch to any loaded agent ──

    if (active)
        pi.registerTool({
            name: "dispatch_agent",
            label: "Dispatch Agent",
            description:
                "Dispatch a task to a specialist agent outside the workflow pipeline. The agent runs with its configured model and tools, and returns the result. Use this for ad-hoc work that doesn't fit the plan→implement→test→validate lifecycle (e.g. quick lookups, one-off analyses, or re-running a specific agent with a custom task).",
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
                const { agent, task } = params as {
                    agent: string;
                    task: string;
                };

                if (running) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Cannot dispatch while a workflow is running. Wait for it to finish or cancel it first.",
                            },
                        ],
                    };
                }

                const MAX_DISPATCHES_PER_TURN = parseInt(
                    process.env.PI_MAX_DISPATCHES_PER_TURN || "20",
                    10,
                );
                if (dispatchesThisTurn >= MAX_DISPATCHES_PER_TURN) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Dispatch limit reached (${MAX_DISPATCHES_PER_TURN} per turn). Summarize what has been done and stop — do not dispatch more agents this turn.`,
                            },
                        ],
                    };
                }

                agents = loadAgents(ctx.cwd);
                agentModels = loadAgentModels(ctx.cwd);
                widgetCtx = ctx;
                const def = agents.get(agent.toLowerCase());
                if (!def) {
                    const available = Array.from(agents.values())
                        .map((d) => d.name)
                        .join(", ");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Agent "${agent}" not found. Available agents: ${available}`,
                            },
                        ],
                    };
                }

                if (onUpdate)
                    onUpdate({
                        content: [
                            {
                                type: "text",
                                text: `Dispatching to ${def.name}...`,
                            },
                        ],
                    });

                // Ensure session directory is initialized. setupSessions is
                // normally called by runWorkflow/runSpecWorkflow, but
                // dispatch_agent can be called standalone.
                setupSessions(ctx.cwd, false);

                // Enter dispatch mode: the full team grid stays on screen and the
                // selected agents are marked. A workflow run (run_agent_team)
                // resets this back to the linear pipeline view. A new user request
                // (freshDispatchSession) also starts from a clean slate so the new
                // workflow never shows the previous one's cards.
                if (!dispatchMode || freshDispatchSession) {
                    dispatchMode = true;
                    phases = []; // start a fresh dispatch session's selections
                    // Time from the primary agent's turn start (its pre-dispatch
                    // reasoning counts), falling back to now if unknown.
                    dispatchStartedAt = primaryTurnStartedAt || Date.now();
                    dispatchElapsedMs = 0;
                }
                freshDispatchSession = false;
                dispatchedThisTurn = true;
                dispatchesThisTurn++;

                // Track this agent as a phase so its card reflects live status.
                // Re-dispatching the same agent reuses (and resets) its phase so the
                // grid never grows duplicate cards; other selections stay marked.
                const agentKey = def.name.toLowerCase();
                let phase = phases.find((p) => p.agent === agentKey);
                if (phase) {
                    phase.status = "pending";
                    phase.elapsed = 0;
                    phase.note = "";
                    phase.log = "";
                    phase.droppedLines = 0;
                    phase.toolCount = 0;
                    phase.contextPct = 0;
                    phase.attempt = 0;
                } else {
                    phase = {
                        label: displayName(def.name),
                        agent: agentKey,
                        status: "pending",
                        elapsed: 0,
                        note: "",
                        log: "",
                        droppedLines: 0,
                        toolCount: 0,
                        contextPct: 0,
                        attempt: 0,
                        modelFallback: false,
                    };
                    phases.push(phase);
                }
                updateWidget();

                const start = Date.now();
                phase.attempt = 1;
                phase.status = "running";
                updateWidget();

                const res = await runAgent(def, task, phase, ctx.cwd);

                // An agent that exits cleanly but returns (near-)empty output did
                // not actually do the work — treat it as a FAILED dispatch so the
                // orchestrator re-dispatches it instead of building on nothing.
                const emptyOutput = res.output.trim().length < 40;
                const ok = res.exitCode === 0 && !emptyOutput;

                phase.status = ok ? "done" : "error";
                phase.elapsed = Date.now() - start;
                dispatchElapsedMs = Date.now() - dispatchStartedAt; // session total so far
                updateWidget();

                if (widgetCtx?.ui?.notify) {
                    const elapsed = secs(phase.elapsed);
                    const errMsg = !ok
                        ? emptyOutput
                            ? ": returned no usable output"
                            : `: ${res.output
                                  .split("\n")
                                  .filter((l) => l.trim())
                                  .slice(-2)
                                  .join(" ")
                                  .slice(0, 120)}`
                        : "";
                    widgetCtx.ui.notify(
                        `${def.name} ${ok ? "done" : "failed"} in ${elapsed}${errMsg}`,
                        ok ? "success" : "error",
                    );
                }

                const truncated =
                    res.output.length > 8000
                        ? res.output.slice(0, 8000) + "\n\n... [truncated]"
                        : res.output;

                const status = ok ? "done" : "error";
                const summary = `[${def.name}] ${status} in ${secs(phase.elapsed)}`;

                // Steer the orchestrator (via the tool result it reads next):
                // - empty output -> the dispatch failed; re-dispatch, do not skip;
                // - if selected agents are still queued, dispatch the next one;
                // - if none remain, the task is done — summarize and STOP. Without
                //   these signals, weak models skip a failed agent or re-dispatch a
                //   finished one instead of doing the right thing.
                const remaining = phases
                    .filter((p) => p.status === "pending")
                    .map((p) => displayName(p.agent));
                const nextStep = emptyOutput
                    ? `\n\n${def.name} returned almost no output — this dispatch FAILED. It is NOT a result to build on. RE-DISPATCH ${def.name} with a clearer, more specific task. Do NOT skip it, do NOT do its work yourself, and do NOT hand its job to a different agent.`
                    : remaining.length
                      ? `\n\nNOT DONE YET — still queued: ${remaining.join(", ")}. ` +
                        `Dispatch the next one (${remaining[0]}) now. Do not stop until every selected agent has run.`
                      : status === "done"
                        ? `\n\nDONE — every selected agent has completed and this dispatch succeeded. ` +
                          `Write your final summary of the result for the user and STOP. ` +
                          `Do NOT call select_agents or dispatch_agent again (no re-runs, no "verify" passes) unless the user asks for more.`
                        : "";

                return {
                    content: [
                        {
                            type: "text",
                            text: `${summary}\n\n${truncated}${nextStep}`,
                        },
                    ],
                    details: {
                        agent: def.name,
                        task,
                        status,
                        elapsed: phase.elapsed,
                        exitCode: res.exitCode,
                        fullOutput: res.output,
                        remainingQueued: remaining,
                    },
                };
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

    // ── select_agents tool — declare the team the orchestrator will use ──
    //
    // Called once the primary agent has determined which specialists the work
    // needs, BEFORE dispatching. It marks the chosen agents on the dashboard grid
    // (as "queued") so the plan is visible up front; subsequent dispatch_agent
    // calls flip each card to running/done. Agents already worked keep their status.

    if (active)
        pi.registerTool({
            name: "select_agents",
            label: "Select Agents",
            description:
                "Declare which specialist agents the work will use, in the order you intend to dispatch them. Call this once after you have determined the workflow and before dispatching — it marks the chosen agents on the team dashboard so the plan is visible. You can still dispatch agents not pre-declared; this just sets the up-front plan.",
            parameters: Type.Object({
                agents: Type.Array(Type.String(), {
                    description:
                        "Agent names (case-insensitive), in dispatch order. Must be loaded agents from .pi/agents/.",
                }),
            }),

            async execute(_id, params, _signal, _onUpdate, ctx) {
                const names = (params as { agents: string[] }).agents || [];

                if (running) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Cannot change the selection while a full workflow is running.",
                            },
                        ],
                    };
                }

                agents = loadAgents(ctx.cwd);
                agentModels = loadAgentModels(ctx.cwd);
                widgetCtx = ctx;

                const resolved: string[] = [];
                const unknown: string[] = [];
                for (const n of names) {
                    const def = agents.get(n.toLowerCase());
                    if (def) resolved.push(def.name.toLowerCase());
                    else unknown.push(n);
                }

                if (resolved.length === 0) {
                    const available = Array.from(agents.values())
                        .map((d) => d.name)
                        .join(", ");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No valid agents in selection. Available agents: ${available}`,
                            },
                        ],
                    };
                }

                // Enter dispatch mode and rebuild the phase list from the declared
                // selection. On a new request (freshDispatchSession) every card is
                // built fresh — the previous workflow's cards are dropped and reused
                // agents reset to queued. Within the same request (refining the
                // selection) we preserve the status of agents already worked.
                dispatchMode = true;
                if (freshDispatchSession) {
                    dispatchStartedAt = primaryTurnStartedAt || Date.now();
                    dispatchElapsedMs = 0;
                }
                const byAgent = freshDispatchSession
                    ? new Map<string, PhaseState>()
                    : new Map(phases.map((p) => [p.agent, p]));
                freshDispatchSession = false;
                phases = resolved.map(
                    (key) => byAgent.get(key) ?? mkPhase(displayName(key), key),
                );
                setupSessions(ctx.cwd, false);
                updateWidget();

                const order = resolved.map((k) => displayName(k)).join(" → ");
                const warn = unknown.length
                    ? ` (ignored unknown: ${unknown.join(", ")})`
                    : "";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Selected ${resolved.length} agent${resolved.length === 1 ? "" : "s"} for the work: ${order}.${warn} The dashboard now shows them queued — dispatch them in order.`,
                        },
                    ],
                    details: { selected: resolved, order, unknown },
                };
            },

            renderCall(args, theme) {
                return renderSelectAgentsCall(args, theme, Text, displayName);
            },

            renderResult(result, _options, theme) {
                return renderSelectAgentsResult(result, _options, theme, Text);
            },
        });

    // ── Cancellation hook (integrates with escape-cancel if present) ──

    // ── Primary-turn timing ──
    // The orchestrator's turn wraps both its own reasoning and the sub-agent work
    // it triggers, so timing it gives the total INCLUDING the primary agent's time.
    // At turn end we fold that into the dispatch / pipeline totals.
    if (active)
        pi.on("agent_start", async () => {
            primaryTurnStartedAt = Date.now();
            pipelineRanThisTurn = false;
            dispatchedThisTurn = false;
            dispatchesThisTurn = 0;
        });
    if (active)
        pi.on("agent_end", async () => {
            if (primaryTurnStartedAt <= 0) return;
            const turnMs = Date.now() - primaryTurnStartedAt;
            // Only fold the turn time into a total when work actually ran this turn,
            // so a plain "done" reply doesn't overwrite the last total.
            if (dispatchedThisTurn) dispatchElapsedMs = turnMs;
            if (pipelineRanThisTurn) runElapsedMs = turnMs;
            if (dispatchedThisTurn || pipelineRanThisTurn) updateWidget();
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
            freshDispatchSession = true;

            // Build a dynamic catalog of all loaded agents
            const agentCatalog = Array.from(agents.values())
                .map(
                    (def) =>
                        `### ${displayName(def.name)}\n**Dispatch as:** \`${def.name}\`\n${def.description}\n**Tools:** ${def.tools}`,
                )
                .join("\n\n");

            const teamMembers = Array.from(agents.values())
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
                team_name: activeTeamName,
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
        agents = loadAgents(ctx.cwd);
        agentModels = loadAgentModels(ctx.cwd);
        teams = loadTeams(ctx.cwd);
        // Fall back to an "all" team if teams.yaml is absent/empty, so the
        // dashboard still has something to show.
        if (Object.keys(teams).length === 0) {
            teams = { all: Array.from(agents.keys()) };
        }
        activateTeam(Object.keys(teams)[0] ?? "");
        dispatchMode = false;
        phases = [];

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
            // Abort any running workflow on dispose.
            if (abortController) {
                try {
                    abortController.abort();
                } catch {}
                abortController = null;
            }
            if (currentProc) {
                try {
                    currentProc.kill("SIGTERM");
                } catch {}
                currentProc = null;
            }
            running = false;
            return true;
        };
        (globalThis as any).__piHasRunningWorkflow = (): boolean => running;
        const present = REQUIRED_AGENTS.filter((a) => agents.has(a));
        const missing = REQUIRED_AGENTS.filter((a) => !agents.has(a));
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
                        `dispatch_agent             Tool — dispatch a task to any loaded agent outside the pipeline`,
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
                // Workflow status. The full pipeline drives `running`/`lastStatus`;
                // ad-hoc dispatch doesn't, so derive its state from the phases so the
                // footer never reads "idle" while a dispatched agent is working.
                const dispatchRunning =
                    dispatchMode && phases.some((p) => p.status === "running");
                const dispatchDone =
                    dispatchMode && phases.length > 0 && !dispatchRunning;
                // The agent currently executing — surfaced in the status so the
                // footer shows e.g. "running Implementer" rather than a bare state.
                const activeName = phases.find(
                    (p) => p.status === "running",
                )?.label;
                const statusColor =
                    running || dispatchRunning
                        ? "accent"
                        : dispatchDone
                          ? "success"
                          : lastStatus === "shipped"
                            ? "success"
                            : lastStatus === "paused-no-remote"
                              ? "accent"
                              : lastStatus === "idle"
                                ? "dim"
                                : "error";
                const statusText = running
                    ? activeName
                        ? iteration > 1
                            ? `running ${activeName} (attempt ${iteration}/${maxLoopsRef})`
                            : `running ${activeName}`
                        : iteration > 1
                          ? `running attempt ${iteration}/${maxLoopsRef}`
                          : "running"
                    : dispatchRunning
                      ? `running ${activeName ?? "agent"}`
                      : dispatchDone
                        ? dispatchElapsedMs > 0
                            ? `dispatch done · ${secs(dispatchElapsedMs)} total`
                            : "dispatch done"
                        : runElapsedMs > 0
                          ? `${lastStatus} · ${secs(runElapsedMs)} total`
                          : lastStatus;

                // Primary (orchestrator) agent's model — the full `provider/model`
                // pi was loaded with.
                const pm = widgetCtx?.model || ctx.model;
                const primaryFull =
                    pm?.provider && pm?.id
                        ? `${pm.provider}/${pm.id}`
                        : pm?.id || "default";

                // Primary agent's own context usage (session-wide, distinct from the
                // per-agent card bars). getContextUsage() returns undefined when the
                // model's context window is unknown, and percent:null right after a
                // compaction (count untrustworthy until the next model response).
                // Both are "unknown" — render "—", never a misleading 0%. When known,
                // show the token count too so a small-but-nonzero context isn't hidden
                // by a percentage that rounds to 0.
                let usage: any;
                try {
                    usage = ctx.getContextUsage?.();
                } catch {}
                const pct =
                    usage &&
                    typeof usage.percent === "number" &&
                    !Number.isNaN(usage.percent)
                        ? usage.percent
                        : null;
                const known = pct !== null;
                const filled = known
                    ? Math.max(0, Math.min(10, Math.round(pct / 10)))
                    : 0;
                const bar = "#".repeat(filled) + "-".repeat(10 - filled);
                const fmtTok = (n: number) =>
                    n >= 10000
                        ? `${Math.round(n / 1000)}k`
                        : n >= 1000
                          ? `${(n / 1000).toFixed(1)}k`
                          : `${n}`;
                const pctStr = !known
                    ? "—"
                    : typeof usage.tokens === "number" && usage.tokens > 0
                      ? `${Math.round(pct)}% · ${fmtTok(usage.tokens)}`
                      : `${Math.round(pct)}%`;

                // Left: primary model · agent-team status. Right: context bar.
                const left =
                    theme.fg("dim", ` ◆ ${primaryFull}`) +
                    theme.fg("muted", " · ") +
                    theme.fg("accent", "agent-team") +
                    theme.fg("dim", " ") +
                    theme.fg(statusColor, statusText);
                const right =
                    theme.fg("dim", ` [${bar}] `) +
                    theme.fg("muted", pctStr) +
                    " ";
                const pad = " ".repeat(
                    Math.max(
                        1,
                        width - visibleWidth(left) - visibleWidth(right),
                    ),
                );
                return [truncateToWidth(left + pad + right, width)];
            },
        }));
    });
}
