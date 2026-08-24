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
        // Trust the per-turn context percent, exactly as the footer does. Without
        // this the card fell through to `tokenCount / contextWindow`, where
        // tokenCount is the phase's CUMULATIVE usage across every turn — so a
        // planner whose context peaked at 15.5% displayed 97.0%/256K (248K
        // cumulative / 256K window) and a refiner at 11.7% displayed 100.0%
        // (434K clamped). The bar read "about to overflow" with the window
        // one-seventh full, which is the opposite of the decision it informs.
        preferContextPct: true,
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
//   [x] done   [•] in-progress   [ ] pending
//
// A wave can run SEVERAL phases at once (the implementer batches provably
// independent ones through dispatch_parallel), so `inProgress` says how many of the
// unfinished phases are actually in flight and that many get the [•] mark. Marking
// only the first made a parallel wave look serial: two workers building phases 1
// and 2 showed phase 1 running and phase 2 pending, which misreads the run's
// concurrency and hides where the time is going.
//   [ ] pending
// Returns [] when there are no items, so the caller can omit the section entirely.
// The ledger records a finished phase as `Phase N: <title> — tests: <command> (sha …)`.
// That evidence belongs in the file — the validator and a human reading back the run
// both want it — but in a fixed-width panel it crowds out the only part that
// identifies the row, so an 80-column terminal ends up showing a clipped shell
// command instead of the phase title. Drop it for DISPLAY only.
export function phaseTitleOnly(label: string): string {
    return label.replace(/\s+[—-]\s+tests:.*$/i, "").trim() || label.trim();
}

export interface StatusWidgetInput {
    /** Active team, or "" when idle. */
    team: string;
    phases: PhaseState[];
    running: boolean;
    lastStatus: string;
    iteration: number;
    maxLoops: number;
    elapsedMs: number;
    costUsd: number;
    /** 0-100, the run's context usage. */
    contextPct: number;
    contextWindow?: number;
    /** Prompt-cache hit rate, 0-100. Omitted when nothing has been cached. */
    cacheHitPct?: number;
    todos?: { done: number; total: number };
    review?: { done: number; total: number };
    /** One line of "what is happening right now" (last tool, current step). */
    activity?: string;
    dispatchMode?: boolean;
    /** Agents known, for the idle line. */
    agentCount?: number;
    teamCount?: number;
    width: number;
}

/** Hard ceiling. pi budgets extension widgets at MAX_WIDGET_LINES = 10; staying
 *  well inside it is the entire point of this view. */
export const STATUS_WIDGET_MAX_LINES = 6;

/**
 * The sticky dashboard, as a STATUS LINE rather than a dashboard.
 *
 * The previous widget rendered a five-card grid, per-agent context bars, a todo
 * ledger, a review checklist and a live log -- about 40 rows, four times pi's
 * budget for an extension widget. A sticky region that large competes with the
 * renderer for the screen: it has to be height-managed, it pushes the transcript
 * around, and rows a previous frame left behind stay visible. Every rendering
 * problem this dashboard has had came from that size.
 *
 * The detail did not need to be here. `obs/ui` already shows runs, live agents,
 * analytics and history, with scrolling and history a sticky region cannot have,
 * and pi already streams each sub-agent's tool trail into the transcript. What a
 * terminal status line is for is answering "is it moving, where is it, what is it
 * costing" at a glance -- which fits in four lines.
 *
 * Every line is truncated to `width`; nothing here can wrap.
 */
const modelRaw = (p: PhaseState): string => (p.activeModel ? `  ◆ ${p.activeModel}` : "");

export function renderStatusWidget(input: StatusWidgetInput, theme: any): string[] {
    const w = Math.max(20, input.width);
    const out: string[] = [];

    // Assemble each line from RAW segments and style only what fits. Truncating a
    // styled string means slicing through ANSI escapes; budgeting the raw text
    // first and colouring after cannot produce a broken sequence, and cannot
    // produce a line wider than `w` -- which is what wraps and drifts the render.
    type Seg = [text: string, color?: string, bold?: boolean];
    const line = (segs: Seg[]): string => {
        let used = 0;
        let s = "";
        for (const [text, color, bold] of segs) {
            if (used >= w) break;
            const room = w - used;
            const raw = text.length > room ? text.slice(0, Math.max(0, room - 1)) + "…" : text;
            used += raw.length;
            const styled = bold ? theme.bold(raw) : raw;
            s += color ? theme.fg(color, styled) : styled;
        }
        return s;
    };

    // ── idle ────────────────────────────────────────────────────────────────
    if (input.phases.length === 0 && !input.dispatchMode) {
        const agents = input.agentCount ?? 0;
        const teams = input.teamCount ?? 0;
        out.push(
            line([
                [" "],
                ["agent-workflow", "accent", true],
                [
                    ` · ${agents} agent${agents === 1 ? "" : "s"}` +
                        (teams ? ` · ${teams} team${teams === 1 ? "" : "s"}` : ""),
                    "dim",
                ],
            ]),
        );
        out.push(line([["   /agent-workflow <request>   ·   dashboard: PI_OBS=1", "muted"]]));
        return out;
    }

    // ── header: where the run is, and what it has cost ──────────────────────
    const done = input.phases.filter((p) => p.status === "done").length;
    const active = input.phases.filter((p) => p.status === "running");
    const here = active[0]?.label ?? input.phases[done]?.label ?? "";
    const label = input.dispatchMode ? "dispatch" : input.team || "agent-workflow";
    const pos = input.dispatchMode ? "" : ` ${done}/${input.phases.length}`;

    const bits: string[] = [];
    if (input.elapsedMs > 0) bits.push(secs(input.elapsedMs));
    bits.push(formatCostUsd(input.costUsd));
    if (input.contextPct > 0) {
        const win = input.contextWindow
            ? `/${Math.round(input.contextWindow / 1000)}K`
            : "";
        bits.push(`${input.contextPct.toFixed(1)}%${win}`);
    }
    if (input.cacheHitPct && input.cacheHitPct > 0) bits.push(`CH ${Math.round(input.cacheHitPct)}%`);

    const attemptRaw =
        input.iteration > 1 ? ` · attempt ${input.iteration}/${input.maxLoops}` : "";
    const { icon, color } = statusMeta(
        input.running ? "running" : input.phases.every((p) => p.status === "done") ? "done" : "pending",
    );
    out.push(
        line([
            [" "],
            [label, "accent", true],
            [here ? ` ▸ ${here}${pos}` : pos, "muted"],
            [bits.length ? ` · ${bits.join(" · ")}` : "", "dim"],
            [attemptRaw, "dim"],
            [` ${icon}`, color],
        ]),
    );

    // ── the agent(s) actually working ───────────────────────────────────────
    // Parallel waves get one line each, capped so the widget cannot grow past
    // its budget; the overflow is counted rather than listed.
    const ROOM = STATUS_WIDGET_MAX_LINES - 3; // header + summary + activity
    const shown = active.slice(0, Math.max(1, ROOM));
    for (const p of shown) {
        const meta = statusMeta(p.status);
        const tools = p.toolCount > 0 ? ` · ${p.toolCount} tool${p.toolCount === 1 ? "" : "s"}` : "";

        out.push(
            line([
                [" "],
                ["▸ ", meta.color],
                [displayName(p.agent), "accent"],
                [`  ${meta.icon} ${p.status} ${secs(p.elapsed)}${tools}`, meta.color],
                [modelRaw(p), "dim"],
            ]),
        );
    }
    if (active.length > shown.length) {
        out.push(line([[`   +${active.length - shown.length} more running`, "dim"]]));
    }

    // ── ledger summary: counts, not the ledgers themselves ──────────────────
    const summary: string[] = [];
    if (input.todos && input.todos.total > 0) {
        summary.push(`todos ${input.todos.done}/${input.todos.total}`);
    }
    if (input.review && input.review.total > 0) {
        summary.push(`review ${input.review.done}/${input.review.total}`);
    }
    if (summary.length) out.push(line([["   " + summary.join(" · "), "muted"]]));

    // ── what it is doing this second ────────────────────────────────────────
    if (input.activity) out.push(line([["   " + input.activity.trim(), "dim"]]));

    return out.slice(0, STATUS_WIDGET_MAX_LINES);
}

/** Mutable clock for {@link shouldRepaint}. */
export interface RepaintPulseState {
    last: number;
}

/**
 * Should this widget build emit the short "pulse" frame?
 *
 * pi re-renders only a live region; rows a previous live region left behind are
 * cleared ONLY by an absolute repaint, which pi reaches solely via
 * `clearOnShrink` -- i.e. when the composed frame gets SHORTER. A dashboard of
 * stable height never shrinks, so upstream emits zero absolute clears for an
 * entire session and stale rows persist until restart.
 *
 * Returning true tells the caller to drop a trailing spacer row, making the frame
 * one row shorter so pi's own clearOnShrink fires. Timed rather than every-N-builds
 * so the repaint cadence does not depend on how busy the run is.
 *
 * The first call seeds the clock and never pulses: there is nothing stale to clear
 * on the first frame, and repainting then is just a visible flash.
 */
export function shouldRepaint(
    state: RepaintPulseState,
    now: number,
    intervalMs: number,
): boolean {
    if (intervalMs <= 0) return false;
    if (state.last === 0) {
        state.last = now;
        return false;
    }
    if (now - state.last < intervalMs) return false;
    state.last = now;
    return true;
}

export function renderTodos(
    items: { label: string; done: boolean }[],
    theme: any,
    opts: {
        running?: boolean;
        width?: number;
        title?: string;
        // How many unfinished phases are executing right now. Defaults to 1 so a
        // caller that cannot count workers keeps the old single-marker behaviour;
        // 0 while running also means 1, because the coordinator is between waves
        // and the next phase is what it is about to start.
        inProgress?: number;
        // Text to show INSTEAD of returning nothing when there are no items yet.
        // The Todos block otherwise pops into existence the instant the ledger is
        // written, and that growth is what pi-tui's differential renderer can
        // strand a row on (it only force-clears on shrink). Reserving the rows up
        // front keeps the block's height steady. Omit it and the empty case still
        // returns [] — the Review panel relies on that to splice unconditionally.
        placeholder?: string;
    } = {},
): string[] {
    if (!items || items.length === 0) {
        if (!opts.placeholder) return [];
        return [
            theme.fg("accent", theme.bold(opts.title ?? " # Todos")),
            ` ${theme.fg("muted", opts.placeholder)}`,
        ];
    }
    const max = Math.max(10, (opts.width ?? 80) - 6);
    const clip = (s: string) => {
        const t = phaseTitleOnly(s);
        return t.length > max ? t.slice(0, max - 1) + "…" : t;
    };
    const active = Math.max(1, opts.inProgress ?? 1);
    // The [•] rows are the first `active` UNFINISHED phases — a completed phase
    // never carries the mark, and a wave never marks more rows than remain.
    const inFlight = new Set(
        items
            .map((it, i) => (it.done ? -1 : i))
            .filter((i) => i >= 0)
            .slice(0, active),
    );
    const lines: string[] = [
        theme.fg("accent", theme.bold(opts.title ?? " # Todos")),
    ];
    items.forEach((it, idx) => {
        const inProgress = !!opts.running && !it.done && inFlight.has(idx);
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
