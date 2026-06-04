// ABOUTME: Shared widget rendering utilities for the workflow orchestrator extensions.
// ABOUTME: Extracts the common grid layout and pipeline view logic that's identical
// ABOUTME: between agent-pipeline and agent-team. Extension-specific customizations
// ABOUTME: (card styling, model tables, dispatch badges) remain in each extension.

import type { PhaseState } from "./workflow-core";
import { displayName, statusBadge } from "./workflow-core";
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
