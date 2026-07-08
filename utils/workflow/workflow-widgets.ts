// ABOUTME: Shared widget rendering utilities for the workflow orchestrator extensions.
// ABOUTME: Extracts the common grid layout and pipeline view logic used by the
// ABOUTME: agent-workflow extension (card styling, model tables, dispatch badges).

import type { PhaseState } from "./workflow-core";
import {
    displayName,
    statusMeta,
    agentPhaseStatus,
    formatContextUsage,
    formatCostUsd,
    totalTokens,
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
    // Bind the card to ONE specific phase instead of aggregating every phase with
    // this agent name. Required for parallel dispatch of the same agent (e.g. two
    // `seeker`s at once): without it both cards resolve to the same running phase,
    // so a finished instance keeps showing "running" until the whole batch ends.
    phase?: PhaseState;
}): string[] {
    const { agentKey, def, phases, colWidth, theme, model } = opts;
    const showContext = opts.showContext ?? true;
    const key = agentKey.toLowerCase();
    const w = colWidth - 2; // inner width between the │ borders
    // Usable text width with a 1-space gutter on BOTH sides, so every line has
    // matching left/right padding (text truncated to `inner` can never fill `w`
    // and leave a 0-width right gutter).
    const inner = w - 2;
    const truncate = (s: string, max: number) =>
        s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;

    // Per-instance when a specific phase is given (parallel same-agent dispatch —
    // each running instance owns a card that flips to done independently); else
    // aggregate by agent name (idle grid, sequential single-phase).
    const inst = opts.phase;
    const { status, elapsed, toolCount } = inst
        ? { status: inst.status, elapsed: inst.elapsed, toolCount: inst.toolCount }
        : agentPhaseStatus(phases, agentKey);

    // "Selected" = this agent has a phase (declared/dispatched). Selected cards get
    // a status-colored border and a ▸ marker; a selected-but-pending one is "queued".
    const selected = inst ? true : phases.some((p) => p.agent === key);
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
        marker +
        theme.fg("accent", theme.bold(truncate(name, inner - markerVisible)));
    const nameVisible =
        markerVisible + Math.min(name.length, inner - markerVisible);

    const timeStr = elapsed > 0 ? ` ${secs(elapsed)}` : "";
    const toolNote =
        status === "running" && toolCount > 0
            ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
            : "";
    const statusRaw = `${icon} ${word}${timeStr}${toolNote}`;
    const statusStr = theme.fg(color, truncate(statusRaw, inner));
    const statusVisible = Math.min(statusRaw.length, inner);

    // The phase whose live state this card reflects (running, else most recent) —
    // drives the context bar, token count, and active model.
    const own = phases.filter((p) => p.agent === key);
    const livePhase =
        inst ?? (own.find((p) => p.status === "running") ?? own[own.length - 1]);

    const ctxWindow =
        livePhase?.tokens?.contextWindow || def?.contextWindow || 0;
    const ctxTotalTok = livePhase?.tokens
        ? totalTokens(livePhase.tokens)
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
    // Per-agent prompt-cache hit rate (cached input / all input), matching the
    // footer's CH. Appended last so a narrow card truncates it before the cost or
    // tokens. Omitted until this agent has read cache (CH 0 / no input yet).
    const tk = livePhase?.tokens;
    const chDen = (tk?.cacheRead || 0) + (tk?.input || 0);
    const chPct = chDen > 0 ? Math.round(((tk?.cacheRead || 0) / chDen) * 100) : 0;
    const chSuffix = chPct > 0 ? ` · CH ${chPct}%` : "";
    const ctxRaw = `[${ctxBar}] ${ctxDisplay}${costSuffix}${chSuffix}`;
    const ctxStr = theme.fg("dim", truncate(ctxRaw, inner));
    const ctxVisible = Math.min(ctxRaw.length, inner);

    // The model the agent actually runs on; after a fallback the ◆ becomes ⚠.
    // When useActiveModel is false the card shows the passed `model` verbatim.
    const useActiveModel = opts.useActiveModel ?? true;
    const fellBack = useActiveModel && !!livePhase?.modelFallback;
    const effectiveModel = (useActiveModel && livePhase?.activeModel) || model;
    const modelRaw = `${fellBack ? "⚠" : "◆"} ${effectiveModel}`;
    const modelStr = theme.fg(
        fellBack ? "accent" : "muted",
        truncate(modelRaw, inner),
    );
    const modelVisible = Math.min(modelRaw.length, inner);

    const descRaw = (def?.description || "—").split("—")[0].trim() || "—";
    const descText = truncate(descRaw, inner);
    const descLine = theme.fg("dim", descText);
    const descVisible = Math.min(descText.length, inner);

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

// Card width bounds. MAX keeps a lone card from stretching across a wide terminal
// (sized to fit the `◆ provider/model` line + borders); MIN lets the grid pack
// more columns so all agents fit in as FEW ROWS as possible — important because
// pi caps the dashboard widget's height and truncates extra rows ("widget
// truncated"). Narrower cards truncate the model string but keep every agent
// visible.
export const MAX_CARD_WIDTH = 50;
export const MIN_CARD_WIDTH = 32;

// Calculate column width for a grid layout.
// Returns { cols, gap, colWidth } for rendering agent cards in a grid.
// Pack as many columns as fit at MIN width (fewest rows), then widen each column
// up to MAX so a small roster still gets roomy cards. Left-aligned.
export function calculateGridLayout(
    memberCount: number,
    totalWidth: number,
): { cols: number; gap: number; colWidth: number } {
    const gap = 1;
    // Most columns that fit if cards shrink to MIN width — lets all members land
    // on one row when the terminal is wide enough.
    const maxFit = Math.max(
        1,
        Math.floor((totalWidth + gap) / (MIN_CARD_WIDTH + gap)),
    );
    const cols = Math.max(1, Math.min(memberCount, maxFit));
    const colWidth = Math.min(
        MAX_CARD_WIDTH,
        Math.max(MIN_CARD_WIDTH, Math.floor((totalWidth - gap * (cols - 1)) / cols)),
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
    const arrowWidth = 3; // "-->"
    const cols = cards.length;
    const cardHeight = cards[0].length;
    const arrowRow = Math.floor(cardHeight / 2); // vertical center of the card

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
                        ? theme.fg("dim", "-->")
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

// ── Live Todos panel ─────────────────────────────

// The implementer's phase checklist (from .agent/progress.md), rendered as a live
// todo list under the pipeline cards:
//   [x] done   [•] in-progress (the first unfinished phase while a run is active)
//   [ ] pending
// Returns [] when there are no items, so the caller can omit the section entirely.
export function renderTodos(
    items: { label: string; done: boolean }[],
    theme: any,
    opts: { running?: boolean; width?: number; title?: string } = {},
): string[] {
    if (!items || items.length === 0) return [];
    const max = Math.max(10, (opts.width ?? 80) - 6);
    const clip = (s: string) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
    const firstPending = items.findIndex((i) => !i.done);
    const lines: string[] = [
        theme.fg("accent", theme.bold(opts.title ?? " # Todos")),
    ];
    items.forEach((it, idx) => {
        const inProgress = !!opts.running && !it.done && idx === firstPending;
        const mark = it.done ? "[x]" : inProgress ? "[•]" : "[ ]";
        const color = it.done ? "dim" : inProgress ? "accent" : "muted";
        lines.push(
            ` ${theme.fg(color, mark)} ${theme.fg(color, clip(it.label))}`,
        );
    });
    return lines;
}

export interface LspServerInfo {
    server: string;
    extensions: string[];
    installed: boolean;
    candidates?: string[];
}

// Panel listing the language servers relevant to the project's files, each with an
// install marker (✓ ready / ○ missing) and the extensions it covers here. Empty []
// when nothing is relevant, so the caller can skip the section entirely.
export function renderLspServers(
    servers: LspServerInfo[],
    theme: any,
): string[] {
    if (!servers || servers.length === 0) return [];
    const lines: string[] = [theme.fg("accent", theme.bold(" LSP Servers"))];
    for (const s of servers) {
        const mark = s.installed
            ? theme.fg("success", "✓")
            : theme.fg("dim", "○");
        const name = theme.fg(s.installed ? "muted" : "dim", s.server);
        const exts = theme.fg("dim", s.extensions.join(" "));
        const note = s.installed ? "" : theme.fg("dim", "  not installed");
        lines.push(` ${mark} ${name}  ${exts}${note}`);
    }
    return lines;
}
