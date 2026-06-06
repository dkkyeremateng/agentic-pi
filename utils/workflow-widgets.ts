// ABOUTME: Shared widget rendering utilities for the workflow orchestrator extensions.
// ABOUTME: Extracts the common grid layout and pipeline view logic used by the
// ABOUTME: agent-workflow extension (card styling, model tables, dispatch badges).

import type { PhaseState } from "./workflow-core";
import {
    displayName,
    statusBadge,
    statusMeta,
    agentPhaseStatus,
    formatContextUsage,
    formatCostUsd,
} from "./workflow-core";
import { secs } from "./workflow-utils";

// ── OSC 8 hyperlinks ──────────────────────────────

// Wrap `text` in an OSC 8 hyperlink so terminals that support it (pi's TUI does,
// as of 0.78.0) render it as clickable. Terminals that don't simply show `text`.
export function osc8(uri: string, text: string): string {
    return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// A clickable file:// link to an absolute path, displayed as `display`.
export function fileLink(absPath: string, display: string): string {
    return osc8(`file://${absPath}`, display);
}

// ── Rich agent card (single source of truth) ──────

// The 7-line agent card used by the agent-workflow extension, for both the
// idle dashboard and the live pipeline view: name · status · context-usage bar ·
// model · description. The caller supplies the resolved `model` to display
// (the per-agent model) and the agent's
// `def` (for the description and frontmatter context_window fallback). Keeping this
// in one place stops the two extensions' cards from drifting.
export function renderRichCard(opts: {
    agentKey: string;
    def: { description?: string; contextWindow?: number } | undefined;
    phases: PhaseState[];
    colWidth: number;
    theme: any;
    model: string;
    // The context-usage bar is meaningful only once an agent has run (real token
    // usage). Idle dashboards pass false to drop it — `0.0%/<window>` on an agent
    // that hasn't consumed any context is noise. Default true (live/done cards).
    showContext?: boolean;
    // When false, show the `model` string verbatim instead of the live
    // activeModel. Default true.
    useActiveModel?: boolean;
}): string[] {
    const { agentKey, def, phases, colWidth, theme, model } = opts;
    const showContext = opts.showContext ?? true;
    const key = agentKey.toLowerCase();
    const w = colWidth - 2;
    const truncate = (s: string, max: number) =>
        s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;

    const { status, elapsed, toolCount } = agentPhaseStatus(phases, agentKey);

    // "Selected" = this agent has a phase (declared/dispatched). Selected cards get
    // a status-colored border and a ▸ marker; a selected-but-pending one is "queued".
    const selected = phases.some((p) => p.agent === key);
    const queued = selected && status === "pending";

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
        marker + theme.fg("accent", theme.bold(truncate(name, w - markerVisible)));
    const nameVisible = markerVisible + Math.min(name.length, w - markerVisible);

    const timeStr = elapsed > 0 ? ` ${secs(elapsed)}` : "";
    const toolNote =
        status === "running" && toolCount > 0
            ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
            : "";
    const statusRaw = `${icon} ${word}${timeStr}${toolNote}`;
    const statusStr = theme.fg(color, truncate(statusRaw, w));
    const statusVisible = Math.min(statusRaw.length, w);

    // The phase whose live state this card reflects (running, else most recent) —
    // drives the context bar, token count, and active model.
    const own = phases.filter((p) => p.agent === key);
    const livePhase =
        own.find((p) => p.status === "running") ?? own[own.length - 1];

    const ctxWindow =
        livePhase?.tokens?.contextWindow || def?.contextWindow || 0;
    const ctxTotalTok = livePhase?.tokens
        ? (livePhase.tokens.input || 0) + (livePhase.tokens.output || 0)
        : undefined;
    const { bar: ctxBar, display: ctxDisplay } = formatContextUsage({
        contextPct: livePhase?.contextPct ?? 0,
        tokenCount: ctxTotalTok,
        contextWindow: ctxWindow || undefined,
        barLength: 5,
    });
    // Append the phase's USD cost to the usage line (where tokens already live)
    // so the card height stays constant. Always shown ($0.00 for unpriced models).
    const costSuffix = ` · ${formatCostUsd(livePhase?.tokens?.costUsd)}`;
    const ctxRaw = `[${ctxBar}] ${ctxDisplay}${costSuffix}`;
    const ctxStr = theme.fg("dim", truncate(ctxRaw, w));
    const ctxVisible = Math.min(ctxRaw.length, w);

    // The model the agent actually runs on; after a fallback the ◆ becomes ⚠.
    // When useActiveModel is false the card shows the passed `model` verbatim.
    const useActiveModel = opts.useActiveModel ?? true;
    const fellBack = useActiveModel && !!livePhase?.modelFallback;
    const effectiveModel = (useActiveModel && livePhase?.activeModel) || model;
    const modelRaw = `${fellBack ? "⚠" : "◆"} ${effectiveModel}`;
    const modelStr = theme.fg(
        fellBack ? "accent" : "muted",
        truncate(modelRaw, w),
    );
    const modelVisible = Math.min(modelRaw.length, w);

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
        ...(showContext ? [border(" " + ctxStr, 1 + ctxVisible)] : []),
        border(" " + modelStr, 1 + modelVisible),
        border(" " + descLine, 1 + descVisible),
        theme.fg(borderColor, bot),
    ];
}

// ── Grid layout ──────────────────────────────────

// Calculate column width for a grid layout.
// Returns { cols, gap, colWidth } for rendering agent cards in a grid.
export function calculateGridLayout(
    memberCount: number,
    totalWidth: number,
): { cols: number; gap: number; colWidth: number } {
    const cols = Math.min(memberCount <= 3 ? memberCount : 3, memberCount);
    const gap = 1;
    const colWidth = Math.max(
        18,
        Math.floor((totalWidth - gap * (cols - 1)) / cols),
    );
    return { cols, gap, colWidth };
}

// Render a grid of cards in rows.
// Takes an array of card renderings (each card is string[]) and lays them out
// in rows with the specified gap between columns.
export function renderCardGrid(
    cards: string[][],
    cols: number,
    gap: number,
    colWidth: number,
): string[] {
    const lines: string[] = [];
    const cardH = cards[0]?.length ?? 6;

    // Work on a copy to avoid mutating the input array
    const padded = [...cards];
    while (padded.length < cols) {
        padded.push(Array(cardH).fill(" ".repeat(colWidth)));
    }

    // Render each row
    for (let line = 0; line < cardH; line++) {
        lines.push(padded.map((c) => c[line] || "").join(" ".repeat(gap)));
    }

    return lines;
}

// ── Pipeline view layout ─────────────────────────

// Render the title line for a pipeline view.
// Shows workflow title, pass info, status badge, and optional total time.
export function renderPipelineTitle(
    phases: PhaseState[],
    running: boolean,
    lastStatus: string,
    iteration: number,
    maxLoopsRef: number,
    runElapsedMs: number,
    theme: any,
    options: {
        showTotalTime?: boolean;
    } = {},
): string[] {
    const { showTotalTime = false } = options;

    const passInfo =
        iteration > 1
            ? theme.fg("dim", `  attempt ${iteration}/${maxLoopsRef}`)
            : "";

    const doneCount = phases.filter((p) => p.status === "done").length;
    const phaseProgress = running ? ` (${doneCount}/${phases.length})` : "";

    // Use different separator for parallel vs sequential execution
    // Check if there are duplicate agent names (parallel dispatch)
    const agentNames = phases.map((p) => p.agent);
    const hasDuplicateAgents = new Set(agentNames).size < agentNames.length;

    // Check if multiple phases are running concurrently
    const runningCount = phases.filter((p) => p.status === "running").length;
    const hasConcurrentExecution = runningCount > 1;

    // Use ∥ for parallel execution (duplicates or concurrent), → for sequential
    const isParallel = hasDuplicateAgents || hasConcurrentExecution;
    const separator = isParallel ? " ∥ " : "→";

    const workflowTitle =
        phases.map((p) => p.label).join(separator) + phaseProgress;

    const totalTime =
        showTotalTime && !running && runElapsedMs > 0
            ? theme.fg("dim", `  ·  ${secs(runElapsedMs)} total`)
            : "";

    return [
        " " +
            theme.fg("accent", theme.bold(workflowTitle)) +
            passInfo +
            statusBadge(theme, running, lastStatus) +
            totalTime,
        "",
    ];
}

// Render phase cards with arrows between them.
// Returns an array of lines with cards laid out horizontally and arrows on the middle row.
// Arrows are omitted when:
// - Multiple phases are running concurrently (parallel execution)
// - Multiple phases with the same agent name have completed (parallel jobs done)
export function renderPhaseCardsWithArrows(
    cards: string[][],
    theme: any,
    phases?: PhaseState[],
): string[] {
    const arrowWidth = 5; // " ──▸ "
    const cols = cards.length;
    const arrowRow = 2; // middle row for arrows
    const cardHeight = cards[0].length;

    // Check if we should hide arrows (parallel execution or completed parallel jobs)
    let hideArrows = false;
    if (phases && phases.length > 0) {
        // Hide arrows if multiple phases are running concurrently
        const concurrentRunning =
            phases.filter((p) => p.status === "running").length > 1;

        // Hide arrows if there are duplicate agent names (parallel dispatch)
        const agentNames = phases.map((p) => p.agent);
        const hasDuplicateAgents = new Set(agentNames).size < agentNames.length;

        hideArrows = concurrentRunning || hasDuplicateAgents;
    }

    const lines: string[] = [];
    for (let line = 0; line < cardHeight; line++) {
        let row = cards[0][line];
        for (let c = 1; c < cols; c++) {
            if (hideArrows) {
                // No arrows for parallel execution - just space
                row += " ".repeat(arrowWidth);
            } else {
                // Show arrows for sequential pipeline
                row +=
                    line === arrowRow
                        ? theme.fg("dim", " ──▸ ")
                        : " ".repeat(arrowWidth);
            }
            row += cards[c][line];
        }
        lines.push(row);
    }

    return lines;
}

// ── Empty state message ──────────────────────────

// Render an empty state message when no agents are available.
export function renderEmptyAgentMessage(theme: any): string[] {
    return [
        theme.fg(
            "dim",
            " No agents in this team. Check .pi/agents/teams.yaml and .pi/agents/*.md.",
        ),
    ];
}
