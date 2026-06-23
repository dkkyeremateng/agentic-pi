// ABOUTME: Shared, stateless core for the workflow orchestrator extension
// ABOUTME: (agent-workflow.ts). Holds the types,
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
import { createHash } from "crypto";
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
    realpathSync,
} from "fs";
import {
    join,
    basename,
    dirname,
    resolve as resolvePath,
    delimiter as pathDelimiter,
} from "path";
import { fileURLToPath } from "url";
import { defaultSkillRoots } from "../guards/path-guard";
import {
    secs,
    isModelFailure,
    isTransientError,
    digest,
    testSignal,
    outcomeLine,
} from "./workflow-utils";

// This module lives in utils/workflow/. The repo layout is
// <repo>/{utils,extensions,agents,skills,prompts} plus the bundled .env at the
// root, so resolve those siblings relative to this file: utils/workflow/ → utils/
// → <repo>. Downstream code joins from UTILS_DIR (e.g. join(UTILS_DIR, "..",
// "agents")), so this is the single place that encodes where this file sits.
const UTILS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolvePath(UTILS_DIR, "..");

// Max same-model retries on a TRANSIENT agent error (interrupted stream, dropped
// connection, 429/503/…). Tunable via PI_AGENT_TRANSIENT_RETRIES (clamped 0..5).
export function transientRetryLimit(env: NodeJS.ProcessEnv = process.env): number {
    const n = parseInt(env.PI_AGENT_TRANSIENT_RETRIES ?? "2", 10);
    if (Number.isNaN(n)) return 2;
    return Math.max(0, Math.min(5, n));
}

// Base backoff between transient retries (ms); the Nth retry waits base*N.
// Tunable via PI_AGENT_TRANSIENT_BACKOFF_MS (default 1000).
export function transientBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
    const n = parseInt(env.PI_AGENT_TRANSIENT_BACKOFF_MS ?? "1000", 10);
    return Number.isNaN(n) ? 1000 : Math.max(0, n);
}

// ── Config ───────────────────────────────────────

export const REQUIRED_AGENTS = [
    "planner",
    "refiner",
    "implementer",
    "reviewer",
    "validator",
    "shipper",
] as const;
export const DEFAULT_MAX_LOOPS = 3;

// Build a concise session display name for pi.setSessionName, e.g.
// "agent-workflow · plan-build · add CSV export". Omits the team when there isn't one.
export function sessionLabel(
    prefix: string,
    team: string,
    request: string,
): string {
    const req =
        request.length > 48 ? request.slice(0, 47).trimEnd() + "…" : request;
    const mid = team && team.toLowerCase() !== "none" ? ` · ${team}` : "";
    return `${prefix}${mid} · ${req}`;
}

// Display name for a spawned sub-agent's session (pi >= 0.78 `--name`). Without it
// the saved session shows only an opaque hash in pi's resume/session list; with it
// a failed phase is identifiable after the fact, e.g. "todo · implementer".
export function spawnSessionName(cwd: string, agentName: string): string {
    const proj = basename(cwd) || "pi";
    return `${proj} · ${agentName}`;
}

// Appended to EVERY spawned agent's system prompt so any agent answers a trivial
// ping / health check directly instead of running its full workload.
export const TRIVIAL_PING_RULE = `

## Trivial pings
If the ENTIRE request is a trivial ping, greeting, or health check — e.g. "ping",
"pong", "hi", "hello", "hey", "test", "you there?", "status", "are you up?" — do
NOT run your normal workload: no planning, dispatching, tool calls, file writes,
browsing, or analysis. Reply with a single short line confirming you are ready
(e.g. "pong — ready") and stop. Only do real work when the request actually asks
for it.`;

// Rows kept clear below the live panel for the editor + footer + pi's own chrome
// (hint line, spacing). Needs a little slack: if the panel fills to exactly the
// screen height, any extra row tips the terminal into scrolling and the viewport
// bounces up/down on every repaint.
export const LOG_PANEL_RESERVE = 8;
// Generous sanity cap on the live-log panel height. The real bound is the
// extension's clampWidget (terminal rows minus the editor/footer reserve), which
// lets the panel grow to fill the space below the cards; this just stops a giant
// terminal from producing an absurdly tall panel. The full per-phase log is in
// the collapsible card regardless.
export const LOG_PANEL_MAX_ROWS = 24;
export const LOG_CAP_CHARS = 16000; // bound the stored per-phase log
export const STDERR_TAIL_CAP = 2000; // bound the captured stderr tail used in failure reports

// Custom message types + size cap for the inline report and activity-log cards.
export const WORKFLOW_REPORT_TYPE = "workflow-report";
export const WORKFLOW_REPORT_MAX = 50000; // max chars to render inline (markdown is long)
// Separate, smaller cap for the report echoed back in the run_agent_workflow TOOL
// RESULT (what the orchestrator model re-reads) — distinct from WORKFLOW_REPORT_MAX
// (the inline conversation card). Kept tight so a long report doesn't bloat the
// orchestrator's context; the full report is always on disk in workflow-report.md.
export const WORKFLOW_TOOL_REPORT_MAX = 8000;
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
    // `read-only-bash: true` in frontmatter — the agent has `write`/`edit` (so the
    // default read-only-agent heuristic skips it) but its `bash` must stay read-only.
    // The spawn loads readonly-guard.ts for it so mutating git/gh shell commands are
    // blocked even though file writes (e.g. .agent/plan.md) are allowed.
    readOnlyBash?: boolean;
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
    lastStopReason?: string; // stopReason of the last assistant message ("length" = output-token truncation)
}

// ── Active-workflow detection ────────────────────
// The workflow extension (agent-workflow.ts) owns the dashboard/footer. These
// helpers are parameterized over the extension's identity (module URL, filename,
// SELF_NAME) since `import.meta.url` is per-module, so they keep working even if
// another workflow extension is added alongside it later.

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
        if (n === "agent-workflow") return n;
    }
    return null;
}

// Whether the extension with the given SELF_NAME owns the on-screen chrome.
export function isActiveWorkflow(selfName: string): boolean {
    const sel = selectedWorkflowExtension();
    return sel ? sel === selfName : selfName === "agent-workflow";
}

// True when extensions/agent-workflow.ts is among the loaded `-e` extensions. Lets
// the workflow's companion extensions (footer, revert, lsp-panel) gate themselves
// so they activate ONLY alongside agent-workflow. argv-based — known at load time,
// so there's no session_start ordering or globalThis timing to coordinate. Unlike
// isActiveWorkflow() this never defaults to true: no agent-workflow `-e`, no go.
export function agentWorkflowLoaded(): boolean {
    return selectedWorkflowExtension() === "agent-workflow";
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
    // (utils/workflow/workflow-core.ts -> repo root) so the bundled `.env` is found wherever
    // the folder is copied — no hardcoded path. `~/.config/pi` and `~/.pi` remain as
    // optional machine-level fallbacks.
    const repoRoot = REPO_ROOT;
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
    // Sanitize a raw streamed log line for safe single-row rendering. Streamed
    // output can carry ANSI escapes and other control chars (a stray \r or a
    // cursor-move sequence makes the whole terminal jump), and tabs render at an
    // unpredictable width. Strip them so each log line is plain, printable text.
    const sanitize = (s: string): string =>
        s
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
            .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "") // CSI
            .replace(/\x1b[@-Z\\-_]/g, "") // other escapes
            .replace(/\t/g, "  ")
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); // ctrl chars incl. \r (keeps \n)
    // Truncate by DISPLAY width (not char count) so wide glyphs — box-drawing,
    // emoji, CJK — never push a line past `max` and wrap onto a second terminal
    // row, which would make the panel taller than budgeted and bounce the viewport.
    const truncW = (s: string, max: number): string => {
        if (max <= 0) return "";
        if (visibleWidth(s) <= max) return s;
        let out = "";
        for (const ch of s) {
            if (visibleWidth(out) + visibleWidth(ch) > max - 1) break;
            out += ch;
        }
        return out + "…";
    };

    // Parallel dispatch: several agents stream at once. The single live-log panel
    // can only show one of them, so render a compact per-agent status block (label
    // · tools · last line) instead of one agent's full, fast-scrolling stream.
    const runningPhases = phases.filter((p) => p.status === "running");
    if (runningPhases.length > 1) {
        const label = ` ─── ${runningPhases.length} agents · live ─── `;
        const rule = "─".repeat(Math.max(0, width - visibleWidth(label) - 1));
        lines.push("");
        lines.push(theme.fg("dim", label + rule));
        // Fill the available height: everything below the grid except the rows kept
        // clear for the editor + footer (LOG_PANEL_RESERVE). The panel never overlaps
        // the footer but uses the full remaining space for logs.
        const rows = process.stdout.rows || 24;
        const maxRows = Math.max(
            3,
            Math.min(LOG_PANEL_MAX_ROWS, rows - lines.length - LOG_PANEL_RESERVE),
        );
        const bodyStart = lines.length;
        const n = runningPhases.length;
        const clip = (s: string, indent: number) =>
            truncW(sanitize(s), Math.max(10, width - indent - 1));
        const agentLabel = (p: PhaseState) => {
            const toolNote =
                p.toolCount > 0
                    ? ` · ${p.toolCount} tool${p.toolCount === 1 ? "" : "s"}`
                    : "";
            return `${p.label}${toolNote}`;
        };
        const recentLog = (p: PhaseState, count: number) =>
            (p.log || "")
                .split("\n")
                .map((l) => l.replace(/\s+$/, ""))
                .filter((l) => l.length)
                .slice(-count);
        // Give each concurrent agent its own color so interleaved blocks are easy to
        // tell apart. Keyed by position (not name) since parallel agents are often
        // the SAME agent — e.g. three `seeker`s. Wraps if there are more agents than
        // colors. These are theme palette names, so they adapt to the active theme.
        const PALETTE = ["accent", "success", "warning", "toolTitle"];
        const colorOf = (i: number) => PALETTE[i % PALETTE.length];

        // Share the panel height evenly: each agent gets a label line plus up to 5
        // recent log lines when there is room; otherwise fall back to one compact
        // line per agent (label + its latest log line).
        const perAgent = Math.floor(maxRows / n);
        if (perAgent >= 2) {
            // No fixed cap: split the available rows across agents — one label line
            // each, the remaining rows as log lines, with any remainder handed to
            // the earlier agents so the panel is filled.
            const logCapacity = maxRows - n;
            const baseLog = Math.floor(logCapacity / n);
            const extra = logCapacity % n;
            runningPhases.forEach((p, i) => {
                const c = colorOf(i);
                lines.push(
                    "   " + theme.fg(c, theme.bold(clip(agentLabel(p), 3))),
                );
                const allot = baseLog + (i < extra ? 1 : 0);
                for (const l of recentLog(p, allot))
                    lines.push("      " + theme.fg(c, clip(l, 6)));
            });
        } else {
            runningPhases.slice(0, maxRows).forEach((p, i) => {
                const tail = recentLog(p, 1)[0] || "";
                const row = ` ${agentLabel(p)}${tail ? " — " + tail : ""}`;
                lines.push("   " + theme.fg(colorOf(i), clip(row, 3)));
            });
        }
        // Pad to the reserved height so the editor + footer keep their space.
        for (let i = lines.length - bodyStart; i < maxRows; i++) lines.push("");
        return;
    }

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
    // Fill the available height: everything below the grid except the rows kept clear
    // for the editor + footer, so the log uses the full space and pushes the editor +
    // footer to the bottom of the screen.
    const maxLogRows = Math.max(
        3,
        Math.min(LOG_PANEL_MAX_ROWS, rows - lines.length - LOG_PANEL_RESERVE),
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
        lines.push("   " + theme.fg("muted", truncW(sanitize(l), colW)));
    }
    // Pad to the stable panel height so the widget never shrinks.
    for (let i = shown.length; i < bodyRows; i++) lines.push("");
}

// Live orchestration inputs the agent-workflow extension publishes for the footer
// to render. Bridged through globalThis (keyed by WORKFLOW_FOOTER_GLOBAL) so the
// footer can live in its own `pi -e` extension (extensions/footer.ts) yet still
// reflect the orchestrator's running state, cost, and model. agent-workflow.ts
// installs a getter that closes over its live state; the footer calls it per frame.
export interface WorkflowFooterState {
    model: string;
    running: boolean;
    lastStatus: string;
    iteration: number;
    maxLoopsRef: number;
    dispatchMode: boolean;
    phases: PhaseState[];
    dispatchElapsedMs: number;
    runElapsedMs: number;
    primaryCostUsd: number;
    // Prompt-cache hit rate of the primary session (0-100): cached input tokens as
    // a share of all input tokens. Undefined when nothing priced has run yet.
    cacheHitPct?: number;
    contextUsage: () => any;
}
export const WORKFLOW_FOOTER_GLOBAL = "__piWorkflowFooterState";

// Render the footer line: "◆ <model> · <self> <status>      [bar] <pct>", with a
// dim pwd + git branch line above it. An empty `selfName` drops the `· <self>
// <status>` segment (the footer extension's standalone mode). The pure renderer —
// pi-tui helpers and all live state are injected, so it stays pi-tui-free and
// unit-testable. `contextUsage` returns the primary session's usage (or undefined).
export function renderWorkflowFooter(opts: {
    width: number;
    theme: any;
    selfName: string;
    model: string;
    // Working directory + git branch, shown as a dim line above the status line
    // (like pi's stock footer). cwd is home-collapsed to `~`; branch is appended in
    // parens when the session sits in a git repo. Both optional — omit cwd and the
    // pwd line is skipped entirely, leaving the single status line as before.
    cwd?: string;
    gitBranch?: string | null;
    // Working-tree cleanliness, rendered as a mark beside the branch: green ✔ when
    // clean, red ✘ when there are uncommitted changes. null/undefined ⇒ no mark
    // (status unknown, or not a git repo).
    gitDirty?: boolean | null;
    running: boolean;
    lastStatus: string;
    iteration: number;
    maxLoopsRef: number;
    dispatchMode: boolean;
    phases: PhaseState[];
    dispatchElapsedMs: number;
    runElapsedMs: number;
    // USD cost of the primary (orchestrator) session itself, folded into the
    // footer total alongside the sub-agent phase costs. Optional (defaults to 0).
    primaryCostUsd?: number;
    // Prompt-cache hit rate (0-100) of the primary session, shown as `CH NN%`.
    // Omitted from the footer when undefined or 0.
    cacheHitPct?: number;
    contextUsage: () => any;
    visibleWidth: (s: string) => number;
    truncateToWidth: (s: string, w: number, ellipsis?: string) => string;
}): string[] {
    const {
        width,
        theme,
        selfName,
        model,
        cwd,
        gitBranch,
        gitDirty,
        running,
        lastStatus,
        iteration,
        maxLoopsRef,
        dispatchMode,
        phases,
        dispatchElapsedMs,
        runElapsedMs,
        primaryCostUsd = 0,
        cacheHitPct,
        contextUsage,
        visibleWidth,
        truncateToWidth,
    } = opts;

    // Context usage.
    const runningPhases = phases.filter((p) => p.status === "running");

    // Primary (orchestrator) session usage — what the footer reports.
    let usage: any;
    try {
        usage = contextUsage();
    } catch {}
    const primaryTokens =
        usage && typeof usage.tokens === "number" && usage.tokens > 0
            ? usage.tokens
            : 0;
    const primaryPct =
        usage &&
        typeof usage.percent === "number" &&
        !Number.isNaN(usage.percent)
            ? usage.percent
            : null;
    const primaryWindow =
        usage && typeof usage.contextWindow === "number"
            ? usage.contextWindow
            : usage && typeof usage.context_window === "number"
              ? usage.context_window
              : undefined;

    // The footer shows the PRIMARY (orchestrator) session's context. Each sub-agent
    // runs on its own per-agent model/session and shows its OWN context on its card.
    const contextPct = primaryPct;
    const tokenCount = primaryTokens || undefined;
    const contextWindow = primaryWindow;

    const { bar, display: pctStr } = formatContextUsage({
        contextPct,
        tokenCount,
        contextWindow,
        barLength: 10,
        // The footer reports the primary session: trust the provider's percent
        // verbatim rather than recomputing it from tokens/window.
        preferContextPct: true,
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

    const modelPart = theme.fg("dim", ` ◆ ${model}`);
    // The `· <self> <status>` segment is workflow-specific. Omitted when selfName is
    // empty (the footer's standalone mode) — leaving just model · cost · context.
    const namePart = selfName
        ? theme.fg("muted", " · ") +
          theme.fg("accent", selfName) +
          theme.fg("dim", " ") +
          theme.fg(statusColor, statusText)
        : "";
    // Total spend = the primary (orchestrator) session's own cost plus this run's
    // sub-agent phases (each prices its own model). Always shown — $0.00 when
    // nothing priced has run yet — so the field is never mistaken for "missing".
    const totalCostUsd =
        primaryCostUsd +
        phases.reduce((sum, p) => sum + (p.tokens?.costUsd || 0), 0);
    const costStr = theme.fg("muted", `${formatCostUsd(totalCostUsd)} · `);
    // Prompt-cache hit rate, when known and non-zero (a long run with good cache
    // reuse reads ~90%+). Sits between cost and the context bar.
    const chStr =
        typeof cacheHitPct === "number" && cacheHitPct > 0
            ? theme.fg("dim", `CH ${Math.round(cacheHitPct)}% · `)
            : "";
    const right = costStr + chStr + theme.fg("dim", `[${bar}] ${pctStr} `);

    const left = modelPart + namePart;
    const pad = " ".repeat(
        Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
    );
    const statusLine = truncateToWidth(left + pad + right, width);

    // Optional pwd line above the status line: `~/path: branch ✔`, leading space to
    // align under the ` ◆ model`. Home is collapsed to `~`; the branch and its
    // clean/dirty mark are shown only inside a git repo (non-git sessions get just
    // the path). The path/colon stay dim, the branch name takes the same `accent`
    // theme color as `agent-workflow` on the status line below, and the mark is
    // colored — green ✔ clean, red ✘ dirty.
    if (cwd) {
        const home = homedir();
        let pwd = cwd;
        if (home && (cwd === home || cwd.startsWith(home + "/")))
            pwd = "~" + cwd.slice(home.length);
        let pwdSegment: string;
        if (gitBranch) {
            const mark =
                gitDirty == null
                    ? ""
                    : gitDirty
                      ? theme.fg("error", " ✘")
                      : theme.fg("success", " ✔");
            pwdSegment =
                theme.fg("dim", ` ${pwd}: `) +
                theme.fg("accent", gitBranch) +
                mark;
        } else {
            pwdSegment = theme.fg("dim", ` ${pwd}`);
        }
        const pwdLine = truncateToWidth(pwdSegment, width, theme.fg("dim", "…"));
        return [pwdLine, statusLine];
    }
    return [statusLine];
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
        "Implement",
        "Review",
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
        const def: AgentDef = {
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
            readOnlyBash:
                fm["read-only-bash"] === "true" ||
                fm["readonly-bash"] === "true" ||
                undefined,
        };
        // Env-level overrides of the frontmatter: PI_AGENT_<NAME>={model, contextWindow}.
        // (model is still subject to the resolveAgentModel precedence — the more
        // specific PI_AGENT_<NAME>_MODEL and /agent-model override outrank it.)
        const envCfg = parseAgentEnvConfig(fm.name);
        if (envCfg.model) def.model = envCfg.model;
        if (envCfg.contextWindow) def.contextWindow = envCfg.contextWindow;
        return def;
    } catch {
        return null;
    }
}

// Look up a model's context window from pi's model registry entries (models.json
// carries `contextWindow` per model). Matches the configured model string against
// either the bare registry id (e.g. "gateframe_yoda/qwen-max-3-7-yoda-2") or the
// full "provider/id" form. Returns 0 when not found. This lets a sub-agent's card
// show the right window straight from pi's config — no per-agent contextWindow
// needed — which matters for providers with supportsUsageInStreaming:false (their
// streamed usage omits the window).
export function contextWindowForModel(
    models:
        | { id: string; provider: string; contextWindow?: number }[]
        | undefined,
    model: string,
): number {
    if (!models || !model) return 0;
    const m = models.find(
        (x) => x.id === model || `${x.provider}/${x.id}` === model,
    );
    return m && typeof m.contextWindow === "number" && m.contextWindow > 0
        ? m.contextWindow
        : 0;
}

// Derive the per-agent model env var name from an agent key.
// e.g. "seeker" → "PI_AGENT_SEEKER_MODEL", "plan-build" → "PI_AGENT_PLAN_BUILD_MODEL"
export function agentModelEnvVar(agentKey: string): string {
    const name = agentKey.toUpperCase().replace(/[-\s]+/g, "_");
    return `PI_AGENT_${name}_MODEL`;
}

// Build the value passed to pi's `--model` from a configured model string.
// pi's --model parses `[provider/]id[:thinking]` and resolves the provider
// itself, so the configured string is passed through VERBATIM:
//   - bare id        "qwen-max-3-7-yoda-2[:low]"
//   - provider/id    "anthropic/claude-opus-4-8[:low]"
//   - provider/<slashed id>  "gfr_prt/gateframe_yoda/qwen-max-3-7-yoda-2:low"
// (Earlier code stripped the segment before the first slash, which silently
// discarded the provider — e.g. anthropic/claude-… resolved under the DEFAULT
// provider instead of anthropic. That's fixed by not stripping.)
// Returns null when there's no usable model (empty or contains whitespace).
export function spawnModelArg(model: string | undefined): string | null {
    const clean = model?.trim();
    if (!clean || /\s/.test(clean)) return null;
    return clean;
}

// Combined per-agent config env var: PI_AGENT_<NAME>, an object that can set the
// model AND the context window in one place, e.g.
//   PI_AGENT_VALIDATOR={"model":"gateframe_yoda/qwen-max-3-7-yoda-2","contextWindow":1000000}
// Strict JSON is accepted; so is the loose form with unquoted keys/values
// ({model: ..., contextWindow: ...}). Unknown fields are ignored. Returns only the
// recognized fields (empty object when the var is unset or unparseable). These act
// as env-level overrides of the agent's .md frontmatter; the more-specific
// PI_AGENT_<NAME>_MODEL and the /agent-model runtime override still win for model.
export function parseAgentEnvConfig(
    agentKey: string,
    env: Record<string, string | undefined> = process.env,
): { model?: string; contextWindow?: number } {
    const name = agentKey.toUpperCase().replace(/[-\s]+/g, "_");
    const raw = env[`PI_AGENT_${name}`];
    if (!raw || !raw.trim()) return {};

    let obj: Record<string, unknown> = {};
    try {
        obj = JSON.parse(raw);
    } catch {
        // Lenient parse: strip the outer braces and split key: value pairs.
        const body = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
        for (const pair of body.split(",")) {
            const i = pair.indexOf(":");
            if (i < 0) continue;
            const k = pair.slice(0, i).trim().replace(/^["']|["']$/g, "");
            const v = pair
                .slice(i + 1)
                .trim()
                .replace(/^["']|["']$/g, "");
            if (k) obj[k] = v;
        }
    }
    if (!obj || typeof obj !== "object") return {};

    const out: { model?: string; contextWindow?: number } = {};
    const model = obj.model ?? (obj as any).MODEL;
    if (typeof model === "string" && model.trim()) out.model = model.trim();
    const cwRaw =
        (obj as any).contextWindow ??
        (obj as any).context_window ??
        (obj as any).contextwindow;
    const cw =
        typeof cwRaw === "number" ? cwRaw : parseInt(String(cwRaw ?? ""), 10);
    if (Number.isFinite(cw) && cw > 0) out.contextWindow = cw;
    return out;
}

// Runtime per-agent model overrides, set via /agent-model during a session. In
// memory only — NOT persisted, so they reset when pi restarts. Keyed by lowercase
// agent name.
//
// pi loads each `-e` extension in its own module graph, so dispatch.ts and
// agent-workflow.ts each get a SEPARATE copy of this module — a plain
// module-level Map would not be shared between them, and an override set via
// /agent-model (agent-workflow) would be invisible to dispatch_agent (dispatch).
// Anchor the Map on a process-global keyed by a shared Symbol so every module
// copy in the process resolves to the one-and-only store.
const OVERRIDES_KEY = Symbol.for("pi.agentWorkflow.runtimeModelOverrides");
const runtimeModelOverrides: Map<string, string> =
    ((globalThis as any)[OVERRIDES_KEY] ??= new Map<string, string>());

export function setModelOverride(agentKey: string, model: string): void {
    runtimeModelOverrides.set(agentKey.toLowerCase(), model);
}
export function clearModelOverride(agentKey: string): boolean {
    return runtimeModelOverrides.delete(agentKey.toLowerCase());
}
export function clearAllModelOverrides(): number {
    const n = runtimeModelOverrides.size;
    runtimeModelOverrides.clear();
    return n;
}
export function getModelOverride(agentKey: string): string | undefined {
    return runtimeModelOverrides.get(agentKey.toLowerCase());
}
export function getModelOverrides(): ReadonlyMap<string, string> {
    return new Map(runtimeModelOverrides);
}

// Resolve the model for an agent. Precedence:
// 1. Runtime override set via /agent-model this session (setModelOverride)
// 2. PI_AGENT_<NAME>_MODEL env var (e.g. PI_AGENT_SEEKER_MODEL)
// 3. Agent .md frontmatter `model:` field
// 4. PI_WORKFLOW_MODEL env var
// 5. fallback (caller-provided)
export function resolveAgentModel(
    agentKey: string,
    agents: Map<string, AgentDef>,
    workflowModel: string,
    fallback: string,
): string {
    const override = runtimeModelOverrides.get(agentKey.toLowerCase());
    if (override) return override;
    const envModel = process.env[agentModelEnvVar(agentKey)];
    if (envModel) return envModel;
    const def = agents.get(agentKey.toLowerCase());
    if (def?.model) return def.model;
    return workflowModel || fallback;
}
// Project agents in `.pi/agents/` take precedence; extension agents serve as fallback.
export function loadAgents(cwd: string): Map<string, AgentDef> {
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
    const extensionDir = UTILS_DIR;
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
// Avoids a YAML dependency; mirrors the agent-workflow extension's parser.
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
export function loadTeams(cwd: string): Record<string, string[]> {
    // First, try project-level teams from cwd/.pi/agents/teams.yaml
    const projectTeamsFile = join(cwd, ".pi", "agents", "teams.yaml");
    if (existsSync(projectTeamsFile)) {
        try {
            return parseTeamsYaml(readFileSync(projectTeamsFile, "utf-8"));
        } catch {}
    }

    // Fallback to extension-level teams
    const extensionDir = UTILS_DIR;
    const teamsFile = join(extensionDir, "..", "agents", "teams.yaml");
    if (existsSync(teamsFile)) {
        try {
            return parseTeamsYaml(readFileSync(teamsFile, "utf-8"));
        } catch {}
    }

    return {};
}

// ── Skills (skills/<name>/SKILL.md) ──────────────

export interface SkillDef {
    name: string;
    description: string;
}

function parseSkillFile(filePath: string, fallbackName: string): SkillDef | null {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
        const fm: Record<string, string> = {};
        if (match) {
            for (const line of match[1].split("\n")) {
                const idx = line.indexOf(":");
                if (idx <= 0) continue;
                const key = line.slice(0, idx).trim();
                let val = line.slice(idx + 1).trim();
                if (
                    (val.startsWith('"') && val.endsWith('"')) ||
                    (val.startsWith("'") && val.endsWith("'"))
                ) {
                    val = val.slice(1, -1);
                }
                fm[key] = val;
            }
        }
        return {
            name: fm.name || fallbackName,
            description: fm.description || "",
        };
    } catch {
        return null;
    }
}

// Load skill metadata (name + one-line description) from every `<dir>/<name>/SKILL.md`.
// Project skills (cwd/.claude/skills, cwd/.pi/skills, cwd/skills) take precedence;
// the bundled `skills/` dir (sibling of this folder) is the fallback. Used to tell
// the orchestrator which skills it can use — adding a SKILL.md needs no code change.
export function loadSkills(cwd: string): SkillDef[] {
    const byName = new Map<string, SkillDef>();
    const extensionDir = UTILS_DIR;
    const dirs = [
        join(cwd, ".claude", "skills"),
        join(cwd, ".pi", "skills"),
        join(cwd, "skills"),
        join(extensionDir, "..", "skills"),
    ];
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
            for (const entry of readdirSync(dir)) {
                const skillFile = join(dir, entry, "SKILL.md");
                if (!existsSync(skillFile)) continue;
                const def = parseSkillFile(skillFile, entry);
                if (def && !byName.has(def.name.toLowerCase())) {
                    byName.set(def.name.toLowerCase(), def);
                }
            }
        } catch {}
    }
    return Array.from(byName.values());
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

// Render the list of all defined teams (members), marking the active one.
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
                const active = name === activeTeamName ? "  ← active" : "";
                return `  ${name}: ${ms}${active}`;
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
        return `${name} — ${members.join(", ")}`;
    });
    const choice = await ctx.ui.select("Select Team", options);
    if (choice === undefined) return null;
    return teamNames[options.indexOf(choice)];
}

// Infer a team from the request text when the caller named none. Today it only
// recognizes "build / implement an existing plan" intent — a build/implement verb
// AND a reference to "the plan" / "implementation plan" (e.g. "build the
// implementation plan", "implement the plan") — and maps it to the planner-less
// `build` team, which resumes from the saved .agent/plan.md instead of re-planning.
// "build a plan" / "create an implementation plan" do NOT match (that's planning,
// not building from one). Returns "" when nothing matches or the team isn't defined.
export function inferWorkflowTeam(
    request: string,
    teams: Record<string, string[]>,
): string {
    const r = (request || "").toLowerCase();
    const hasBuildVerb = /\b(build|implement(?:s|ing|ed)?)\b/.test(r);
    const refsExistingPlan = /\b(implementation plan|the plan)\b/.test(r);
    if (hasBuildVerb && refsExistingPlan && teams["build"]) return "build";
    return "";
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
export function setupSessions(_cwd: string, wipe: boolean): string {
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
        if (!f.endsWith(".jsonl")) continue;
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
// the orchestrator state. Used by the agent-workflow extension and the dispatch
// extension, keeping each one's state ownership clear. `state` is the extension's
// OrchestratorState (typed loosely to avoid a circular import with
// orchestrator-core.ts).
export function makeSpawnWrapper(opts: {
    state: {
        totalTokens: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
        };
        totalToolCalls: number;
        totalDroppedLines: number;
        totalCostUsd: number;
    };
    sessionDir: string | (() => string);
    agentTimeoutMs: number;
    updateWidget: () => void;
    setCurrentProc: (proc: any) => void;
    getFallbackContextWindow?: (model: string) => number;
    isProjectTrusted?: () => boolean | undefined;
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
        agentTimeoutMs,
        updateWidget,
        setCurrentProc,
        getFallbackContextWindow,
        isProjectTrusted,
    } = opts;
    const getSessionDir =
        typeof sessionDirOpt === "function"
            ? sessionDirOpt
            : () => sessionDirOpt;
    return (agentDef, task, phase, cwd, model) => {
        const cfg: SpawnConfig = {
            sessionDir: getSessionDir(),
            agentTimeoutMs,
            updateWidget,
            setCurrentProc,
            getFallbackContextWindow,
            isProjectTrusted,
        };
        const prevToolCount = phase.toolCount;
        const prevDroppedLines = phase.droppedLines;
        return spawnAgentWithModel(agentDef, task, phase, cwd, model, cfg).then(
            (result) => {
                if (result.tokens) {
                    state.totalTokens.input += result.tokens.input;
                    state.totalTokens.output += result.tokens.output;
                    state.totalTokens.cacheRead += result.tokens.cacheRead || 0;
                    state.totalTokens.cacheWrite += result.tokens.cacheWrite || 0;
                    state.totalCostUsd += result.tokens.costUsd || 0;
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
    // Trust the provider-reported `contextPct` (current occupancy, cache/
    // compaction-aware) over recomputing it from tokenCount/contextWindow. The
    // primary-session footer sets this; the per-agent cards leave it off so their
    // percent stays consistent with the frontmatter window they display.
    preferContextPct?: boolean;
}): { bar: string; display: string; known: boolean } {
    const {
        contextPct,
        tokenCount,
        contextWindow,
        barLength = 10,
        preferContextPct = false,
    } = opts;

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
    if (preferContextPct && known) {
        // Use the provider's reported percent verbatim (matches pi-context-usage),
        // not a raw tokens/window recompute that ignores caching/compaction.
        pct = Math.min(100, contextPct!);
        pctKnown = true;
    } else if (ctxKnown && tokenCount && tokenCount > 0) {
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

export interface ReportTotals {
    runElapsedMs: number;
    totalToolCalls: number;
    totalTokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    totalDroppedLines: number;
    totalCostUsd?: number;
}

function totalsLine(t: ReportTotals): string {
    const tt = t.totalTokens;
    const cache = (tt.cacheRead || 0) + (tt.cacheWrite || 0);
    const grand = tt.input + tt.output + cache;
    // Token total includes cache read/write so it lines up with the cost.
    const tok =
        grand > 0
            ? ` · ${grand.toLocaleString()} tokens (${tt.input.toLocaleString()} in / ${tt.output.toLocaleString()} out${cache > 0 ? ` / ${cache.toLocaleString()} cache` : ""})`
            : "";
    const cost = ` · ${formatCostUsd(t.totalCostUsd)}`;
    return `${secs(t.runElapsedMs)} wall-clock · ${t.totalToolCalls} tool call(s)${tok}${cost}`;
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
    planP: PhaseState | null;
    refinerP: PhaseState | null;
    implP: PhaseState | null;
    reviewerP: PhaseState | null;
    valP: PhaseState | null;
    shipP: PhaseState | null;
    scoutFindings: string;
    plan: string;
    impl: string;
    review: string;
    val: string;
    ship: string;
}): string {
    // Each section appears only when its phase actually ran — the active team
    // determines which phases exist.
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
        ...(o.planP ? [summaryLine("Planner", o.planP, digest(o.plan))] : []),
        ...(o.refinerP
            ? [
                  summaryLine(
                      "Refiner",
                      o.refinerP,
                      "reviewed and hardened the plan",
                  ),
              ]
            : []),
        ...(o.implP
            ? [summaryLine("Implementer", o.implP, digest(o.impl))]
            : []),
        ...(o.reviewerP
            ? [summaryLine("Reviewer", o.reviewerP, digest(o.review))]
            : []),
        ...(o.valP
            ? [
                  summaryLine(
                      "Validator",
                      o.valP,
                      `verdict ${o.verdict.toUpperCase()}. ${digest(o.val)}${testSignal(o.val)}`,
                  ),
              ]
            : []),
        ...(o.shipP ? [summaryLine("Ship", o.shipP, digest(o.ship))] : []),
        ``,
        `## Details`,
        ``,
        ...(o.scoutP
            ? [`### Reconnaissance`, ``, truncatePhaseOutput(o.scoutFindings), ``]
            : []),
        ...(o.planP ? [`### Plan`, ``, truncatePhaseOutput(o.plan), ``] : []),
        ...(o.implP
            ? [`### Implementation`, ``, truncatePhaseOutput(o.impl), ``]
            : []),
        ...(o.reviewerP
            ? [`### Review`, ``, truncatePhaseOutput(o.review), ``]
            : []),
        ...(o.valP
            ? [`### Validation`, ``, truncatePhaseOutput(o.val), ``]
            : []),
        ...(o.shipP ? [`### Ship`, ``, truncatePhaseOutput(o.ship), ``] : []),
    ].join("\n");
}

// ── Structured run metrics (machine-readable sibling of the report) ─────────
// buildWorkflowReport emits human markdown; this emits the same run as JSON so
// the observability analyzer (obs/obs-cli.ts) has a precise, single-run record
// instead of re-parsing the markdown. Same call site, same inputs.

export interface PhaseMetrics {
    label: string;
    agent: string;
    status: string;
    elapsedMs: number;
    attempt: number;
    toolCount: number;
    modelFallback: boolean;
    activeModel?: string;
    droppedLines: number;
    tokens?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
        costUsd?: number;
    };
}

export interface WorkflowMetrics {
    schema: number; // bump on shape changes
    startedAt?: string; // ISO
    endedAt: string; // ISO
    request: string;
    team?: string;
    status: string; // raw terminal status (e.g. "paused-no-remote")
    shipOutcome: "shipped" | "paused" | "failed" | "unknown";
    verdict: string;
    passes: number; // attempts used
    maxLoops: number;
    passed: boolean;
    prUrl: string;
    totals: {
        wallclockMs: number;
        toolCalls: number;
        droppedLines: number;
        costUsd?: number;
        tokens: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
    };
    phases: PhaseMetrics[];
}

function phaseMetrics(p: PhaseState): PhaseMetrics {
    const t = p.tokens;
    const cacheRead = t?.cacheRead || 0;
    const cacheWrite = t?.cacheWrite || 0;
    return {
        label: p.label,
        agent: p.agent,
        status: p.status,
        elapsedMs: p.elapsed,
        attempt: p.attempt,
        toolCount: p.toolCount,
        modelFallback: p.modelFallback,
        activeModel: p.activeModel,
        droppedLines: p.droppedLines,
        tokens: t
            ? {
                  input: t.input,
                  output: t.output,
                  cacheRead,
                  cacheWrite,
                  total: t.input + t.output + cacheRead + cacheWrite,
                  costUsd: t.costUsd,
              }
            : undefined,
    };
}

function shipOutcomeFromStatus(
    status: string,
    prUrl: string,
): WorkflowMetrics["shipOutcome"] {
    if (prUrl || /shipped/i.test(status)) return "shipped";
    if (/paus/i.test(status)) return "paused";
    if (/fail|block|abort/i.test(status)) return "failed";
    return "unknown";
}

export function buildWorkflowMetrics(o: {
    request: string;
    status: string;
    verdict: string;
    passes: number;
    maxLoops: number;
    passed: boolean;
    prUrl: string;
    team?: string;
    startedAt?: number;
    endedAt?: number;
    totals: ReportTotals;
    phases: (PhaseState | null)[];
}): WorkflowMetrics {
    const tt = o.totals.totalTokens;
    const cacheRead = tt.cacheRead || 0;
    const cacheWrite = tt.cacheWrite || 0;
    return {
        schema: 1,
        startedAt: o.startedAt
            ? new Date(o.startedAt).toISOString()
            : undefined,
        endedAt: new Date(o.endedAt ?? Date.now()).toISOString(),
        request: o.request,
        team: o.team || undefined,
        status: o.status,
        shipOutcome: shipOutcomeFromStatus(o.status, o.prUrl),
        verdict: o.verdict,
        passes: o.passes,
        maxLoops: o.maxLoops,
        passed: o.passed,
        prUrl: o.prUrl,
        totals: {
            wallclockMs: o.totals.runElapsedMs,
            toolCalls: o.totals.totalToolCalls,
            droppedLines: o.totals.totalDroppedLines,
            costUsd: o.totals.totalCostUsd,
            tokens: {
                input: tt.input,
                output: tt.output,
                cacheRead,
                cacheWrite,
                total: tt.input + tt.output + cacheRead + cacheWrite,
            },
        },
        phases: o.phases
            .filter((p): p is PhaseState => !!p)
            .map(phaseMetrics),
    };
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

// Extract the phase headings ("Phase N: Title") from a plan, in order. Used to
// seed the implementer's progress ledger so phase status is tracked from the start
// (the implementer only flips [ ] -> [x]) rather than relying on it to build the
// list itself.
export function parsePlanPhases(plan: string): string[] {
    const out: string[] = [];
    for (const raw of (plan || "").split(/\r?\n/)) {
        const m = /^#{1,6}\s+(Phase\s+\d+\b[^\n]*?)\s*$/i.exec(raw);
        if (m) out.push(m[1].trim());
    }
    return out;
}

// One entry of the implementer's progress ledger (.agent/progress.md). Feeds the
// dashboard's live Todos panel as the implementer flips phases [ ] -> [x].
export interface ProgressItem {
    label: string;
    done: boolean;
}

// Parse the checkbox lines ("- [ ] …" / "- [x] …") out of the progress ledger,
// in order. Non-checkbox lines (the heading, the `Base:` line, blanks) are ignored.
export function parseProgressLedger(content: string): ProgressItem[] {
    const out: ProgressItem[] = [];
    for (const raw of (content || "").split(/\r?\n/)) {
        const m = /^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/.exec(raw);
        if (m) out.push({ done: m[1].toLowerCase() === "x", label: m[2] });
    }
    return out;
}

// The reviewer's fixed review checklist, shown as a live panel while the reviewer
// phase runs. Mirror of the "## Review Checklist" in agents/reviewer.md — keep in
// sync. The reviewer is read-only (no .agent ledger to tick per item), so the panel
// reflects phase status: working while it runs, all checked once it finishes.
export const REVIEW_CHECKLIST = [
    "Plan conformance",
    "Acceptance criteria",
    "Correctness",
    "Completeness",
    "Regressions",
    "Error handling",
    "Tests",
];

// Build the reviewer's checklist items from the run's phases. Empty (panel hidden)
// until the reviewer phase has started. While it runs, items tick live from
// `doneLabels` — the set of checks the reviewer has reported finishing via its
// stream markers (best-effort; empty when the model emits none). Once the phase
// settles, every item reads done (done = the reviewer worked through that check,
// not that the code passed it), so a non-marking model still ends fully checked.
export function buildReviewChecklist(
    phases: PhaseState[],
    doneLabels?: Iterable<string>,
): ProgressItem[] {
    const ph = phases.find((p) => p.agent === "reviewer");
    if (!ph || ph.status === "pending") return [];
    if (ph.status === "running") {
        const done = new Set(doneLabels ?? []);
        return REVIEW_CHECKLIST.map((label) => ({ label, done: done.has(label) }));
    }
    const done = ph.status === "done";
    return REVIEW_CHECKLIST.map((label) => ({ label, done }));
}

// ── Shared run context (curated cross-agent bundle) ──
// Durable artifacts earlier pipeline phases produced. Prepended to a later
// agent's task so every agent can build on the others' work without the lossy
// digest-into-the-next-prompt handoff. Used by the agent-workflow extension (on by
// default; opt out with PI_AGENT_WORKFLOW_SHARED_CONTEXT=0).
export interface RunArtifacts {
    recon?: string; // scout findings
    plan?: string; // approved plan
    review?: string; // reviewer's verdict + findings
    implSummary?: string; // implementer's change summary (includes the tests it wrote)
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
    add("Implementation summary (implementer)", a.implSummary);
    add("Review (reviewer)", a.review);
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
// doesn't need the review, the validator doesn't need the recon dump, etc.
// Selective bundling reduces token consumption ~30% on complex runs.
const PHASE_ARTIFACT_WHITELIST: Record<string, (keyof RunArtifacts)[]> = {
    scout: ["recon"],
    planner: ["recon"],
    refiner: [], // refineTask threads BOTH the draft plan and the recon inline,
    // so the bundle must add nothing — otherwise recon is sent twice.
    // The plan distills the recon and these agents read real code themselves, so
    // recon is largely redundant. Keep it for the implementer — it writes code
    // across the codebase and genuinely uses the scout's map — but drop it for the
    // reviewer/validator, which work against the plan + diff + tests. (Plan and
    // implSummary are threaded inline by each task builder, hence absent here.)
    implementer: ["recon"],
    reviewer: [],
    validator: [],
    // shipTask threads only the validation report, so the implementer's change
    // summary (for the PR body) is added here. The full plan is NOT — no full plan
    // belongs in any bundle; the shipper reads .agent/plan.md from disk if it needs
    // requirement/acceptance context. recon is redundant for it too.
    shipper: ["implSummary"],
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

// Bound a prior change summary threaded into a retry task. Kept whole when small
// (the common case — no loss), head-truncated only when long. Head-truncation
// preserves the report's leading sections (Requirement, Files Changed, Key
// Changes, Tests), with a pointer to the full record for the rest.
export function clampSummary(text: string, max = 2500): string {
    const t = (text || "").trim();
    if (t.length <= max) return t;
    return (
        t.slice(0, max) +
        "\n\n… [truncated — full detail in the per-phase commits and `.agent/progress.md`]"
    );
}

// Safety ceiling on a phase's agent output before it flows downstream — threaded
// into the next agent's task, stored for the context bundle, or put in the report.
// Normal outputs are well under this and pass through untouched; a runaway output
// (e.g. a validator dumping a full test log) is clamped keeping the HEAD and TAIL,
// so leading structure AND any trailing VERDICT/summary survive — both verdict
// detection (markers are first-line or last-line) and the next agent stay safe.
export const PHASE_OUTPUT_MAX = 24000;
export function clampOutput(text: string, max = PHASE_OUTPUT_MAX): string {
    const t = text || "";
    if (t.length <= max) return t;
    const head = Math.floor(max * 0.7);
    const tail = max - head;
    return (
        t.slice(0, head) +
        `\n\n... [output truncated — ${t.length - max} chars omitted] ...\n\n` +
        t.slice(t.length - tail)
    );
}

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
        "Emit the COMPLETE plan as your final message — that is your deliverable; the workflow saves it to `.agent/plan.md` for the downstream agents. Do not emit a summary in place of the plan. Start the message at the `# Plan:` heading — no preamble, acknowledgement, or closing remarks; the whole message is the plan.",
        "",
        "Request:",
        original,
        "",
        ...reconBlock(recon),
    ].join("\n");
}

export function refineTask(original: string, recon = ""): string {
    return [
        "Review and refine the implementation plan before it goes to the implementer.",
        "Read the draft plan from `.agent/plan.md` and VERIFY its load-bearing claims against the actual files (read/grep the real files — every path, every 'exists/missing', every symbol location; the draft and any recon can describe a codebase that isn't there). Then apply your production-grade review rules.",
        "Keep the required structure (## Phase N, Acceptance Criteria, file-level specificity); refine, do not rewrite from scratch.",
        "Emit the COMPLETE hardened plan as your final message — that is your deliverable; the workflow saves it to `.agent/plan.md` (overwriting the draft) for the downstream agents. Do not emit a summary in place of the plan. Start the message at the `# Plan:` heading — no preamble, acknowledgement, or closing remarks; the whole message is the plan.",
        "",
        "Original request:",
        original,
        "",
        ...reconBlock(recon),
    ].join("\n");
}

export function reviewTask(
    original: string,
    implSummary: string,
    priorReview = "",
): string {
    const lines = [
        "Review the implementation the implementer just produced against the plan.",
        "Read the plan from `.agent/plan.md` and the changed files in the working directory.",
        "Return APPROVED, or REVISE BEFORE MERGE with specific required fixes.",
        "",
        "Original request:",
        original,
        "",
        "Implementer's change summary:",
        implSummary,
    ];
    if (priorReview.trim()) {
        lines.push(
            "",
            "This is a RE-REVIEW — the implementer just addressed your previous round. Verify each finding you raised: drop the ones now fixed, re-raise (with current evidence) only what is still unfixed, and check the fix introduced no new issues. Do not re-derive the whole review from scratch.",
            "Your previous review:",
            clampOutput(priorReview, 3000),
        );
    }
    return lines.join("\n");
}

export function reviewFixTask(
    original: string,
    review: string,
    prevSummary: string,
): string {
    return [
        "The reviewer REQUESTED CHANGES to your implementation. Address exactly the issues raised — do not start over.",
        "The approved plan is in `.agent/plan.md`.",
        "",
        "Original request:",
        original,
        "",
        "Your previous change summary (truncated if long — full detail is in your per-phase commits and `.agent/progress.md`):",
        clampSummary(prevSummary),
        "",
        "Reviewer findings to address:",
        review,
    ].join("\n");
}

export function implementTask(original: string): string {
    return [
        "Implement the approved plan in `.agent/plan.md` — read it for the phases, file list, and acceptance criteria.",
        "",
        "Original request:",
        original,
    ].join("\n");
}

export function fixTask(
    original: string,
    feedback: string,
    prevSummary: string,
): string {
    return [
        "The validator REJECTED the previous attempt. Fix exactly the issues raised.",
        "The approved plan is in `.agent/plan.md`.",
        "",
        "Original request:",
        original,
        "",
        "Your previous change summary (truncated if long — full detail is in your per-phase commits and `.agent/progress.md`):",
        clampSummary(prevSummary),
        "",
        "Validator findings to address:",
        feedback,
    ].join("\n");
}

export function validateTask(original: string, implSummary: string): string {
    return [
        "Validate the completed work as the independent gate. RUN the full test suite",
        "yourself (including the tests the implementer wrote) and confirm EVERY",
        "acceptance criterion in the plan holds. Return VERDICT: PASS, or VERDICT: FAIL",
        "with the specific failures the implementer must fix.",
        "Read the plan (and its acceptance criteria) from `.agent/plan.md`.",
        "",
        "Original requirement:",
        original,
        "",
        "Implementer's change summary (lists the code AND tests it wrote):",
        implSummary,
    ].join("\n");
}

export function shipTask(original: string, validationReport: string): string {
    return [
        "The change has passed validation. Ship it — commit the code, tests, and any",
        "doc updates the implementer made as part of the change.",
        "",
        "Original requirement:",
        original,
        "",
        "Validation report:",
        validationReport,
    ].join("\n");
}

// ── Phase helpers ───────────────────────────────

// Type-safe access to phases by agent name. Built from the phases array so
// callers never rely on positional indexing (which breaks silently if
// freshPhases() changes order).
export interface PhaseMap {
    scout: PhaseState | null;
    planner: PhaseState | null;
    refiner: PhaseState | null;
    implementer: PhaseState | null;
    reviewer: PhaseState | null;
    validator: PhaseState | null;
    shipper: PhaseState | null;
}

// Build a PhaseMap from the phases array. Every phase is optional: the runner
// runs only the phases the active team actually contains (gating each block on
// presence), so a phase the team omitted is simply null.
export function buildPhaseMap(phases: PhaseState[]): PhaseMap {
    const byAgent = (name: string): PhaseState | null =>
        phases.find((p) => p.agent === name.toLowerCase()) ?? null;

    return {
        scout: byAgent("scout"),
        planner: byAgent("planner"),
        refiner: byAgent("refiner"),
        implementer: byAgent("implementer"),
        reviewer: byAgent("reviewer"),
        validator: byAgent("validator"),
        shipper: byAgent("shipper"),
    };
}

// Standardised error return for a failed phase. Sets the running state to
// stopped/error and returns the shape runWorkflow uses. Eliminates the 7-line
// `if (!x.ok) { running = false; ... }` block repeated for every phase.
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

// The canonical pipeline order. A team runs exactly the subsequence of these
// phases that its roster contains, in this order — there is no separate execution
// "mode"; the team's membership IS the pipeline (e.g. the `spec` team is just
// scout -> planner -> refiner).
export const PIPELINE_ORDER = [
    "scout",
    "planner",
    "refiner",
    "implementer",
    "reviewer",
    "validator",
    "shipper",
] as const;

const PHASE_LABELS: Record<string, string> = {
    scout: "Scout",
    planner: "Plan",
    refiner: "Refine",
    implementer: "Implement",
    reviewer: "Review",
    validator: "Validate",
    shipper: "Ship",
};

// Build the initial phase array from the active team's roster: the subsequence
// of PIPELINE_ORDER that the team includes, in canonical order. Members that are
// not pipeline phases (e.g. a web `seeker`) are ignored by the linear workflow.
export function freshPhases(members: string[]): PhaseState[] {
    const set = new Set(members.map((m) => m.toLowerCase()));
    return PIPELINE_ORDER.filter((a) => set.has(a)).map((a) =>
        mkPhase(PHASE_LABELS[a], a),
    );
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
    const agentName = displayName(agentDef.name);
    const maxTransient = transientRetryLimit();
    const backoffMs = transientBackoffMs();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Run one model, retrying IN PLACE on transient errors (interrupted stream,
    // dropped connection, 429/503/…) up to maxTransient times with linear backoff.
    // These are infrastructure hiccups, not model-config or logical failures, so the
    // same model is retried rather than failing the phase / falling back.
    const attempt = async (model: string) => {
        let r = await spawnFn(agentDef, task, phase, cwd, model);
        for (
            let tries = 1;
            tries <= maxTransient &&
            r.exitCode !== 0 &&
            isTransientError(r.output) &&
            !isModelFailure(r.output);
            tries++
        ) {
            const first = (r.output.match(/\[agent error\][^\n]*/) ||
                r.output.split("\n").filter((l) => l.trim()))[0] || "transient error";
            phase.note = `⚠ transient error — retry ${tries}/${maxTransient}`;
            phase.toolCount = 0;
            phase.contextPct = 0;
            phase.droppedLines = 0;
            phase.log += `\n⚠ Transient error (retry ${tries}/${maxTransient}): ${first.slice(0, 200)}\n`;
            opts.notify?.(
                `${agentName}: transient error — retrying (${tries}/${maxTransient})…`,
                "warning",
            );
            opts.updateWidget();
            await sleep(backoffMs * tries); // linear backoff
            r = await spawnFn(agentDef, task, phase, cwd, model);
        }
        return r;
    };

    const result = await attempt(primaryModel);

    // Only model-specific load/run failures trigger a fallback — timeouts,
    // tool failures, and bad output are not retried.
    if (result.exitCode !== 0 && isModelFailure(result.output)) {

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

        const retry = await attempt(fallbackModel);
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

    // Bound the output before it flows into the next phase's task / the context
    // bundle / the report — a safety ceiling so a verbose agent can't overload the
    // next. The plan is unaffected: the orchestrator re-reads it from .agent/plan.md.
    return { output: clampOutput(res.output), ok: statusWord === "done" };
}

// ── Token tracking ───────────────────────────────

// Per-phase token usage captured from the agent's message_end event. Both
// input and output tokens are tracked so the workflow report can show cost
// estimates and a total across all phases.
export interface TokenUsage {
    input: number;
    output: number;
    cacheRead?: number; // tokens read from prompt cache (summed across turns)
    cacheWrite?: number; // tokens written to prompt cache (summed across turns)
    contextWindow: number; // 0 when unknown
    costUsd?: number; // USD cost for this phase: sum of per-turn usage.cost.total
}

// Total billed tokens for a usage record — input + output + cache read/write — so
// the displayed token count lines up with the cost (which also prices cache).
export function totalTokens(u: TokenUsage | undefined): number {
    if (!u) return 0;
    return (
        (u.input || 0) +
        (u.output || 0) +
        (u.cacheRead || 0) +
        (u.cacheWrite || 0)
    );
}

// Format a USD cost compactly for cards/footers/report. Sub-cent costs get extra
// precision so cheap runs don't all collapse to "$0.00".
export function formatCostUsd(usd: number | undefined): string {
    if (!usd || usd <= 0) return "$0.00";
    if (usd < 0.01) return "$" + usd.toFixed(4);
    if (usd < 1) return "$" + usd.toFixed(3);
    return "$" + usd.toFixed(2);
}

// Format a per-phase token note for the workflow report summary line.
// Returns ", Nk tokens" when tokens are present, or "" otherwise.
export function tokenNote(phase: PhaseState): string {
    const total = totalTokens(phase.tokens);
    if (!phase.tokens || total === 0) return "";
    const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
    // Token count includes cache read/write so it matches the cost basis. Always
    // show cost ($0.00 for unpriced models) so every phase reads consistently.
    return `, ${k} tokens, ${formatCostUsd(phase.tokens.costUsd)}`;
}

// ── Shared agent spawn ────────────────────────────

// Configuration for spawning a sub-agent subprocess. Extracted so both
// extension (agent-workflow) and the WorkflowRuntime class
// share one implementation instead of carrying ~220-line copies.
export interface SpawnConfig {
    sessionDir: string;
    agentTimeoutMs: number;
    updateWidget: () => void;
    setCurrentProc: (proc: any) => void;
    // Context window for the bar when the provider doesn't report one in usage
    // (e.g. supportsUsageInStreaming:false) and the agent has none configured.
    // Given the resolved model, returns its window — e.g. a pi model-registry
    // lookup, falling back to the primary session's window. Per-agent config
    // (agentDef.contextWindow) still wins.
    getFallbackContextWindow?: (model: string) => number;
    // pi's authoritative project-trust answer (ctx.isProjectTrusted(), pi >= 0.79.1),
    // used to decide --approve for the spawn. Returns undefined when no ctx/API is
    // available, in which case shouldApproveProjectForSpawn falls back to the disk
    // read. Wired from the extension so we don't re-implement pi's trust resolution.
    isProjectTrusted?: () => boolean | undefined;
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
export function dispatchEnv(
    agentName: string,
    dispatchId?: string,
): Record<string, string> {
    const depth = parseInt(process.env.PI_DISPATCH_DEPTH || "0", 10) || 0;
    const ancestry = process.env.PI_DISPATCH_ANCESTRY || "";
    const name = agentName.toLowerCase();
    const env: Record<string, string> = {
        PI_SUBAGENT: "1",
        PI_DISPATCH_DEPTH: String(depth + 1),
        PI_DISPATCH_ANCESTRY: ancestry ? `${ancestry}>${name}` : name,
    };
    // Label this sub-agent's observability lane (obs-live.ts reads it) and carry
    // the trace linkage down: PI_OBS_RUN is the shared trace id (minted by the root
    // orchestrator's collector); PI_OBS_PARENT is THIS process's agent — the one
    // doing the dispatching — so the child knows who spawned it. PI_OBS_DISPATCH_ID
    // ties the child's events back to the orchestrator's dispatch_* events for this
    // exact dispatch, so concurrent instances of the same agent stay distinct.
    if (process.env.PI_OBS === "1" || process.env.PI_OBS === "true") {
        env.PI_OBS_AGENT = name;
        if (process.env.PI_OBS_RUN) env.PI_OBS_RUN = process.env.PI_OBS_RUN;
        env.PI_OBS_PARENT = (process.env.PI_OBS_AGENT || "orchestrator").toLowerCase();
        if (dispatchId) env.PI_OBS_DISPATCH_ID = dispatchId;
    }
    return env;
}

// Whether a spawned (headless) sub-agent should be told to trust the project's
// local inputs (AGENTS.md/CLAUDE.md, .pi settings/resources/skills) via --approve.
//
// Background (pi >= 0.79): non-interactive modes (-p / --mode json) never show a
// trust prompt and, without a SAVED trust decision, silently IGNORE project-local
// inputs unless --approve is passed. Our sub-agents run --mode json -p, so without
// this they would stop honoring the repo's conventions and nobody would notice.
//
// Resolution order:
//   1. PI_WORKFLOW_APPROVE_PROJECT=1 forces on (e.g. session-only trust); =0 forces
//      off. This explicit override always wins.
//   2. `authoritativeTrusted` — pi's own answer from ctx.isProjectTrusted() (pi
//      >= 0.79.1), passed down from the extension. Preferred when available: it is
//      pi's live trust decision, so it can't drift from pi's internal format.
//   3. Disk fallback — for contexts with no ctx (or older pi where the API is
//      absent). Mirrors pi's resolution: trust store at ~/.pi/agent/trust.json (or
//      $PI_CODING_AGENT_DIR), keyed by the canonical cwd — realpathSync(resolve(cwd)),
//      falling back to resolve(cwd) when the path can't be realpath'd. Approves iff
//      the saved decision for this cwd is exactly `true`. A saved `false` (declined)
//      or absent decision is respected by NOT approving.
//
// The disk fallback re-implements pi internals, so prefer passing the ctx answer.
export function shouldApproveProjectForSpawn(
    cwd: string,
    authoritativeTrusted?: boolean,
): boolean {
    const env = process.env.PI_WORKFLOW_APPROVE_PROJECT;
    if (env === "0") return false;
    if (env === "1") return true;
    // Prefer pi's authoritative trust decision when the caller supplied one.
    if (typeof authoritativeTrusted === "boolean") return authoritativeTrusted;
    const expand = (p: string) =>
        p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    const agentDir = process.env.PI_CODING_AGENT_DIR
        ? expand(process.env.PI_CODING_AGENT_DIR)
        : join(homedir(), ".pi", "agent");
    const trustPath = join(agentDir, "trust.json");
    if (!existsSync(trustPath)) return false;
    let key: string;
    const resolved = resolvePath(cwd);
    try {
        key = realpathSync(resolved);
    } catch {
        key = resolved;
    }
    try {
        const data = JSON.parse(readFileSync(trustPath, "utf-8"));
        return data && typeof data === "object" && data[key] === true;
    } catch {
        return false;
    }
}

// Extensions to load (-e) into a spawned sub-agent's process. Sub-agents are
// spawned without -e, so they only auto-discover extensions; these must be passed
// explicitly. Resolved relative to this file (<repo>/utils → <repo>/extensions/).
// - cwd-guard.ts confines the agent's file tools to the cwd — opt-in via
//   PI_CONFINE_CWD=1 (it loads into every sub-agent, so it is gated to stay safe).
// - dispatch.ts registers dispatch_agent/dispatch_parallel/select_agents, needed
//   only by agents whose tools include one of them.
export function subagentExtArgs(tools: string, readOnlyBash = false): string[] {
    const extDir = join(UTILS_DIR, "..", "extensions");
    const args: string[] = [];
    const add = (name: string) => {
        const p = join(extDir, name);
        if (existsSync(p)) args.push("-e", p);
    };
    if (process.env.PI_CONFINE_CWD === "1") {
        // Tell the guard which skill roots read-only tools may reach even though
        // they sit outside the cwd: the bundled skills (sibling of extensions/) plus
        // pi's global skills. Resolved here in the parent (reliable) and inherited by
        // the spawn's env as a path-delimited list. defaultSkillRoots() is the shared
        // source of truth — cwd-guard.ts falls back to it when run standalone.
        process.env.PI_SKILLS_DIR = defaultSkillRoots(
            join(extDir, "..", "skills"),
        ).join(pathDelimiter);
        add("cwd-guard.ts");
    }
    if (/\b(dispatch_agent|dispatch_parallel|select_agents)\b/.test(tools || ""))
        add("dispatch.ts");
    // readonly-guard.ts keeps a read-only agent read-only: it blocks mutating `gh`
    // and `git` shell commands (not file writes). Loaded for agents that run bash but
    // cannot write files (scout, reviewer, validator) — they query GitHub and inspect
    // the repo but must never mutate state — AND for write-capable agents that opt in
    // with `read-only-bash: true` (planner, refiner: they write only .agent/plan.md,
    // so their bash must stay read-only). Agents that legitimately mutate (the
    // implementer, the shipper which opens PRs) load nothing and keep full access.
    const t = tools || "";
    const hasBash = /\bbash\b/.test(t);
    const canWrite = /\b(write|edit)\b/.test(t);
    if (hasBash && (!canWrite || readOnlyBash)) add("readonly-guard.ts");
    // Live observability: when PI_OBS=1, every sub-agent emits ObsEvents to the
    // shared sink so the dashboard shows the whole pipeline. PI_OBS_AGENT (set on
    // the spawn env) labels which agent's lane the events land in.
    if (process.env.PI_OBS === "1" || process.env.PI_OBS === "true")
        add("obs-live.ts");
    return args;
}

// Spawn a pi subprocess for an agent, stream its output, and return the result.
// This is the single shared implementation used by agent-workflow,
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
    // The agent's configured context window (frontmatter / PI_AGENT_<NAME> env).
    // Used as the bar's denominator when the provider doesn't report one in usage.
    configuredContextWindow?: number;
    capturedTokens?: TokenUsage;
    cumulativeTokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    costUsd: number; // running USD total: sum of each turn's usage.cost.total
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
        if (msg?.role === "assistant") {
            // Track why the last turn ended — "length" means the model hit its
            // output-token cap and was truncated (often before acting at all).
            if (msg.stopReason) phase.lastStopReason = msg.stopReason;
            if (Array.isArray(msg.content)) {
                const text = msg.content
                    .filter((c: any) => c?.type === "text")
                    .map((c: any) => c.text || "")
                    .join("");
                if (text) state.finalText = text;
                if (msg.stopReason === "error" && msg.errorMessage)
                    state.finalError = String(msg.errorMessage);
            }
        }
        if (msg?.usage?.input) {
            // contextWindow may not be reported by all providers. Fall back to the
            // agent's CONFIGURED window (frontmatter / PI_AGENT_<NAME> env) so the
            // bar still works for providers that omit it; never fall back to
            // max_tokens (that's the output limit, not the context window) or a
            // hardcoded value — both produce misleading percentages.
            const ctxWindow =
                msg.usage.contextWindow || state.configuredContextWindow || 0;

            // input tokens: each message_end in a multi-turn spawn reports the
            // FULL conversation context for that turn, not a delta. Take the
            // max to avoid double-counting as the conversation grows.
            state.cumulativeTokens.input = Math.max(
                state.cumulativeTokens.input,
                msg.usage.input || 0,
            );
            // output tokens: genuinely additive across turns
            state.cumulativeTokens.output += msg.usage.output || 0;
            // cache read/write tokens: per-turn, additive (disjoint from input).
            // Tracked so the displayed token count matches the cost basis.
            state.cumulativeTokens.cacheRead += msg.usage.cacheRead || 0;
            state.cumulativeTokens.cacheWrite += msg.usage.cacheWrite || 0;
            // cost: pi's providers run calculateCost() on each response, so
            // msg.usage.cost.total is this turn's spend (input is re-billed every
            // turn). Per-turn cost is additive — sum it for the phase total.
            state.costUsd += msg.usage.cost?.total || 0;

            // Context-window fill uses input + output (the live conversation size).
            const ctxTokens =
                state.cumulativeTokens.input + state.cumulativeTokens.output;

            // Only compute percentage when the context window is known
            const pct =
                ctxWindow > 0
                    ? Math.min(100, Math.round((ctxTokens / ctxWindow) * 100))
                    : 0;
            phase.contextPct = pct;
            state.contextPct = phase.contextPct;
            state.capturedTokens = {
                input: state.cumulativeTokens.input,
                output: state.cumulativeTokens.output,
                cacheRead: state.cumulativeTokens.cacheRead,
                cacheWrite: state.cumulativeTokens.cacheWrite,
                contextWindow: ctxWindow,
                costUsd: state.costUsd,
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

// A collision-free, bounded key for a working directory, used to scope session
// files per project. A plain sanitized-and-truncated path is NOT safe: two
// different cwds that share the first N chars (e.g. .../projects/todo and
// .../projects/todo_app_spec) collapse to the same key, so one project loads the
// other's session and pi rejects the cwd mismatch. Append a short hash of the FULL
// path so distinct cwds always get distinct keys, while keeping a readable prefix.
export function projectSessionHash(cwd: string): string {
    const safe = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
    const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
    return `${safe.slice(0, 40)}-${hash}`;
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
    const projectHash = projectSessionHash(cwd);

    // Each agent runs in its own per-agent session file (parallel-safe). pi
    // stores sessions as JSONL — use the .jsonl extension to match (the content
    // is line-delimited JSON regardless; this just names it correctly).
    const sessionFile = join(
        config.sessionDir,
        `${sessionKey}-${projectHash}.jsonl`,
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
        agentDef.systemPrompt + TRIVIAL_PING_RULE,
        "--session",
        sessionFile,
        "--name",
        spawnSessionName(cwd, agentDef.name),
        ...(shouldApproveProjectForSpawn(cwd, config.isProjectTrusted?.())
            ? ["--approve"]
            : []),
        ...subagentExtArgs(agentDef.tools, agentDef.readOnlyBash),
    ];

    const cleanModel = model?.trim();
    const modelArg = spawnModelArg(model);
    if (modelArg) args.push("--model", modelArg);
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
        configuredContextWindow:
            agentDef.contextWindow ||
            config.getFallbackContextWindow?.(model) ||
            0,
        cumulativeTokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        costUsd: 0,
    };
    const start = Date.now();

    return new Promise((resolve) => {
        const proc = spawn("pi", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...dispatchEnv(agentDef.name, phase.dispatchId) },
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
    const projectHash = projectSessionHash(cwd);
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

    // Each agent runs in its own per-agent session file (parallel-safe). pi
    // stores sessions as JSONL — use the .jsonl extension to match.
    const sessionFile = join(projectSessionDir, `${sessionKey}.jsonl`);

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
        agentDef.systemPrompt + TRIVIAL_PING_RULE,
        "--session",
        sessionFile,
        "--name",
        spawnSessionName(cwd, agentDef.name),
        ...(shouldApproveProjectForSpawn(cwd, config.isProjectTrusted?.())
            ? ["--approve"]
            : []),
        ...subagentExtArgs(agentDef.tools, agentDef.readOnlyBash),
    ];
    // Pass --model via spawnModelArg: a two-or-more-slash string keeps its
    // provider (provider/<slashed id>), a single-slash string drops the leading
    // prefix (legacy), a bare id passes through.
    const cleanModel = model?.trim();
    const modelArg = spawnModelArg(model);
    if (modelArg) args.push("--model", modelArg);
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
        configuredContextWindow:
            agentDef.contextWindow ||
            config.getFallbackContextWindow?.(model) ||
            0,
        cumulativeTokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        costUsd: 0,
    };
    const start = Date.now();

    return new Promise((resolve) => {
        const proc = spawn("pi", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...dispatchEnv(agentDef.name, phase.dispatchId) },
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
        const extDir = UTILS_DIR;
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
