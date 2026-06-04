// ABOUTME: Shared, stateless core for the workflow orchestrator extensions
// ABOUTME: (agent-pipeline.ts and agent-team.ts). Holds the identical types,
// ABOUTME: constants, agent/team/.env loaders, prompt templates, and the pure
// ABOUTME: card-rendering helpers (statusMeta, statusBadge, agentPhaseStatus,
// ABOUTME: renderCard) so the two extensions don't duplicate them. Stateful
// ABOUTME: orchestration and the model-aware grid card stay in each extension.
//
// Lives in .pi/utils/ (not .pi/extensions/) so pi does not try to auto-load it
// as an extension — it has no default export and is imported, like
// ./workflow-utils.

import { spawn } from "child_process";
import { homedir } from "os";
import {
    readFileSync,
    existsSync,
    readdirSync,
    mkdirSync,
    unlinkSync,
    statSync,
    openSync,
    readSync,
    closeSync,
} from "fs";
import { join, basename, dirname, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import {
    secs,
    isModelFailure,
    digest,
    testSignal,
    outcomeLine,
} from "./workflow-utils";

// ── Config ───────────────────────────────────────

export const REQUIRED_AGENTS = [
    "planner",
    "critic",
    "implementer",
    "tester",
    "documenter",
    "validator",
    "shipper",
] as const;
export const DEFAULT_MAX_LOOPS = 3;

export const LOG_PANEL_RESERVE = 10; // rows kept clear below the live panel for the editor + footer
export const LOG_CAP_CHARS = 16000; // bound the stored per-phase log
export const STDERR_TAIL_CAP = 2000; // bound the captured stderr tail used in failure reports

// Custom message types + size cap for the inline report and activity-log cards.
export const WORKFLOW_REPORT_TYPE = "workflow-report";
export const WORKFLOW_REPORT_MAX = 50000; // max chars to render inline (markdown is long)
export const WORKFLOW_LOG_TYPE = "workflow-log";

// ── Types ────────────────────────────────────────

export interface AgentDef {
    name: string;
    description: string;
    tools: string;
    model: string;
    contextWindow: number; // 0 when not declared in frontmatter
    systemPrompt: string;
    aliases?: string[]; // alternate names the agent can be dispatched as
}

export interface PhaseState {
    label: string;
    agent: string;
    dispatchId?: string; // unique ID for parallel dispatches of the same agent
    status: "pending" | "running" | "done" | "error";
    elapsed: number;
    note: string; // last non-empty line (for the card)
    log: string; // rolling tail of the agent's streamed output (for the live panel)
    droppedLines: number; // count of malformed JSON lines dropped during this phase
    toolCount: number; // tool calls observed during this phase (live activity signal)
    contextPct: number; // context window usage percentage (0-100) from the agent's last message
    attempt: number; // how many times this phase has been run (incremented on retry loops)
    modelFallback: boolean; // true if the phase retried with the fallback model after the primary model failed
    activeModel?: string; // the model the agent is actually running on (set at spawn; reflects fallback)
    tokens?: TokenUsage; // per-phase token usage captured from the agent's message_end event
}

// ── Active-workflow detection ────────────────────
// Both agent-pipeline.ts and agent-team.ts may auto-load from .pi/extensions/ at
// once; only one renders the dashboard/footer. The one launched with -e wins;
// with no explicit choice, the base "agent-pipeline" is the default. These helpers are
// shared but parameterized over each extension's own identity (its module URL,
// filename, and SELF_NAME) since `import.meta.url` is per-module.

// True only when pi was started with this extension via -e/--extension (not when
// it was auto-discovered). `selfUrl` is the caller's import.meta.url.
export function loadedExplicitly(
    selfUrl: string,
    fallbackBase: string,
): boolean {
    let self = "";
    try {
        self = fileURLToPath(selfUrl);
    } catch {}
    const selfBase = self ? basename(self) : fallbackBase;
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        let val: string | null = null;
        if (a === "-e" || a === "--extension") val = argv[i + 1] ?? "";
        else if (a.startsWith("--extension="))
            val = a.slice("--extension=".length);
        else if (a.startsWith("-e=")) val = a.slice("-e=".length);
        if (!val) continue;
        if (basename(val) === selfBase) return true;
        try {
            if (self && resolvePath(val) === self) return true;
        } catch {}
    }
    return false;
}

// Which workflow extension the user explicitly selected via -e, or null.
export function selectedWorkflowExtension(): string | null {
    const argv = process.argv;
    const nameOf = (v: string) => basename(v).replace(/\.[^.]+$/, "");
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        let val: string | null = null;
        if (a === "-e" || a === "--extension") val = argv[i + 1] ?? "";
        else if (a.startsWith("--extension="))
            val = a.slice("--extension=".length);
        else if (a.startsWith("-e=")) val = a.slice("-e=".length);
        if (!val) continue;
        const n = nameOf(val);
        if (n === "agent-pipeline" || n === "agent-team") return n;
    }
    return null;
}

// Whether the extension with the given SELF_NAME owns the on-screen chrome.
export function isActiveWorkflow(selfName: string): boolean {
    const sel = selectedWorkflowExtension();
    return sel ? sel === selfName : selfName === "agent-pipeline";
}

// ── .env loader ──────────────────────────────────

// Whitelist of env vars that project-level .env files are allowed to override.
// Security-sensitive operational settings are locked to the global config.
// PI_AGENT_*_MODEL vars are also allowed (dynamic per-agent model overrides).
const PROJECT_ENV_WHITELIST = new Set([
    "PI_WORKFLOW_MODEL",
    "PI_WORKFLOW_MAX_LOOPS",
]);

// Check if an env var key is allowed in project-level .env overrides.
// Matches the static whitelist plus any PI_AGENT_<NAME>_MODEL pattern.
function isEnvAllowed(key: string): boolean {
    if (PROJECT_ENV_WHITELIST.has(key)) return true;
    return /^PI_AGENT_.+_MODEL$/.test(key);
}

// Load KEY=VALUE pairs from a `.env` file into process.env WITHOUT overwriting
// values already set in the real environment (so the shell still wins). Lets you
// keep PI_WORKFLOW_MODEL / PI_AGENT_*_MODEL in a file instead of exporting them
// in every shell — handy when pi is launched from an IDE/GUI.
export function loadDotEnv(cwd: string): void {
    // First, load from the config directory (global defaults). The primary
    // location is THIS repo's own root, resolved relative to this source file
    // (utils/workflow-core.ts -> repo root) so the bundled `.env` is found wherever
    // the folder is copied — no hardcoded path. `~/.config/pi` and `~/.pi` remain as
    // optional machine-level fallbacks.
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
    const possibleConfigDirs = [
        repoRoot,
        join(homedir(), ".config", "pi"),
        join(homedir(), ".pi"),
    ];

    for (const configDir of possibleConfigDirs) {
        const configPath = join(configDir, ".env");
        if (existsSync(configPath)) {
            loadEnvFile(configPath, false, false); // Don't override existing env vars
            break; // Use the first one we find
        }
    }

    // Then, load from cwd (project-specific overrides)
    // Only whitelisted vars can be overridden by project-level config
    const cwdPath = join(cwd, ".env");
    if (existsSync(cwdPath)) {
        loadEnvFile(cwdPath, true, true); // Allow overrides for whitelisted vars only
    }
}

function loadEnvFile(
    path: string,
    allowOverride: boolean,
    applyWhitelist: boolean,
): void {
    try {
        for (const raw of readFileSync(path, "utf-8").split("\n")) {
            let line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            if (line.startsWith("export ")) line = line.slice(7).trim();
            const eq = line.indexOf("=");
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            let val = line.slice(eq + 1).trim();
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }

            // Apply whitelist for project-level overrides
            if (applyWhitelist && !isEnvAllowed(key)) {
                continue;
            }

            if (allowOverride || !(key in process.env)) {
                process.env[key] = val;
            }
        }
    } catch {
        // Silently ignore errors loading .env files
    }
}

// ── Display helpers ──────────────────────────────

// "implementer" -> "Implementer", "code-review" -> "Code Review"
export function displayName(name: string): string {
    return name
        .split(/[-\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

// ── Card rendering (pure) ────────────────────────
// Status icon + theme colour for a phase status. `theme` is pi's theme object
// (kept `any` so the core has no UI-type dependency).

export function statusMeta(status: PhaseState["status"]): {
    icon: string;
    color: string;
} {
    switch (status) {
        case "running":
            return { icon: "●", color: "accent" };
        case "done":
            return { icon: "✓", color: "success" };
        case "error":
            return { icon: "✗", color: "error" };
        default:
            return { icon: "○", color: "dim" };
    }
}

// Derive a card status for an agent from the phases that use it. (An agent may
// back more than one phase — e.g. the validator gates and ships.)
export function agentPhaseStatus(
    phases: PhaseState[],
    agentKey: string,
): { status: PhaseState["status"]; elapsed: number; toolCount: number } {
    const own = phases.filter((p) => p.agent === agentKey.toLowerCase());
    if (own.length === 0)
        return { status: "pending", elapsed: 0, toolCount: 0 };
    const running = own.find((p) => p.status === "running");
    if (running)
        return {
            status: "running",
            elapsed: running.elapsed,
            toolCount: running.toolCount,
        };
    if (own.some((p) => p.status === "error")) {
        const errorPhase = own.find((p) => p.status === "error");
        return {
            status: "error",
            elapsed: errorPhase?.elapsed ?? 0,
            toolCount: errorPhase?.toolCount ?? 0,
        };
    }
    const done = own.filter((p) => p.status === "done");
    if (done.length)
        return {
            status: "done",
            elapsed: done.reduce((s, p) => s + p.elapsed, 0),
            toolCount: done.reduce((s, p) => s + p.toolCount, 0),
        };
    return { status: "pending", elapsed: 0, toolCount: 0 };
}

// Overall status badge shown next to the title. `running` and `lastStatus` come
// from the extension's live run state.
export function statusBadge(
    theme: any,
    running: boolean,
    lastStatus: string,
): string {
    if (running)
        return theme.fg("dim", "  ·  ") + theme.fg("accent", "● running");
    switch (lastStatus) {
        case "shipped":
            return theme.fg("dim", "  ·  ") + theme.fg("success", "✓ shipped");
        case "paused-no-remote":
            return (
                theme.fg("dim", "  ·  ") +
                theme.fg("accent", "‖ paused (no remote)")
            );
        case "failed-after-retries":
            return theme.fg("dim", "  ·  ") + theme.fg("error", "✗ failed");
        case "needs-review":
            return (
                theme.fg("dim", "  ·  ") + theme.fg("error", "✗ needs review")
            );
        case "error":
            return theme.fg("dim", "  ·  ") + theme.fg("error", "✗ error");
        default:
            return "";
    }
}

// One pipeline phase card: name · status · context bar. Pure — derives everything
// from the phase. The card deliberately omits a log snippet (the live activity
// panel below the cards carries that), so cards stay compact.
// `showContext` (default true) draws the per-phase context-usage bar. The
// single-model agent-pipeline passes false — every phase shares the primary
// session's model and context, so a per-card bar is redundant there.
export function renderCard(
    phase: PhaseState,
    colWidth: number,
    theme: any,
    showContext = true,
    fallbackContextWindow?: number,
): string[] {
    const w = colWidth - 2;
    const truncate = (s: string, max: number) =>
        s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;

    const { icon, color } = statusMeta(phase.status);

    const name = phase.label;
    const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
    const nameVisible = Math.min(name.length, w);

    const word =
        phase.status === "pending" ? displayName(phase.agent) : phase.status;
    const timeStr = phase.elapsed > 0 ? ` ${secs(phase.elapsed)}` : "";
    // While running, surface the live tool-call count as an activity signal.
    const toolNote =
        phase.status === "running" && phase.toolCount > 0
            ? ` · ${phase.toolCount} tool${phase.toolCount === 1 ? "" : "s"}`
            : "";
    const attemptNote = phase.attempt > 1 ? ` · attempt ${phase.attempt}` : "";
    const statusRaw = `${icon} ${word}${timeStr}${toolNote}${attemptNote}`;
    const statusStr = theme.fg(color, truncate(statusRaw, w));
    const statusVisible = Math.min(statusRaw.length, w);

    // Context usage bar: 5 blocks + percent + context window + token count.
    const ctxWindow = phase.tokens?.contextWindow || fallbackContextWindow || 0;
    const showCtx = showContext && (phase.contextPct > 0 || ctxWindow > 0);
    const ctxLine = showCtx
        ? (() => {
              const totalTok =
                  (phase.tokens?.input || 0) + (phase.tokens?.output || 0);
              const { bar, display } = formatContextUsage({
                  contextPct: phase.contextPct,
                  tokenCount: totalTok || undefined,
                  contextWindow: ctxWindow || undefined,
                  barLength: 5,
              });
              const ctxStr = `[${bar}] ${display}`;
              return theme.fg("dim", ctxStr);
          })()
        : null;
    const ctxVisible = ctxLine
        ? Math.min(`[#####] 00.0%/0.0M · 99.9M`.length, w)
        : 0;

    const top = "┌" + "─".repeat(w) + "┐";
    const bot = "└" + "─".repeat(w) + "┘";
    const border = (content: string, visLen: number) =>
        theme.fg("dim", "│") +
        content +
        " ".repeat(Math.max(0, w - visLen)) +
        theme.fg("dim", "│");

    const lines = [
        theme.fg("dim", top),
        border(" " + nameStr, 1 + nameVisible),
        border(" " + statusStr, 1 + statusVisible),
    ];
    if (ctxLine) lines.push(border(" " + ctxLine, 1 + ctxVisible));
    lines.push(theme.fg("dim", bot));
    return lines;
}

// Append the live log of the currently running agent to `lines`. Rendered at a
// STABLE height (padded with blanks) for the whole run so the widget never
// shrinks between frames — a shrinking widget leaves stale rows ghosting behind
// the new one. `visibleWidth` is injected to keep this module pi-tui-free.
export function appendLiveLog(
    lines: string[],
    width: number,
    theme: any,
    phases: PhaseState[],
    running: boolean,
    visibleWidth: (s: string) => number,
): void {
    const active = phases.find((p) => p.status === "running");
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
    // Hard bound so the editor + footer always stay on screen: never taller than
    // half the terminal, and always leaving room below.
    const maxLogRows = Math.max(
        3,
        Math.min(Math.floor(rows / 2), rows - lines.length - LOG_PANEL_RESERVE),
    );
    const colW = width - 4;
    // Reserve the first panel row for the "earlier lines" notice (blank when not
    // needed) so the panel height is constant.
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

// Render the footer line: "◆ <model> · <self> <status>      [bar] <pct>". Shared
// by both extensions — they differ only in self-name and how the model string is
// derived, so those are passed in. pi-tui helpers are injected (core stays
// pi-tui-free). `contextUsage` returns the primary session's usage (or undefined).
export function renderWorkflowFooter(opts: {
    width: number;
    theme: any;
    selfName: string;
    model: string;
    running: boolean;
    lastStatus: string;
    iteration: number;
    maxLoopsRef: number;
    dispatchMode: boolean;
    phases: PhaseState[];
    dispatchElapsedMs: number;
    runElapsedMs: number;
    contextUsage: () => any;
    visibleWidth: (s: string) => number;
    truncateToWidth: (s: string, w: number) => string;
}): string[] {
    const {
        width,
        theme,
        selfName,
        model,
        running,
        lastStatus,
        iteration,
        maxLoopsRef,
        dispatchMode,
        phases,
        dispatchElapsedMs,
        runElapsedMs,
        contextUsage,
        visibleWidth,
        truncateToWidth,
    } = opts;

    // Context usage: show a sub-agent's context only when exactly ONE is running —
    // a single bar can't represent several parallel agents, so fall back to the
    // primary session's context when more than one runs at once.
    const runningPhases = phases.filter((p) => p.status === "running");
    const activePhase =
        runningPhases.length === 1 ? runningPhases[0] : undefined;
    let contextPct: number | null;
    let tokenCount: number | undefined;
    let contextWindow: number | undefined;

    if (activePhase && activePhase.contextPct > 0) {
        // Sub-agent is running - show its context usage
        contextPct = activePhase.contextPct;
        tokenCount = activePhase.tokens
            ? (activePhase.tokens.input || 0) +
                  (activePhase.tokens.output || 0) || undefined
            : undefined;
        contextWindow = activePhase.tokens?.contextWindow || undefined;
    } else {
        // No active sub-agent - show primary session's context
        let usage: any;
        try {
            usage = contextUsage();
        } catch {}
        contextPct =
            usage &&
            typeof usage.percent === "number" &&
            !Number.isNaN(usage.percent)
                ? usage.percent
                : null;
        tokenCount =
            usage && typeof usage.tokens === "number" && usage.tokens > 0
                ? usage.tokens
                : undefined;
        contextWindow =
            usage && typeof usage.contextWindow === "number"
                ? usage.contextWindow
                : usage && typeof usage.context_window === "number"
                  ? usage.context_window
                  : undefined;
    }

    const { bar, display: pctStr } = formatContextUsage({
        contextPct,
        tokenCount,
        contextWindow,
        barLength: 10,
    });

    // Ad-hoc dispatch doesn't set `running`, so derive its state from the phases
    // (otherwise the footer reads "idle" while a dispatched agent is working).
    const dispatchRunning = dispatchMode && runningPhases.length > 0;
    const dispatchDone = dispatchMode && phases.length > 0 && !dispatchRunning;
    // Show ALL running sub-agents (parallel dispatch runs several at once), joined
    // with the same ∥ the dashboard uses; a single running agent reads as just its
    // name. Cap the list so the footer can't be overrun, with a "+N" overflow.
    const runningLabels = runningPhases.map((p) => p.label);
    const MAX_FOOTER_AGENTS = 4;
    const activeName = runningLabels.length
        ? runningLabels.length > MAX_FOOTER_AGENTS
            ? `${runningLabels.slice(0, MAX_FOOTER_AGENTS).join(" ∥ ")} +${runningLabels.length - MAX_FOOTER_AGENTS}`
            : runningLabels.join(" ∥ ")
        : undefined;
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

    const left =
        theme.fg("dim", ` ◆ ${model}`) +
        theme.fg("muted", " · ") +
        theme.fg("accent", selfName) +
        theme.fg("dim", " ") +
        theme.fg(statusColor, statusText);
    const right = theme.fg("dim", `[${bar}] ${pctStr} `);
    const pad = " ".repeat(
        Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
    );
    return [truncateToWidth(left + pad + right, width)];
}

// ── Shared tool renderers ───────────────────────

// Render the dispatch_agent tool call in the conversation. Identical between
// both extensions — extracted to eliminate ~15 lines of pure duplication.
export function renderDispatchAgentCall(
    args: any,
    theme: any,
    TextCtor: any,
): any {
    const agentName = args.agent || "?";
    const task = args.task || "";
    const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
    return new TextCtor(
        theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
            theme.fg("accent", agentName) +
            theme.fg("dim", " — ") +
            theme.fg("muted", preview),
        0,
        0,
    );
}

// Render the dispatch_agent tool result. Identical between both extensions —
// extracted to eliminate ~40 lines of pure duplication.
export function renderDispatchAgentResult(
    result: any,
    options: any,
    theme: any,
    TextCtor: any,
    MarkdownCtor: any,
    mdTheme: any,
): any {
    const details = result.details as any;
    if (!details) {
        const t = result.content[0];
        return new TextCtor(t?.type === "text" ? t.text : "", 0, 0);
    }
    if (options.isPartial) {
        return new TextCtor(
            theme.fg("accent", `● ${details.agent || "?"}`) +
                theme.fg("dim", " working..."),
            0,
            0,
        );
    }
    const icon = details.status === "done" ? "✓" : "✗";
    const color = details.status === "done" ? "success" : "error";
    const elapsed =
        typeof details.elapsed === "number" ? secs(details.elapsed) : "0s";
    const header =
        theme.fg(color, `${icon} ${details.agent}`) +
        theme.fg("dim", ` ${elapsed}`);
    if (options.expanded && details.fullOutput) {
        const output =
            details.fullOutput.length > 4000
                ? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
                : details.fullOutput;
        return new MarkdownCtor(header + "\n\n" + output, 1, 0, mdTheme);
    }
    if (details.status === "error" && details.fullOutput) {
        const errSnippet = details.fullOutput
            .split("\n")
            .filter((l: string) => l.trim())
            .slice(-3)
            .join(" ")
            .slice(0, 200);
        return new TextCtor(
            header + theme.fg("error", `\n${errSnippet}`),
            0,
            0,
        );
    }
    return new TextCtor(header, 0, 0);
}

// Render the run_agent_{pipeline,team} tool call. Parameterized over the tool
// name string — the only difference between extensions.
export function renderRunWorkflowCall(
    toolName: string,
    args: any,
    theme: any,
    activeMembers: () => string[],
    TextCtor: any,
): any {
    const req = args.request || "";
    const preview = req.length > 56 ? req.slice(0, 53) + "..." : req;
    const members = activeMembers();
    const flow = [
        ...(members.some((m) => m.toLowerCase() === "scout") ? ["Scout"] : []),
        "Plan",
        "Critique",
        "Implement",
        "Test",
        "Validate",
        "Document",
        "Ship",
    ].join("→");
    return new TextCtor(
        theme.fg("toolTitle", theme.bold(`${toolName} `)) +
            theme.fg("accent", flow) +
            theme.fg("dim", " — ") +
            theme.fg("muted", preview),
        0,
        0,
    );
}

// Render the run_agent_{pipeline,team} tool result. Parameterized over the
// extension name string — the only difference between extensions.
export function renderRunWorkflowResult(
    extName: string,
    result: any,
    options: any,
    theme: any,
    TextCtor: any,
    MarkdownCtor: any,
    mdTheme: any,
    reportMaxChars: number,
): any {
    const details = result.details as any;
    if (!details) {
        const t = result.content[0];
        return new TextCtor(t?.type === "text" ? t.text : "", 0, 0);
    }
    if (options.isPartial) {
        return new TextCtor(
            theme.fg("accent", `● ${extName}`) + theme.fg("dim", " running..."),
            0,
            0,
        );
    }
    const meta: Record<string, { icon: string; color: string }> = {
        shipped: { icon: "✓", color: "success" },
        "paused-no-remote": { icon: "‖", color: "accent" },
        "failed-after-retries": { icon: "✗", color: "error" },
        "needs-review": { icon: "✗", color: "error" },
        error: { icon: "✗", color: "error" },
    };
    const m = meta[details.status] || { icon: "•", color: "muted" };
    const header = theme.fg(m.color, `${m.icon} ${extName} ${details.status}`);
    if (options.expanded && details.report) {
        const trimmed =
            details.report.length > reportMaxChars
                ? details.report.slice(0, reportMaxChars) +
                  "\n... [truncated — see workflow-report.md]"
                : details.report;
        return new MarkdownCtor(header + "\n\n" + trimmed, 1, 0, mdTheme);
    }
    return new TextCtor(header, 0, 0);
}

// Render the select_agents tool call. Identical between both extensions.
export function renderSelectAgentsCall(
    args: any,
    theme: any,
    TextCtor: any,
    displayNameFn: (s: string) => string,
): any {
    const list = (args.agents || []) as string[];
    // ∥ only for genuine parallel instances (same agent listed more than once);
    // distinct agents are dispatched in order, so they read as a sequence with →.
    const hasDuplicates =
        new Set(list.map((a) => a.toLowerCase())).size < list.length;
    const isParallel = hasDuplicates;
    const separator = isParallel ? " ∥ " : " → ";
    const preview = list.map((a) => displayNameFn(a)).join(separator);
    return new TextCtor(
        theme.fg("toolTitle", theme.bold("select_agents ")) +
            theme.fg("accent", preview || "—"),
        0,
        0,
    );
}

// Render the select_agents tool result. Identical between both extensions.
export function renderSelectAgentsResult(
    result: any,
    _options: any,
    theme: any,
    TextCtor: any,
): any {
    const details = result.details as any;
    if (details?.order) {
        return new TextCtor(
            theme.fg("success", "▸ queued ") +
                theme.fg("accent", details.order),
            0,
            0,
        );
    }
    const t = result.content[0];
    return new TextCtor(t?.type === "text" ? t.text : "", 0, 0);
}

// ── Agent loading ────────────────────────────────

export function parseAgentFile(filePath: string): AgentDef | null {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return null;
        const fm: Record<string, string> = {};
        for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");
            if (idx <= 0) continue;
            const key = line.slice(0, idx).trim();
            let val = line.slice(idx + 1).trim();
            // Handle quoted values that may contain colons
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }
            fm[key] = val;
        }
        if (!fm.name) return null;
        return {
            name: fm.name,
            description: fm.description || "",
            tools: fm.tools || "read,grep,find,ls",
            model: fm.model || "",
            contextWindow:
                parseInt(
                    fm.context_window ||
                        fm.contextwindow ||
                        fm.contextWindow ||
                        "0",
                    10,
                ) || 0,
            systemPrompt: match[2].trim(),
            aliases: fm.aliases
                ? fm.aliases
                      .replace(/^\[|\]$/g, "") // tolerate YAML [a, b] list syntax
                      .split(/[,\s]+/)
                      .map((a) => a.trim())
                      .filter(Boolean)
                : undefined,
        };
    } catch {
        return null;
    }
}

// Derive the per-agent model env var name from an agent key.
// e.g. "seeker" → "PI_AGENT_SEEKER_MODEL", "plan-build" → "PI_AGENT_PLAN_BUILD_MODEL"
export function agentModelEnvVar(agentKey: string): string {
    const name = agentKey.toUpperCase().replace(/[-\s]+/g, "_");
    return `PI_AGENT_${name}_MODEL`;
}

// Resolve the model for an agent. Precedence:
// 1. PI_AGENT_<NAME>_MODEL env var (e.g. PI_AGENT_SEEKER_MODEL)
// 2. Agent .md frontmatter `model:` field
// 3. PI_WORKFLOW_MODEL env var
// 4. fallback (caller-provided)
export function resolveAgentModel(
    agentKey: string,
    agents: Map<string, AgentDef>,
    workflowModel: string,
    fallback: string,
): string {
    const envModel = process.env[agentModelEnvVar(agentKey)];
    if (envModel) return envModel;
    const def = agents.get(agentKey.toLowerCase());
    if (def?.model) return def.model;
    return workflowModel || fallback;
}
// Project agents in `.pi/agents/` take precedence; extension agents serve as fallback.
export function loadAgents(
    cwd: string,
    fallbackDir?: string,
): Map<string, AgentDef> {
    const agents = new Map<string, AgentDef>();

    // First, load project-level agents from cwd/.pi/agents/
    const projectAgentsDir = join(cwd, ".pi", "agents");
    if (existsSync(projectAgentsDir)) {
        try {
            for (const file of readdirSync(projectAgentsDir)) {
                if (!file.endsWith(".md")) continue;
                const def = parseAgentFile(join(projectAgentsDir, file));
                if (def && !agents.has(def.name.toLowerCase())) {
                    agents.set(def.name.toLowerCase(), def);
                }
            }
        } catch {}
    }

    // Then load extension-level agents as fallback
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const agentsDir = join(extensionDir, "..", "agents");
    if (existsSync(agentsDir)) {
        try {
            for (const file of readdirSync(agentsDir)) {
                if (!file.endsWith(".md")) continue;
                const def = parseAgentFile(join(agentsDir, file));
                if (def && !agents.has(def.name.toLowerCase())) {
                    agents.set(def.name.toLowerCase(), def);
                }
            }
        } catch {}
    }

    return agents;
}

// ── Teams (.pi/agents/teams.yaml) ────────────────

// Minimal YAML parser for the flat `team:\n  - member` shape teams.yaml uses.
// Avoids a YAML dependency; mirrors the agent-team extension's parser.
function parseTeamsYaml(raw: string): Record<string, string[]> {
    const teams: Record<string, string[]> = {};
    let current: string | null = null;
    const orphanedItems: string[] = [];

    for (const line of raw.split("\n")) {
        const teamMatch = line.match(/^(\S[^:]*):\s*$/);
        if (teamMatch) {
            current = teamMatch[1].trim();
            teams[current] = [];
            continue;
        }
        const itemMatch = line.match(/^\s+-\s+(.+)$/);
        if (itemMatch) {
            if (current) {
                teams[current].push(itemMatch[1].trim());
            } else {
                // Track orphaned items before the first team header
                orphanedItems.push(itemMatch[1].trim());
            }
        }
    }

    // Warn about orphaned items that appeared before any team header
    if (orphanedItems.length > 0) {
        console.warn(
            `[parseTeamsYaml] ${orphanedItems.length} item(s) found before first team header and were ignored: ${orphanedItems.join(", ")}`,
        );
    }

    return teams;
}

// Load team definitions from both project-level and extension-level files.
// Project teams in `.pi/agents/teams.yaml` take precedence; extension teams serve as fallback.
export function loadTeams(
    cwd: string,
    fallbackDir?: string,
): Record<string, string[]> {
    // First, try project-level teams from cwd/.pi/agents/teams.yaml
    const projectTeamsFile = join(cwd, ".pi", "agents", "teams.yaml");
    if (existsSync(projectTeamsFile)) {
        try {
            return parseTeamsYaml(readFileSync(projectTeamsFile, "utf-8"));
        } catch {}
    }

    // Fallback to extension-level teams
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const teamsFile = join(extensionDir, "..", "agents", "teams.yaml");
    if (existsSync(teamsFile)) {
        try {
            return parseTeamsYaml(readFileSync(teamsFile, "utf-8"));
        } catch {}
    }

    return {};
}

// A team can run the full pipeline only if it has the implementer, tester,
// and validator. Otherwise it runs the plan→document (spec) workflow.
export function teamIsSpec(members: string[]): boolean {
    const set = new Set(members.map((m) => m.toLowerCase()));
    return !(
        set.has("implementer") &&
        set.has("tester") &&
        set.has("validator")
    );
}

// Collect all unique agent keys across every team, preserving first-seen order.
// Used by the idle widget grid so the dashboard shows every agent defined in
// teams.yaml — not just the active team's members.
export function allTeamAgents(teams: Record<string, string[]>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const members of Object.values(teams)) {
        for (const m of members) {
            const key = m.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push(key);
            }
        }
    }
    return result;
}

// Render the list of all defined teams (members + mode), marking the active one.
// Used in the startup banner and re-emitted on team switch so the `← active`
// marker follows the currently selected team.
export function teamsBlock(
    teams: Record<string, string[]>,
    agents: Map<string, AgentDef>,
    activeTeamName: string,
): string {
    return (
        Object.entries(teams)
            .map(([name, members]) => {
                const ms = members
                    .filter((m) => agents.has(m.toLowerCase()))
                    .map((m) => displayName(m))
                    .join(" → ");
                const mode = teamIsSpec(members) ? "spec" : "full";
                const active = name === activeTeamName ? "  ← active" : "";
                return `  ${name} [${mode}]: ${ms}${active}`;
            })
            .join("\n") || "  (no teams defined)"
    );
}

// Show the "Select Team" picker. Returns the chosen team name, or null if the
// user cancelled. A lone team is chosen without a dialog.
export async function chooseTeam(
    ctx: any,
    teams: Record<string, string[]>,
): Promise<string | null> {
    const teamNames = Object.keys(teams);
    if (teamNames.length === 0) return null;
    if (teamNames.length === 1) return teamNames[0];
    const options = teamNames.map((name) => {
        const members = (teams[name] || []).map((m) => displayName(m));
        const mode = teamIsSpec(teams[name] || []) ? "spec" : "full";
        return `${name} — ${members.join(", ")}  [${mode}]`;
    });
    const choice = await ctx.ui.select("Select Team", options);
    if (choice === undefined) return null;
    return teamNames[options.indexOf(choice)];
}

// ── Sessions & report publishing ─────────────────

// Default TTL for orphaned session files: 7 days. Files older than this are
// removed during cleanup so the session directory doesn't grow unbounded when
// dispatch-mode sessions accumulate across runs.
const SESSION_TTL_MS =
    Math.max(
        1,
        parseFloat(process.env.PI_WORKFLOW_SESSION_TTL_DAYS || "7") || 7,
    ) *
    24 *
    60 *
    60 *
    1000;

// Ensure the per-agent session directory exists; optionally wipe stale sessions.
// When `wipe` is false, still removes orphaned files older than SESSION_TTL_MS
// so dispatch-mode sessions don't accumulate indefinitely.
// The session directory is read from PI_WORKFLOW_SESSION_DIR env var;
// falls back to `~/.pi/agent/sessions/` if unset. Supports `~` expansion.
// Returns the directory path (the caller stores it as its sessionDir).
export function setupSessions(cwd: string, wipe: boolean): string {
    const defaultDir = join(homedir(), ".pi", "agent", "sessions");
    const envDir = (process.env.PI_WORKFLOW_SESSION_DIR || "").trim();
    const sessionDir = envDir
        ? envDir.startsWith("~")
            ? join(homedir(), envDir.slice(1))
            : envDir
        : defaultDir;
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const now = Date.now();
    for (const f of readdirSync(sessionDir)) {
        if (!f.endsWith(".json")) continue;
        if (wipe) {
            try {
                unlinkSync(join(sessionDir, f));
            } catch {}
        } else {
            // TTL-based cleanup: remove orphaned session files older than 7 days.
            try {
                const stat = statSync(join(sessionDir, f));
                if (now - stat.mtimeMs > SESSION_TTL_MS) {
                    unlinkSync(join(sessionDir, f));
                }
            } catch {}
        }
    }
    return sessionDir;
}

// Create a spawn wrapper that accumulates token/tool/dropped-line totals into
// the orchestrator state. Both extensions had identical 30-line wrappers that
// differed only in the `sharedSession` flag; this factory eliminates the
// duplication while keeping the per-extension state ownership clear.
// `state` is the extension's OrchestratorState (typed loosely to avoid a
// circular import with orchestrator-core.ts).
export function makeSpawnWrapper(opts: {
    state: {
        totalTokens: { input: number; output: number };
        totalToolCalls: number;
        totalDroppedLines: number;
    };
    sessionDir: string | (() => string);
    sharedSession: boolean;
    agentTimeoutMs: number;
    updateWidget: () => void;
    setCurrentProc: (proc: any) => void;
}): (
    agentDef: AgentDef,
    task: string,
    phase: PhaseState,
    cwd: string,
    model: string,
) => Promise<{ output: string; exitCode: number }> {
    const {
        state,
        sessionDir: sessionDirOpt,
        sharedSession,
        agentTimeoutMs,
        updateWidget,
        setCurrentProc,
    } = opts;
    const getSessionDir =
        typeof sessionDirOpt === "function"
            ? sessionDirOpt
            : () => sessionDirOpt;
    return (agentDef, task, phase, cwd, model) => {
        const cfg: SpawnConfig = {
            sessionDir: getSessionDir(),
            sharedSession,
            agentTimeoutMs,
            updateWidget,
            setCurrentProc,
        };
        const prevToolCount = phase.toolCount;
        const prevDroppedLines = phase.droppedLines;
        return spawnAgentWithModel(agentDef, task, phase, cwd, model, cfg).then(
            (result) => {
                if (result.tokens) {
                    state.totalTokens.input += result.tokens.input;
                    state.totalTokens.output += result.tokens.output;
                    phase.tokens = result.tokens;
                }
                state.totalToolCalls += phase.toolCount - prevToolCount;
                state.totalDroppedLines +=
                    phase.droppedLines - prevDroppedLines;
                return { output: result.output, exitCode: result.exitCode };
            },
        );
    };
}

// Post the final workflow report inline as a collapsible card. `pi` is the
// ExtensionAPI (kept `any` so core has no UI-type dependency).
export function publishReport(
    pi: any,
    report: string,
    lastStatus: string,
): void {
    const trimmed =
        report.length > WORKFLOW_REPORT_MAX
            ? report.slice(0, WORKFLOW_REPORT_MAX) +
              "\n\n... [truncated — full report saved to workflow-report.md]"
            : report;
    pi.sendMessage(
        {
            customType: WORKFLOW_REPORT_TYPE,
            content: trimmed,
            display: true,
            details: { status: lastStatus, length: report.length },
        },
        { triggerTurn: false },
    );
}

// Post the per-phase activity logs as a single collapsible card.
export function publishLogs(
    pi: any,
    phaseLogs: { label: string; log: string }[],
): void {
    if (phaseLogs.length === 0) return;
    const sections = phaseLogs.map(
        (p) => `## ${p.label}\n\n\`\`\`\n${p.log}\n\`\`\``,
    );
    let content = `# Activity Logs\n\n${sections.join("\n\n")}`;
    if (content.length > WORKFLOW_REPORT_MAX) {
        content = content.slice(0, WORKFLOW_REPORT_MAX) + "\n\n... [truncated]";
    }
    pi.sendMessage(
        {
            customType: WORKFLOW_LOG_TYPE,
            content,
            display: true,
            details: { phases: phaseLogs.length },
        },
        { triggerTurn: false },
    );
}

// ── Context usage helpers ────────────────────────

// Format context usage for display in cards and footers.
// Returns the progress bar and display string (percentage + token count + context window).
export function formatContextUsage(opts: {
    contextPct: number | null | undefined;
    tokenCount?: number | undefined;
    contextWindow?: number | undefined;
    barLength?: number;
}): { bar: string; display: string; known: boolean } {
    const { contextPct, tokenCount, contextWindow, barLength = 10 } = opts;

    const ctxKnown = contextWindow && contextWindow > 0;

    const fmtTok = (n: number) =>
        n >= 1_000_000
            ? `${(n / 1_000_000).toFixed(1)}M`
            : n >= 10_000
              ? `${Math.round(n / 1000)}K`
              : n >= 1000
                ? `${(n / 1000).toFixed(1)}K`
                : `${n}`;

    const fmtCtxWindow = (n: number) =>
        n >= 1_000_000
            ? `${(n / 1_000_000).toFixed(1)}M`
            : `${Math.round(n / 1000)}K`;

    const ctxSuffix = ctxKnown ? `/${fmtCtxWindow(contextWindow!)}` : "";

    // Recalculate percentage from tokenCount/contextWindow when both are
    // available. The pre-computed contextPct may have been calculated against
    // a different (or missing) context window from the API response, while the
    // displayed contextWindow may come from the agent's .md frontmatter.
    const known =
        contextPct !== null &&
        contextPct !== undefined &&
        !Number.isNaN(contextPct);
    let pct: number;
    let pctKnown: boolean;
    if (ctxKnown && tokenCount && tokenCount > 0) {
        pct = Math.min(100, (tokenCount / contextWindow!) * 100);
        pctKnown = true;
    } else if (known) {
        pct = contextPct!;
        pctKnown = true;
    } else {
        pct = 0;
        pctKnown = false;
    }

    const filled = pctKnown
        ? Math.max(0, Math.min(barLength, Math.round((pct / 100) * barLength)))
        : 0;
    const bar = "#".repeat(filled) + "-".repeat(barLength - filled);

    const display = !pctKnown
        ? ctxKnown
            ? `0.0%${ctxSuffix}`
            : "—"
        : tokenCount && tokenCount > 0
          ? `${pct.toFixed(1)}%${ctxSuffix} · ${fmtTok(tokenCount)}`
          : `${pct.toFixed(1)}%${ctxSuffix}`;

    return { bar, display, known: pctKnown || !!ctxKnown };
}

// ── Report builders (pure) ───────────────────────
// The final markdown report is identical between both extensions, so it lives
// here. tokenNote/digest/testSignal/outcomeLine are resolved from this module.

interface ReportTotals {
    runElapsedMs: number;
    totalToolCalls: number;
    totalTokens: { input: number; output: number };
    totalDroppedLines: number;
}

function totalsLine(t: ReportTotals): string {
    const tok =
        t.totalTokens.input > 0
            ? ` · ${(t.totalTokens.input + t.totalTokens.output).toLocaleString()} tokens (${t.totalTokens.input.toLocaleString()} in / ${t.totalTokens.output.toLocaleString()} out)`
            : "";
    return `${secs(t.runElapsedMs)} wall-clock · ${t.totalToolCalls} tool call(s)${tok}`;
}

// One "- **Name** (Ns, tokens) — digest [N dropped]" summary line for a phase.
function summaryLine(label: string, phase: PhaseState, body: string): string {
    const dropped =
        phase.droppedLines > 0 ? ` [${phase.droppedLines} dropped]` : "";
    return `- **${label}** (${secs(phase.elapsed)}${tokenNote(phase)}) — ${body}${dropped}`;
}

// Cap individual phase output in the details section to prevent reports from
// growing unbounded when an agent produces very long output. The summary section
// already uses digest() which is bounded; this bounds the raw details section.
const REPORT_PHASE_MAX = 12000;
function truncatePhaseOutput(text: string): string {
    if (text.length <= REPORT_PHASE_MAX) return text;
    return (
        text.slice(0, REPORT_PHASE_MAX) +
        `\n\n... [truncated — phase output exceeded ${REPORT_PHASE_MAX} chars]`
    );
}

export function buildWorkflowReport(o: {
    request: string;
    status: string;
    verdict: string;
    passes: number;
    maxLoops: number;
    passed: boolean;
    prUrl: string;
    totals: ReportTotals;
    scoutP: PhaseState | null;
    planP: PhaseState;
    critiqueP: PhaseState;
    implP: PhaseState;
    testP: PhaseState;
    valP: PhaseState;
    docP: PhaseState;
    shipP: PhaseState;
    scoutFindings: string;
    plan: string;
    critique: string;
    impl: string;
    test: string;
    val: string;
    doc: string;
    ship: string;
}): string {
    return [
        `# Workflow Report`,
        ``,
        `**Request:** ${o.request}`,
        `**Outcome:** ${outcomeLine(o.status, o.passes)}`,
        `**Result:** ${o.status} · verdict ${o.verdict.toUpperCase()} · ${o.passes} attempt(s) of ${o.maxLoops}`,
        `**Totals:** ${totalsLine(o.totals)}`,
        ...(o.prUrl ? [`**Pull request:** ${o.prUrl}`] : []),
        ...(o.totals.totalDroppedLines > 0
            ? [
                  ``,
                  `> **Diagnostic:** ${o.totals.totalDroppedLines} malformed JSON line(s) were dropped from agent output streams during this run. This may indicate a pi subprocess protocol issue. Full agent logs are appended below.`,
              ]
            : []),
        ``,
        `## Summary of work`,
        ``,
        ...(o.scoutP
            ? [summaryLine("Scout", o.scoutP, digest(o.scoutFindings))]
            : []),
        summaryLine("Planner", o.planP, digest(o.plan)),
        summaryLine("Critic", o.critiqueP, digest(o.critique)),
        summaryLine("Implementer", o.implP, digest(o.impl)),
        summaryLine(
            "Tester",
            o.testP,
            `${digest(o.test)}${testSignal(o.test)}`,
        ),
        summaryLine(
            "Validator",
            o.valP,
            `verdict ${o.verdict.toUpperCase()}. ${digest(o.val)}`,
        ),
        ...(o.passed
            ? [
                  summaryLine("Documenter", o.docP, digest(o.doc)),
                  summaryLine("Ship", o.shipP, digest(o.ship)),
              ]
            : [
                  `- **Documenter / Ship** — skipped (change did not pass validation)`,
              ]),
        ``,
        `## Details`,
        ``,
        ...(o.scoutP
            ? [
                  `### Reconnaissance`,
                  ``,
                  truncatePhaseOutput(o.scoutFindings),
                  ``,
              ]
            : []),
        `### Plan`,
        ``,
        truncatePhaseOutput(o.plan),
        ``,
        `### Critique`,
        ``,
        truncatePhaseOutput(o.critique),
        ``,
        `### Implementation`,
        ``,
        truncatePhaseOutput(o.impl),
        ``,
        `### Test Report`,
        ``,
        truncatePhaseOutput(o.test),
        ``,
        `### Validation`,
        ``,
        truncatePhaseOutput(o.val),
        ``,
        ...(o.passed
            ? [
                  `### Documentation`,
                  ``,
                  truncatePhaseOutput(o.doc),
                  ``,
                  `### Ship`,
                  ``,
                  truncatePhaseOutput(o.ship),
                  ``,
              ]
            : []),
    ].join("\n");
}

export function buildSpecReport(o: {
    request: string;
    outcome: string;
    totals: ReportTotals;
    scoutP: PhaseState | null;
    planP: PhaseState;
    critiqueP: PhaseState;
    docP: PhaseState;
    scoutFindings: string;
    plan: string;
    critique: string;
    doc: string;
}): string {
    return [
        `# Spec Workflow Report`,
        ``,
        `**Request:** ${o.request}`,
        `**Outcome:** ${o.outcome}`,
        `**Totals:** ${totalsLine(o.totals)}`,
        ...(o.totals.totalDroppedLines > 0
            ? [
                  ``,
                  `> **Diagnostic:** ${o.totals.totalDroppedLines} malformed JSON line(s) were dropped from agent output streams during this run.`,
              ]
            : []),
        ``,
        `## Summary`,
        ``,
        ...(o.scoutP
            ? [summaryLine("Scout", o.scoutP, digest(o.scoutFindings))]
            : []),
        summaryLine("Planner", o.planP, digest(o.plan)),
        summaryLine("Critic", o.critiqueP, digest(o.critique)),
        summaryLine("Documenter", o.docP, digest(o.doc)),
        ``,
        `## Details`,
        ``,
        ...(o.scoutP
            ? [
                  `### Reconnaissance`,
                  ``,
                  truncatePhaseOutput(o.scoutFindings),
                  ``,
              ]
            : []),
        `### Plan`,
        ``,
        truncatePhaseOutput(o.plan),
        ``,
        `### Critique`,
        ``,
        truncatePhaseOutput(o.critique),
        ``,
        `### Implementation Spec`,
        ``,
        truncatePhaseOutput(o.doc),
    ].join("\n");
}

// ── Plan structural validation ───────────────────

interface PlanCheck {
    ok: boolean;
    missing: string[];
}

/**
 * Lightweight structural check before handing the plan to the implementer.
 * Catches clearly malformed plans early so the pipeline doesn't silently
 * execute a plan with no phases, no acceptance criteria, and so on.
 */
export function validatePlan(plan: string): PlanCheck {
    const missing: string[] = [];
    if (!/^#{1,6}\s+phase[\s:]/im.test(plan)) {
        missing.push("at least one labelled phase heading (## Phase N)");
    }
    if (!/^#{1,6}\s+acceptance\s+criteri/im.test(plan)) {
        missing.push("an Acceptance Criteria heading (## Acceptance Criteria)");
    }
    if (
        !/^#{1,6}\s+(critical\s+files|files?\s+changed)/im.test(plan) &&
        !/^[-*]\s+\S+\.(ts|js|py|go|rs|md|json|yaml|yml)\b/im.test(plan) &&
        !/\b(modify|new file|create)\b.*\S+\.(ts|js|py|go|rs|md|json|yaml|yml)\b/i.test(
            plan,
        )
    ) {
        missing.push(
            "file-level specificity (Critical Files heading or explicit file paths in phases)",
        );
    }
    return { ok: missing.length === 0, missing };
}

// ── Shared run context (curated cross-agent bundle) ──
// Durable artifacts earlier pipeline phases produced. Prepended to a later
// agent's task so every agent can build on the others' work without the lossy
// digest-into-the-next-prompt handoff. Used by both agent-pipeline (always on)
// and agent-team (on by default; opt out with PI_AGENT_TEAM_SHARED_CONTEXT=0).
export interface RunArtifacts {
    recon?: string; // scout findings
    plan?: string; // approved plan
    critique?: string; // critic's verdict + findings
    implSummary?: string; // implementer's change summary
    testReport?: string; // tester's report
    docReport?: string; // documenter's report
}

// Render the artifacts present into a labelled "## Shared run context" block,
// or "" when none are set. Callers should pass only the artifacts a phase does
// not already receive through its task builder, to avoid duplicating context.
export function contextBundle(a: RunArtifacts): string {
    const parts: string[] = [];
    const add = (title: string, body?: string) => {
        if (!body || !body.trim()) return;
        let trimmed = body.trim();
        if (trimmed.length > 3000) {
            trimmed = trimmed.slice(0, 2997) + "...";
        }
        parts.push(`### ${title}`, "", trimmed, "");
    };
    add("Reconnaissance (scout)", a.recon);
    add("Approved plan (planner)", a.plan);
    add("Critique (critic)", a.critique);
    add("Implementation summary (implementer)", a.implSummary);
    add("Test report (tester)", a.testReport);
    add("Documentation report (documenter)", a.docReport);
    if (parts.length === 0) return "";
    return [
        "## Shared run context",
        "",
        "Earlier agents in this pipeline produced the artifacts below. Treat them as established ground truth and build on them — do not re-derive what is already settled.",
        "",
        ...parts,
    ]
        .join("\n")
        .trimEnd();
}

// Per-phase artifact whitelist: which RunArtifacts keys each phase actually
// needs. Later phases receive all artifacts by default, but the implementer
// doesn't need the test report, the tester doesn't need the critique, etc.
// Selective bundling reduces token consumption ~30% on complex runs.
const PHASE_ARTIFACT_WHITELIST: Record<string, (keyof RunArtifacts)[]> = {
    scout: ["recon"],
    planner: ["recon"],
    critic: ["recon", "plan"],
    implementer: ["recon", "plan", "critique"],
    tester: ["recon", "plan", "implSummary"],
    validator: ["recon", "plan", "implSummary", "testReport"],
    documenter: ["recon", "plan", "implSummary", "testReport"],
    shipper: ["recon", "plan", "implSummary", "testReport", "docReport"],
};

// Selective context bundle: only include artifacts the given phase actually
// needs. Falls back to the full bundle if the phase is unknown (forward-compat).
// Reduces token consumption ~30% on complex runs by omitting irrelevant artifacts.
export function contextBundleForPhase(
    phaseAgent: string,
    a: RunArtifacts,
): string {
    const whitelist =
        PHASE_ARTIFACT_WHITELIST[phaseAgent.toLowerCase()] ??
        (Object.keys(a) as (keyof RunArtifacts)[]);
    const filtered: RunArtifacts = {};
    for (const key of whitelist) {
        if (a[key]) filtered[key] = a[key];
    }
    return contextBundle(filtered);
}

// ── Prompt templates ─────────────────────────────

// Optional reconnaissance brief from the scout agent, injected into the planner
// prompts when a Scout phase ran first.
function reconBlock(recon: string): string[] {
    return recon.trim()
        ? [
              "A scout agent already investigated the codebase. Use these findings to ground your plan — do not re-explore from scratch:",
              recon.trim(),
              "",
          ]
        : [];
}

export function scoutTask(original: string): string {
    return [
        "Scout the codebase for this request and report concise findings.",
        "",
        "Request:",
        original,
    ].join("\n");
}

export function planTask(original: string, recon = ""): string {
    return [
        "Produce a structured, phased implementation plan.",
        "",
        "Request:",
        original,
        "",
        ...reconBlock(recon),
    ].join("\n");
}

export function criticTask(original: string, plan: string): string {
    return [
        "Evaluate this implementation plan before it is handed to the implementer.",
        "",
        "Request:",
        original,
        "",
        "Plan to evaluate:",
        plan,
    ].join("\n");
}

export function revisePlanTask(
    original: string,
    plan: string,
    critique: string,
): string {
    return [
        "The critic REJECTED your plan. Revise it to address the issues raised. Do not start over — adjust the existing plan.",
        "",
        "Original request:",
        original,
        "",
        "Your previous plan:",
        plan,
        "",
        "Critic findings to address:",
        critique,
    ].join("\n");
}

export function implementTask(original: string, plan: string): string {
    return [
        "Implement the following approved plan.",
        "",
        "Original request:",
        original,
        "",
        "Plan:",
        plan,
    ].join("\n");
}

export function fixTask(
    original: string,
    plan: string,
    feedback: string,
    prevSummary: string,
): string {
    return [
        "The validator REJECTED the previous attempt. Fix exactly the issues raised.",
        "",
        "Original request:",
        original,
        "",
        "Plan:",
        plan,
        "",
        "Your previous change summary:",
        prevSummary,
        "",
        "Validator findings to address:",
        feedback,
    ].join("\n");
}

export function testTask(
    original: string,
    plan: string,
    implSummary: string,
): string {
    return [
        "Test the change just implemented.",
        "",
        "Original requirement:",
        original,
        "",
        "Plan (contains the acceptance criteria):",
        plan,
        "",
        "Implementer's change summary:",
        implSummary,
    ].join("\n");
}

export function documentTask(
    original: string,
    plan: string,
    implSummary: string,
    testReport: string,
): string {
    return [
        "Document the change just implemented and verified.",
        "",
        "Original requirement:",
        original,
        "",
        "Plan:",
        plan,
        "",
        "Implementer's change summary:",
        implSummary,
        "",
        "Tester's report:",
        testReport,
    ].join("\n");
}

export function validateTask(
    original: string,
    plan: string,
    testReport: string,
): string {
    return [
        "Validate the completed work.",
        "",
        "Original requirement:",
        original,
        "",
        "Plan (with the acceptance criteria to confirm):",
        plan,
        "",
        "Tester's report:",
        testReport,
    ].join("\n");
}

export function shipTask(
    original: string,
    testReport: string,
    docReport: string,
): string {
    return [
        "The change has passed validation and been documented. Ship it.",
        "",
        "Original requirement:",
        original,
        "",
        "Tester's report:",
        testReport,
        "",
        "Documenter's report (these doc changes must be committed too):",
        docReport,
    ].join("\n");
}

export function specPlanTask(original: string, recon = ""): string {
    return [
        "Produce a standalone implementation specification. The reader will have ONLY this document plus the codebase — no conversation history or prior context. Be unusually detailed: spell out file paths, function signatures, integration points, edge cases, and naming conventions for every phase.",
        "",
        "Request:",
        original,
        "",
        ...reconBlock(recon),
    ].join("\n");
}

export function specCriticTask(original: string, plan: string): string {
    return [
        "Evaluate this implementation plan before it is turned into a spec. Find every problem that would cause the spec to mislead or the implementation to fail.",
        "",
        "Request:",
        original,
        "",
        "Plan to evaluate:",
        plan,
    ].join("\n");
}

export function specReviseTask(
    original: string,
    plan: string,
    critique: string,
): string {
    return revisePlanTask(original, plan, critique);
}

export function specDocumentTask(original: string, plan: string): string {
    return [
        "Transform this raw implementation plan into a standalone specification (spec workflow).",
        "",
        "Original request:",
        original,
        "",
        "Raw plan:",
        plan,
    ].join("\n");
}

// ── Phase helpers ───────────────────────────────

// Type-safe access to phases by agent name. Built from the phases array so
// callers never rely on positional indexing (which breaks silently if
// freshPhases() changes order).
export interface PhaseMap {
    scout?: PhaseState;
    planner: PhaseState;
    critic: PhaseState;
    implementer: PhaseState;
    tester: PhaseState;
    validator: PhaseState;
    documenter: PhaseState;
    shipper: PhaseState;
}

// Build a PhaseMap from the phases array. Phases are matched by agent name.
// Only phases present in the array are required — spec workflows (planner, critic,
// documenter) don't need implementer/tester/validator/shipper. Throws if a phase
// expected for the detected workflow mode is missing.
export function buildPhaseMap(phases: PhaseState[]): PhaseMap {
    const byAgent = (name: string) =>
        phases.find((p) => p.agent === name.toLowerCase());

    const agents = new Set(phases.map((p) => p.agent));
    const isSpecMode =
        agents.has("planner") &&
        agents.has("documenter") &&
        !agents.has("implementer");

    // Find a phase, throwing a clear error if a required one is missing
    const requirePhase = (name: string): PhaseState => {
        const p = byAgent(name);
        if (!p) {
            throw new Error(
                `[buildPhaseMap] Required phase "${name}" not found in phases array. ` +
                    `Available agents: ${phases.map((p) => p.agent).join(", ")}`,
            );
        }
        return p;
    };

    if (isSpecMode) {
        // Spec workflow: planner, critic, documenter are required
        return {
            scout: byAgent("scout"),
            planner: requirePhase("planner"),
            critic: requirePhase("critic"),
            implementer: byAgent("implementer")!,
            tester: byAgent("tester")!,
            validator: byAgent("validator")!,
            documenter: requirePhase("documenter"),
            shipper: byAgent("shipper")!,
        };
    }

    // Full pipeline: all phases required
    return {
        scout: byAgent("scout"),
        planner: requirePhase("planner"),
        critic: requirePhase("critic"),
        implementer: requirePhase("implementer"),
        tester: requirePhase("tester"),
        validator: requirePhase("validator"),
        documenter: requirePhase("documenter"),
        shipper: requirePhase("shipper"),
    };
}

// Standardised error return for a failed phase. Sets the running state to
// stopped/error and returns the shape both runWorkflow and runSpecWorkflow
// use. Eliminates the 7-line `if (!x.ok) { running = false; ... }` block
// repeated for every phase.
export function failPhase(
    phaseName: string,
    output: string,
): { status: string; report: string } {
    return {
        status: "error",
        report: `${phaseName} failed:\n\n${output}`,
    };
}

// ── Phase construction ──────────────────────────

// Create a fresh PhaseState with all counters zeroed. Shared across extensions
// and the runtime so the three copies stay identical.
// dispatchId: optional unique identifier for parallel dispatches of the same agent
export function mkPhase(
    label: string,
    agent: string,
    dispatchId?: string,
): PhaseState {
    return {
        label,
        agent,
        dispatchId,
        status: "pending",
        elapsed: 0,
        note: "",
        log: "",
        droppedLines: 0,
        toolCount: 0,
        contextPct: 0,
        attempt: 0,
        modelFallback: false,
        activeModel: undefined,
    };
}

// Build the initial phase array for a workflow run. `includeScout` prepends
// a read-only recon pass; `isSpecMode` hides impl/test/validate/ship phases.
// Shared across both extensions and the runtime — character-for-character
// identical in all three callers before extraction.
export function freshPhases(
    includeScout: boolean,
    isSpecMode: boolean,
): PhaseState[] {
    const lead = includeScout ? [mkPhase("Scout", "scout")] : [];
    if (isSpecMode) {
        return [
            ...lead,
            mkPhase("Plan", "planner"),
            mkPhase("Critique", "critic"),
            mkPhase("Document", "documenter"),
        ];
    }
    return [
        ...lead,
        mkPhase("Plan", "planner"),
        mkPhase("Critique", "critic"),
        mkPhase("Implement", "implementer"),
        mkPhase("Test", "tester"),
        mkPhase("Validate", "validator"),
        mkPhase("Document", "documenter"),
        mkPhase("Ship", "shipper"),
    ];
}

// ── Shared agent execution with model fallback ──

// Run an agent with automatic model fallback. If the primary model fails to
// load or run (detected via isModelFailure), retry once with the fallback model
// (typically the session model). Shared across both extensions and the runtime
// to eliminate ~50 lines of near-identical fallback logic with notification API drift.
// The spawnFn callback abstracts the spawn implementation; notify abstracts the
// notification API (widgetCtx.ui.notify in extensions, console in runtime).
export async function runAgentWithFallback(
    agentDef: AgentDef,
    task: string,
    phase: PhaseState,
    cwd: string,
    primaryModel: string,
    fallbackModel: string,
    spawnFn: (
        def: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
        model: string,
    ) => Promise<{ output: string; exitCode: number }>,
    opts: {
        updateWidget: () => void;
        notify?: (
            msg: string,
            level: "success" | "error" | "warning" | "info",
        ) => void;
    },
): Promise<{ output: string; exitCode: number }> {
    const result = await spawnFn(agentDef, task, phase, cwd, primaryModel);

    // Only model-specific load/run failures trigger a fallback — timeouts,
    // tool failures, and bad output are not retried.
    if (result.exitCode !== 0 && isModelFailure(result.output)) {
        const agentName = displayName(agentDef.name);

        // If the agent is already on the primary agent's model (no distinct
        // fallback), there is nothing to fall back to — tell the user.
        if (!fallbackModel) {
            opts.notify?.(
                `${agentName}: model "${primaryModel}" failed to load or run, and no fallback is available (already on the primary agent's model).`,
                "error",
            );
            return result;
        }

        // Retry once with the fallback model and inform the user.
        const prevContextPct = phase.contextPct;
        phase.note = `⚠ ${primaryModel} failed → ${fallbackModel} (context reset from ${prevContextPct}%)`;
        phase.modelFallback = true;
        phase.toolCount = 0;
        phase.contextPct = 0;
        phase.droppedLines = 0;
        phase.log += `\n⚠ Model ${primaryModel} failed — retrying with ${fallbackModel} (context reset from ${prevContextPct}%)\n`;
        opts.notify?.(
            `${agentName}: model "${primaryModel}" failed to load or run — falling back to ${fallbackModel} and retrying.`,
            "warning",
        );
        opts.updateWidget();

        const retry = await spawnFn(agentDef, task, phase, cwd, fallbackModel);
        if (retry.exitCode !== 0 && isModelFailure(retry.output)) {
            opts.notify?.(
                `${agentName}: the fallback model (${fallbackModel}) also failed to load or run.`,
                "error",
            );
        } else if (retry.exitCode === 0) {
            opts.notify?.(
                `${agentName}: recovered on ${fallbackModel}.`,
                "success",
            );
        }
        return retry;
    }
    return result;
}

// ── Shared phase execution ──────────────────────

// Run a single phase: look up the agent, reset counters, spawn the subprocess,
// and update phase state. Shared across both extensions and the runtime to
// eliminate behavioral drift (the runtime version was resetting phase.log and
// phase.note; the extensions were not). The spawnFn callback abstracts the
// model-resolution and notification differences between pipeline/team/runtime.
export async function runPhaseCore(
    agents: Map<string, AgentDef>,
    phase: PhaseState,
    task: string,
    cwd: string,
    spawnFn: (
        def: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
    ) => Promise<{ output: string; exitCode: number }>,
    opts: {
        updateWidget: () => void;
        notify?: (
            msg: string,
            level: "success" | "error" | "warning" | "info",
        ) => void;
        phaseLogs: { label: string; log: string }[];
    },
): Promise<{ output: string; ok: boolean }> {
    const def = agents.get(phase.agent);
    if (!def) {
        phase.status = "error";
        phase.note = `Agent "${phase.agent}" not found`;
        opts.updateWidget();
        return {
            output: `Agent "${phase.agent}" not found in .pi/agents/`,
            ok: false,
        };
    }

    phase.attempt++;
    phase.status = "running";
    phase.log = "";
    const prevContextPct = phase.contextPct;
    phase.note =
        phase.attempt > 1
            ? `Attempt ${phase.attempt} (context reset from ${prevContextPct}%)`
            : "";
    phase.toolCount = 0;
    phase.contextPct = 0;
    phase.droppedLines = 0;
    opts.updateWidget();

    const res = await spawnFn(def, task, phase, cwd);
    const elapsed = phase.elapsed;
    const statusWord =
        res.exitCode === 0 && res.output.trim().length > 0 ? "done" : "error";
    const attemptNote = phase.attempt > 1 ? ` (attempt ${phase.attempt})` : "";

    phase.status = statusWord as PhaseState["status"];
    opts.phaseLogs.push({
        label: `${phase.label}${attemptNote} [${secs(elapsed)}]`,
        log: phase.log,
    });
    // Cap phaseLogs so a very long workflow doesn't grow unbounded.
    if (opts.phaseLogs.length > 200) opts.phaseLogs.shift();
    opts.updateWidget();

    // Notify the user when a phase completes so they have peripheral awareness
    // without staring at the dashboard.
    if (opts.notify) {
        const elapsedStr = secs(elapsed);
        const word = statusWord === "done" ? "done" : "failed";
        opts.notify(
            `${phase.label} ${word} in ${elapsedStr}${attemptNote}`,
            statusWord === "done" ? "success" : "error",
        );
    }

    return { output: res.output, ok: statusWord === "done" };
}

// ── Token tracking ───────────────────────────────

// Per-phase token usage captured from the agent's message_end event. Both
// input and output tokens are tracked so the workflow report can show cost
// estimates and a total across all phases.
export interface TokenUsage {
    input: number;
    output: number;
    contextWindow: number; // 0 when unknown
}

// Format a per-phase token note for the workflow report summary line.
// Returns ", Nk tokens" when tokens are present, or "" otherwise.
export function tokenNote(phase: PhaseState): string {
    if (
        !phase.tokens ||
        (phase.tokens.input === 0 && phase.tokens.output === 0)
    )
        return "";
    const total = phase.tokens.input + phase.tokens.output;
    const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
    return `, ${k} tokens`;
}

// ── Shared agent spawn ────────────────────────────

// Configuration for spawning a sub-agent subprocess. Extracted so both
// extensions (agent-pipeline, agent-team) and the WorkflowRuntime class
// share one implementation instead of carrying ~220-line copies.
export interface SpawnConfig {
    sessionDir: string;
    sharedSession: boolean;
    agentTimeoutMs: number;
    updateWidget: () => void;
    setCurrentProc: (proc: any) => void;
}

// Result of a spawned agent subprocess.
export interface SpawnResult {
    output: string;
    exitCode: number;
    tokens?: TokenUsage;
}

// Dispatch-context env passed to every spawned sub-agent. Sub-agents are separate
// pi processes, so the recursion guard (depth + ancestry for cycle detection) rides
// down through the environment. Each hop increments PI_DISPATCH_DEPTH and appends
// the spawned agent to PI_DISPATCH_ANCESTRY; dispatchAgentCore reads these to bound
// recursion. PI_SUBAGENT is kept for backward compatibility.
export function dispatchEnv(agentName: string): Record<string, string> {
    const depth = parseInt(process.env.PI_DISPATCH_DEPTH || "0", 10) || 0;
    const ancestry = process.env.PI_DISPATCH_ANCESTRY || "";
    const name = agentName.toLowerCase();
    return {
        PI_SUBAGENT: "1",
        PI_DISPATCH_DEPTH: String(depth + 1),
        PI_DISPATCH_ANCESTRY: ancestry ? `${ancestry}>${name}` : name,
    };
}

// Spawn a pi subprocess for an agent, stream its output, and return the result.
// This is the single shared implementation used by agent-pipeline, agent-team,
// and the WorkflowRuntime class. Each caller handles model resolution and
// fallback differently, so this function only handles the spawn itself.
// ── Pure event handler for spawn events ────────────
// Extracted for unit testing without subprocess mocking.
export interface SpawnEventState {
    answer: string[];
    finalText: string;
    finalError: string;
    activity: string;
    stderrTail: string;
    droppedLines: number;
    toolCount: number;
    contextPct: number;
    capturedTokens?: TokenUsage;
    cumulativeTokens: {
        input: number;
        output: number;
    };
}

export function handleSpawnEvent(
    event: any,
    state: SpawnEventState,
    phase: PhaseState,
    paint: (force?: boolean) => void,
): void {
    if (event.type === "message_update") {
        const ev = event.assistantMessageEvent;
        if (ev?.type === "text_delta") {
            state.answer.push(ev.delta || "");
            state.activity += ev.delta || "";
            if (state.activity.length > LOG_CAP_CHARS)
                state.activity = state.activity.slice(-LOG_CAP_CHARS);
            phase.log = state.activity;
            phase.note =
                state.activity
                    .split("\n")
                    .filter((l: string) => l.trim())
                    .pop() || "";
            paint();
        } else if (ev?.type === "thinking_delta") {
            state.activity += ev.delta || "";
            if (state.activity.length > LOG_CAP_CHARS)
                state.activity = state.activity.slice(-LOG_CAP_CHARS);
            phase.log = state.activity;
            phase.note =
                state.activity
                    .split("\n")
                    .filter((l: string) => l.trim())
                    .pop() || "";
            paint();
        }
    } else if (event.type === "tool_execution_start") {
        phase.toolCount++;
        state.toolCount++;
        const compactArgs = (a: any): string => {
            if (!a || typeof a !== "object") return "";
            const s = Object.entries(a)
                .map(
                    ([k, v]) =>
                        `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
                )
                .join(" ");
            return s.length > 70 ? s.slice(0, 69) + "…" : s;
        };
        state.activity += `\n→ ${event.toolName} ${compactArgs(event.args)}\n`;
        if (state.activity.length > LOG_CAP_CHARS)
            state.activity = state.activity.slice(-LOG_CAP_CHARS);
        phase.log = state.activity;
        phase.note =
            state.activity
                .split("\n")
                .filter((l: string) => l.trim())
                .pop() || "";
        paint(true);
    } else if (event.type === "tool_execution_end") {
        state.activity += `✓ ${event.toolName}\n`;
        if (state.activity.length > LOG_CAP_CHARS)
            state.activity = state.activity.slice(-LOG_CAP_CHARS);
        phase.log = state.activity;
        phase.note =
            state.activity
                .split("\n")
                .filter((l: string) => l.trim())
                .pop() || "";
        paint(true);
    } else if (event.type === "message_end" || event.type === "agent_end") {
        const msg =
            event.type === "message_end"
                ? event.message
                : (event.messages || []).find(
                      (m: any) => m.role === "assistant",
                  );
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
            const text = msg.content
                .filter((c: any) => c?.type === "text")
                .map((c: any) => c.text || "")
                .join("");
            if (text) state.finalText = text;
            if (msg.stopReason === "error" && msg.errorMessage)
                state.finalError = String(msg.errorMessage);
        }
        if (msg?.usage?.input) {
            // contextWindow may not be reported by all providers. Do NOT fall
            // back to max_tokens (that's the max output limit, not the context
            // window) or a hardcoded value — both produce misleading percentages.
            const ctxWindow = msg.usage.contextWindow || 0;

            // input tokens: each message_end in a multi-turn spawn reports the
            // FULL conversation context for that turn, not a delta. Take the
            // max to avoid double-counting as the conversation grows.
            state.cumulativeTokens.input = Math.max(
                state.cumulativeTokens.input,
                msg.usage.input || 0,
            );
            // output tokens: genuinely additive across turns
            state.cumulativeTokens.output += msg.usage.output || 0;

            const totalTokens =
                state.cumulativeTokens.input + state.cumulativeTokens.output;

            // Only compute percentage when the context window is known
            const pct =
                ctxWindow > 0
                    ? Math.min(100, Math.round((totalTokens / ctxWindow) * 100))
                    : 0;
            phase.contextPct = pct;
            state.contextPct = phase.contextPct;
            state.capturedTokens = {
                input: state.cumulativeTokens.input,
                output: state.cumulativeTokens.output,
                contextWindow: ctxWindow,
            };
            // Also set phase.tokens immediately so the card can display it during the spawn
            phase.tokens = state.capturedTokens;
            paint();
        }
    }
}

// Compute the final output and exit code from spawn state.
export function computeSpawnResult(
    state: SpawnEventState,
    exitCode: number | null,
    timedOut: boolean,
    agentTimeoutMs: number,
    stderrTail: string,
): SpawnResult {
    let output = state.answer.join("") || state.finalText;
    if (state.finalError) {
        output +=
            (output ? "\n\n" : "") +
            `[agent error] ${state.finalError.slice(0, STDERR_TAIL_CAP)}`;
    }
    if (timedOut) {
        output +=
            (output ? "\n\n" : "") +
            `[timed out after ${Math.round(agentTimeoutMs / 60_000)}m — killed by PI_WORKFLOW_AGENT_TIMEOUT]`;
    }
    if ((exitCode ?? 1) !== 0 && stderrTail.trim()) {
        output += (output ? "\n\n" : "") + `[stderr]\n${stderrTail.trim()}`;
    }
    return {
        output,
        exitCode: timedOut || state.finalError ? 1 : (exitCode ?? 1),
        tokens: state.capturedTokens,
    };
}

// Fallback version of spawnAgentWithModel that uses the main session directory
// without creating project-specific subdirectories. Used when subdirectory
// creation fails (e.g., permission issues).
function spawnAgentWithModelFallback(
    agentDef: AgentDef,
    task: string,
    phase: PhaseState,
    cwd: string,
    model: string,
    config: SpawnConfig,
): Promise<SpawnResult> {
    const key = agentDef.name.toLowerCase().replace(/\s+/g, "-");
    const sessionKey = phase.dispatchId ? `${key}-${phase.dispatchId}` : key;

    // Use the main session directory with project hash in filename
    const projectHash = cwd
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .substring(0, 50);

    const useSharedSession = config.sharedSession && !phase.dispatchId;
    const sessionFile = join(
        config.sessionDir,
        useSharedSession
            ? `pipeline-${projectHash}.json`
            : `${sessionKey}-${projectHash}.json`,
    );

    // Validate session file before using it
    let hasSession = false;
    if (existsSync(sessionFile)) {
        try {
            const stats = statSync(sessionFile);
            if (stats.size < 10 || stats.size > 10 * 1024 * 1024) {
                console.error(
                    `[spawnAgentWithModel] Session file ${sessionFile} has suspicious size (${stats.size} bytes), deleting and starting fresh`,
                );
                unlinkSync(sessionFile);
            } else {
                const content = readFileSync(sessionFile, "utf-8");
                const firstLine = content.split("\n")[0];
                JSON.parse(firstLine);
                hasSession = true;
            }
        } catch (error) {
            console.error(
                `[spawnAgentWithModel] Session file ${sessionFile} is corrupted or invalid, deleting and starting fresh:`,
                error instanceof Error ? error.message : String(error),
            );
            try {
                unlinkSync(sessionFile);
            } catch (deleteError) {
                console.error(
                    `[spawnAgentWithModel] Failed to delete corrupted session file:`,
                    deleteError instanceof Error
                        ? deleteError.message
                        : String(deleteError),
                );
            }
        }
    }

    const args = [
        "--mode",
        "json",
        "-p",
        "--tools",
        agentDef.tools,
        "--append-system-prompt",
        agentDef.systemPrompt,
        "--session",
        sessionFile,
    ];

    const cleanModel = model?.trim();
    if (cleanModel && !/\s/.test(cleanModel)) {
        const firstSlash = cleanModel.indexOf("/");
        const modelId =
            firstSlash > 0 ? cleanModel.slice(firstSlash + 1) : cleanModel;
        args.push("--model", modelId);
    }
    if (hasSession) args.push("-c");
    args.push(task);

    phase.activeModel = cleanModel || undefined;

    const state: SpawnEventState = {
        answer: [],
        finalText: "",
        finalError: "",
        activity: "",
        stderrTail: "",
        droppedLines: 0,
        toolCount: 0,
        contextPct: 0,
        cumulativeTokens: {
            input: 0,
            output: 0,
        },
    };
    const start = Date.now();

    return new Promise((resolve) => {
        const proc = spawn("pi", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...dispatchEnv(agentDef.name) },
            cwd,
        });

        config.setCurrentProc(proc);

        const watchdog = config.agentTimeoutMs
            ? setTimeout(() => {
                  console.error(
                      `[spawnAgentWithModel] Agent ${agentDef.name} timed out after ${config.agentTimeoutMs}ms, killing process`,
                  );
                  proc.kill("SIGTERM");
                  setTimeout(() => {
                      if (!proc.killed) {
                          proc.kill("SIGKILL");
                      }
                  }, 5000);
              }, config.agentTimeoutMs)
            : null;

        proc.stdout?.on("data", (data: Buffer) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    handleSpawnEvent(event, state, phase, () => {});
                } catch (error) {
                    state.droppedLines++;
                }
            }
        });

        proc.stderr?.on("data", (data: Buffer) => {
            const stderrText = data.toString();
            state.stderrTail += stderrText;
            if (state.stderrTail.length > STDERR_TAIL_CAP) {
                state.stderrTail = state.stderrTail.slice(-STDERR_TAIL_CAP);
            }
        });

        proc.on("close", (code) => {
            if (watchdog) clearTimeout(watchdog);
            config.setCurrentProc(null);

            const elapsed = Date.now() - start;
            const timedOut = elapsed >= (config.agentTimeoutMs || Infinity);

            const result = computeSpawnResult(
                state,
                code,
                timedOut,
                config.agentTimeoutMs || 0,
                state.stderrTail,
            );

            resolve(result);
        });

        proc.on("error", (error) => {
            if (watchdog) clearTimeout(watchdog);
            config.setCurrentProc(null);
            console.error(
                `[spawnAgentWithModel] Failed to spawn pi process for ${agentDef.name}:`,
                error.message,
            );
            resolve({
                output: `[spawn error] ${error.message}`,
                exitCode: 1,
            });
        });
    });
}

export function spawnAgentWithModel(
    agentDef: AgentDef,
    task: string,
    phase: PhaseState,
    cwd: string,
    model: string,
    config: SpawnConfig,
): Promise<SpawnResult> {
    const key = agentDef.name.toLowerCase().replace(/\s+/g, "-");
    // Use dispatchId for unique session files when running parallel instances
    const sessionKey = phase.dispatchId ? `${key}-${phase.dispatchId}` : key;

    // Create project-specific subdirectory for better session organization
    const projectHash = cwd
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .substring(0, 50); // Limit length
    const projectSessionDir = join(config.sessionDir, projectHash);

    // Ensure the project session directory exists
    if (!existsSync(projectSessionDir)) {
        try {
            mkdirSync(projectSessionDir, { recursive: true });
        } catch (error) {
            console.error(
                `[spawnAgentWithModel] Failed to create project session directory ${projectSessionDir}:`,
                error instanceof Error ? error.message : String(error),
            );
            // Fall back to the main session directory if subdirectory creation fails
            return spawnAgentWithModelFallback(
                agentDef,
                task,
                phase,
                cwd,
                model,
                config,
            );
        }
    }

    // For parallel dispatches (when dispatchId exists), always use unique session files
    // to prevent race conditions. Only use shared sessions for sequential pipeline phases.
    const useSharedSession = config.sharedSession && !phase.dispatchId;

    // Use simple filenames inside the project subdirectory
    const sessionFile = join(
        projectSessionDir,
        useSharedSession ? "pipeline.json" : `${sessionKey}.json`,
    );

    // Validate session file before using it
    let hasSession = false;
    if (existsSync(sessionFile)) {
        try {
            const stats = statSync(sessionFile);
            // Check if file is too small (likely corrupted) or too large (might be incompatible)
            if (stats.size < 10 || stats.size > 10 * 1024 * 1024) {
                console.error(
                    `[spawnAgentWithModel] Session file ${sessionFile} has suspicious size (${stats.size} bytes), deleting and starting fresh`,
                );
                unlinkSync(sessionFile);
            } else {
                // Validate the session file by reading only the first ~2KB
                // instead of the entire file (which can be up to 10MB).
                // This avoids blocking the event loop for large sessions.
                const MAX_VALIDATE_BYTES = 2048;
                const buf = Buffer.alloc(MAX_VALIDATE_BYTES);
                let bytesRead = 0;
                const fd = openSync(sessionFile, "r");
                try {
                    bytesRead = readSync(fd, buf, 0, MAX_VALIDATE_BYTES, 0);
                } finally {
                    closeSync(fd);
                }
                const head = buf.toString("utf-8", 0, bytesRead);
                const lines = head.split("\n").filter((l) => l.trim());
                let validLines = 0;
                for (const line of lines.slice(0, 5)) {
                    try {
                        JSON.parse(line);
                        validLines++;
                    } catch {
                        break;
                    }
                }
                // Only use the session if at least the first line is valid
                if (validLines > 0) {
                    hasSession = true;
                } else {
                    console.error(
                        `[spawnAgentWithModel] Session file ${sessionFile} has no valid JSON lines, deleting and starting fresh`,
                    );
                    unlinkSync(sessionFile);
                }
            }
        } catch (error) {
            console.error(
                `[spawnAgentWithModel] Session file ${sessionFile} is corrupted or invalid, deleting and starting fresh:`,
                error instanceof Error ? error.message : String(error),
            );
            try {
                unlinkSync(sessionFile);
            } catch (deleteError) {
                console.error(
                    `[spawnAgentWithModel] Failed to delete corrupted session file:`,
                    deleteError instanceof Error
                        ? deleteError.message
                        : String(deleteError),
                );
            }
        }
    }

    const args = [
        "--mode",
        "json",
        "-p",
        "--tools",
        agentDef.tools,
        "--append-system-prompt",
        agentDef.systemPrompt,
        "--session",
        sessionFile,
    ];
    // Only pass --model if the string looks valid (non-empty, no whitespace).
    // If the string contains a slash, it's in provider/model format.
    // Extract everything after the FIRST slash as the model ID.
    // e.g., "gate_frame_private/gateframe/mimo-v2.5" -> "gateframe/mimo-v2.5"
    // e.g., "anthropic/claude-3-opus" -> "claude-3-opus"
    // e.g., "openai/gpt-4" -> "gpt-4"
    const cleanModel = model?.trim();
    if (cleanModel && !/\s/.test(cleanModel)) {
        const firstSlash = cleanModel.indexOf("/");
        let modelId = cleanModel;

        if (firstSlash > 0) {
            modelId = cleanModel.slice(firstSlash + 1);
            // Validate the extracted model ID
            if (!modelId || modelId.trim().length === 0) {
                console.error(
                    `[spawnAgentWithModel] Invalid model format: "${cleanModel}" - extracted model ID is empty, using original string`,
                );
                modelId = cleanModel;
            }
        }

        args.push("--model", modelId);
    }
    if (hasSession) args.push("-c");
    args.push(task);

    // Record the model this run is actually using so the card reflects it.
    phase.activeModel = cleanModel || undefined;

    const state: SpawnEventState = {
        answer: [],
        finalText: "",
        finalError: "",
        activity: "",
        stderrTail: "",
        droppedLines: 0,
        toolCount: 0,
        contextPct: 0,
        cumulativeTokens: {
            input: 0,
            output: 0,
        },
    };
    const start = Date.now();

    return new Promise((resolve) => {
        const proc = spawn("pi", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...dispatchEnv(agentDef.name) },
            cwd,
        });
        config.setCurrentProc(proc);

        let timedOut = false;
        const watchdog =
            config.agentTimeoutMs > 0
                ? setTimeout(() => {
                      timedOut = true;
                      try {
                          proc.kill("SIGTERM");
                      } catch {}
                      // Escalate to SIGKILL after 5s if SIGTERM doesn't work
                      setTimeout(() => {
                          if (!proc.killed) {
                              proc.kill("SIGKILL");
                          }
                      }, 5000);
                  }, config.agentTimeoutMs)
                : null;

        let lastPaint = 0;
        const paint = (force = false) => {
            const now = Date.now();
            if (!force && now - lastPaint < 120) return;
            lastPaint = now;
            config.updateWidget();
        };

        const timer = setInterval(() => {
            phase.elapsed = Date.now() - start;
            config.updateWidget();
        }, 1000);

        let buffer = "";
        proc.stdout!.setEncoding("utf-8");
        proc.stdout!.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    handleSpawnEvent(event, state, phase, paint);
                } catch {
                    state.droppedLines++;
                }
            }
        });
        proc.stderr!.setEncoding("utf-8");
        proc.stderr!.on("data", (chunk: string) => {
            state.stderrTail += chunk;
            if (state.stderrTail.length > STDERR_TAIL_CAP)
                state.stderrTail = state.stderrTail.slice(-STDERR_TAIL_CAP);
        });

        proc.on("close", (code) => {
            config.setCurrentProc(null);
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer);
                    if (
                        event.type === "message_update" &&
                        event.assistantMessageEvent?.type === "text_delta"
                    ) {
                        state.answer.push(
                            event.assistantMessageEvent.delta || "",
                        );
                    }
                } catch {
                    state.droppedLines++;
                }
            }
            clearInterval(timer);
            if (watchdog) clearTimeout(watchdog);
            phase.elapsed = Date.now() - start;
            phase.note =
                state.answer.join("") || state.finalText
                    ? (state.answer.join("") || state.finalText)
                          .split("\n")
                          .filter((l: string) => l.trim())
                          .pop() || phase.note
                    : phase.note;
            resolve(
                computeSpawnResult(
                    state,
                    code,
                    timedOut,
                    config.agentTimeoutMs,
                    state.stderrTail,
                ),
            );
        });

        proc.on("error", (err: any) => {
            config.setCurrentProc(null);
            clearInterval(timer);
            if (watchdog) clearTimeout(watchdog);
            resolve({
                output: `Error spawning agent: ${err.message}`,
                exitCode: 1,
            });
        });
    });
}

// ── Prompt template loader ───────────────────────

// Load a prompt template from `.pi/prompts/<name>.md`. Falls back to the
// install-level `agents/../prompts/<name>.md` (shipped alongside the extension),
// then to the provided `fallback` string. Templates use `{{variable}}` placeholders
// replaced at call time.
// Cache for prompt templates so we only read from disk once per session.
// Keyed by `cwd:name` so project-level and install-level templates don't clash.
const promptTemplateCache = new Map<string, string>();

export function loadPromptTemplate(
    name: string,
    fallback: string,
    cwd?: string,
): string {
    const cacheKey = `${cwd ?? ""}:${name}`;
    const cached = promptTemplateCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const candidates: string[] = [];
    if (cwd) candidates.push(join(cwd, ".pi", "prompts", `${name}.md`));
    // Install-level prompts: <ext>/../prompts/<name>.md
    try {
        const extDir = dirname(fileURLToPath(import.meta.url));
        candidates.push(join(extDir, "..", "prompts", `${name}.md`));
    } catch {}
    for (const path of candidates) {
        if (existsSync(path)) {
            try {
                const content = readFileSync(path, "utf-8");
                promptTemplateCache.set(cacheKey, content);
                return content;
            } catch {}
        }
    }
    promptTemplateCache.set(cacheKey, fallback);
    return fallback;
}

// Clear the prompt template cache (for tests).
export function clearPromptTemplateCache(): void {
    promptTemplateCache.clear();
}

// Track which template warnings have been emitted so we only warn once per session.
const renderedTemplateWarnings = new Set<string>();

// Replace `{{key}}` placeholders in a template with values from the map.
export function renderTemplate(
    template: string,
    vars: Record<string, string>,
): string {
    const result = template.replace(
        /\{\{(\w+)\}\}/g,
        (_, key) => vars[key] ?? `{{${key}}}`,
    );
    // Warn about unreplaced placeholders — indicates a broken template.
    // Deduped to once per session so the log isn't spammed every turn.
    const unreplaced = result.match(/\{\{\w+\}\}/g);
    if (unreplaced && unreplaced.length > 0) {
        const unique = [...new Set(unreplaced)];
        const warnKey = unique.join(",");
        if (!renderedTemplateWarnings.has(warnKey)) {
            renderedTemplateWarnings.add(warnKey);
            console.warn(
                `[workflow] Orchestrator prompt template has unreplaced placeholders: ${unique.join(", ")}. Check prompts/orchestrator.md for typos or missing variables.`,
            );
        }
    }
    return result;
}
