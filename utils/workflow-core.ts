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

import {
    readFileSync,
    existsSync,
    readdirSync,
    mkdirSync,
    unlinkSync,
} from "fs";
import { join, basename, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { secs } from "./workflow-utils";

// ── Config ───────────────────────────────────────

export const REQUIRED_AGENTS = [
    "planner",
    "critic",
    "implementer",
    "tester",
    "documenter",
    "validator",
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
    systemPrompt: string;
}

export interface PhaseState {
    label: string;
    agent: string;
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
}

// ── Active-workflow detection ────────────────────
// Both agent-pipeline.ts and agent-team.ts may auto-load from .pi/extensions/ at
// once; only one renders the dashboard/footer. The one launched with -e wins;
// with no explicit choice, the base "agent-pipeline" is the default. These helpers are
// shared but parameterized over each extension's own identity (its module URL,
// filename, and SELF_NAME) since `import.meta.url` is per-module.

// True only when pi was started with this extension via -e/--extension (not when
// it was auto-discovered). `selfUrl` is the caller's import.meta.url.
export function loadedExplicitly(selfUrl: string, fallbackBase: string): boolean {
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

// Load KEY=VALUE pairs from a `.env` file into process.env WITHOUT overwriting
// values already set in the real environment (so the shell still wins). Lets you
// keep PI_WORKFLOW_MODEL / PI_AGENT_*_MODEL in a file instead of exporting them
// in every shell — handy when pi is launched from an IDE/GUI.
export function loadDotEnv(cwd: string): void {
    const path = join(cwd, ".env");
    if (!existsSync(path)) return;
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
            if (!(key in process.env)) process.env[key] = val;
        }
    } catch {}
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
    if (own.some((p) => p.status === "error"))
        return { status: "error", elapsed: 0, toolCount: 0 };
    const done = own.filter((p) => p.status === "done");
    if (done.length)
        return {
            status: "done",
            elapsed: done.reduce((s, p) => s + p.elapsed, 0),
            toolCount: 0,
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

    // Context usage bar: 5 blocks + percent, only shown when we have data.
    const ctxLine =
        showContext && phase.contextPct > 0
            ? (() => {
                  const filled = Math.ceil(phase.contextPct / 20);
                  const bar = "#".repeat(filled) + "-".repeat(5 - filled);
                  const ctxStr = `[${bar}] ${phase.contextPct}%`;
                  return theme.fg("dim", ctxStr);
              })()
            : null;
    const ctxVisible = ctxLine
        ? Math.min(`[#####] ${phase.contextPct}%`.length, w)
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

// ── Agent loading ────────────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return null;
        const fm: Record<string, string> = {};
        for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0)
                fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        if (!fm.name) return null;
        return {
            name: fm.name,
            description: fm.description || "",
            tools: fm.tools || "read,grep,find,ls",
            model: fm.model || "",
            systemPrompt: match[2].trim(),
        };
    } catch {
        return null;
    }
}

// `fallbackDir` (optional) is the extension's own install agents dir
// (`<ext>/../agents`); it's searched last so a project's own .pi/agents wins,
// but a project that defines none still resolves the globally installed agents.
export function loadAgents(
    cwd: string,
    fallbackDir?: string,
): Map<string, AgentDef> {
    const dirs = [
        join(cwd, ".pi", "agents"),
        join(cwd, "agents"),
        join(cwd, ".claude", "agents"),
    ];
    if (fallbackDir) dirs.push(fallbackDir);
    const agents = new Map<string, AgentDef>();
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
            for (const file of readdirSync(dir)) {
                if (!file.endsWith(".md")) continue;
                const def = parseAgentFile(join(dir, file));
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
    for (const line of raw.split("\n")) {
        const teamMatch = line.match(/^(\S[^:]*):\s*$/);
        if (teamMatch) {
            current = teamMatch[1].trim();
            teams[current] = [];
            continue;
        }
        const itemMatch = line.match(/^\s+-\s+(.+)$/);
        if (itemMatch && current) teams[current].push(itemMatch[1].trim());
    }
    return teams;
}

// `fallbackDir` (optional) is the extension's own install agents dir; its
// teams.yaml is used when the cwd project has none (mirrors loadAgents).
export function loadTeams(
    cwd: string,
    fallbackDir?: string,
): Record<string, string[]> {
    const candidates = [join(cwd, ".pi", "agents", "teams.yaml")];
    if (fallbackDir) candidates.push(join(fallbackDir, "teams.yaml"));
    for (const path of candidates) {
        if (!existsSync(path)) continue;
        try {
            return parseTeamsYaml(readFileSync(path, "utf-8"));
        } catch {
            return {};
        }
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

// Ensure the per-agent session directory exists; optionally wipe stale sessions.
// Returns the directory path (the caller stores it as its sessionDir).
export function setupSessions(cwd: string, wipe: boolean): string {
    const sessionDir = join(cwd, ".pi", "workflow-sessions");
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    if (wipe) {
        for (const f of readdirSync(sessionDir)) {
            if (f.endsWith(".json")) {
                try {
                    unlinkSync(join(sessionDir, f));
                } catch {}
            }
        }
    }
    return sessionDir;
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
    const lower = plan.toLowerCase();
    if (
        !/##?\s*phase\s/i.test(plan) &&
        !lower.includes("phase 1") &&
        !lower.includes("phase: ")
    ) {
        missing.push("at least one labelled phase (## Phase N)");
    }
    if (
        !/##?\s*acceptance\s*criteri/i.test(plan) &&
        !lower.includes("acceptance criteria")
    ) {
        missing.push("an Acceptance Criteria section");
    }
    if (
        !/##?\s*critical\s*files/i.test(plan) &&
        !lower.includes("files changed") &&
        !/\b(modify|new file|create)\b/i.test(plan)
    ) {
        missing.push(
            "file-level specificity (Critical Files table or explicit file paths in phases)",
        );
    }
    return { ok: missing.length === 0, missing };
}

// ── Shared run context (curated cross-agent bundle) ──
// Durable artifacts earlier pipeline phases produced. Prepended to a later
// agent's task so every agent can build on the others' work without the lossy
// digest-into-the-next-prompt handoff. Used by agent-pipeline only (single
// model, one shared context window); agent-team keeps isolated handoffs.
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
        if (body && body.trim()) parts.push(`### ${title}`, "", body.trim(), "");
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
        "You are scouting the codebase ahead of a planning step. Investigate quickly and report concise findings the planner will use to ground its plan. You are strictly read-only — do NOT modify anything.",
        "",
        "The team is about to work on this request:",
        original,
        "",
        "Report, tightly: the project type and stack; the structure relevant to this request; recurring patterns and conventions to follow; and the key entry points / seams where this change would plug in. Cite real `file:line` references. Omit anything irrelevant to the request.",
    ].join("\n");
}

export function planTask(original: string, recon = ""): string {
    return [
        "You are the entry point of the plan-implement-test-validate workflow. Your plan is handed straight to the implementer.",
        "",
        "Request:",
        original,
        "",
        ...reconBlock(recon),
        "First classify this request as a BUG FIX, NEW FEATURE, or NEW APP (greenfield), and state the type at the top of your plan.",
        "- Bug fix: reproduce it, find the root cause, cite exact files and lines, then plan the minimal fix plus a regression test.",
        "- New feature: plan it against the existing codebase — where it integrates, what it reuses, what it adds.",
        "- New app: there may be no codebase yet. Recommend a stack, define the directory structure and scaffolding, and sequence the build so a minimal app runs by the end of Phase 1.",
        "",
        "Produce a structured, phased plan with file-level specificity, and state clear acceptance criteria the tester and validator can check.",
    ].join("\n");
}

export function criticTask(original: string, plan: string): string {
    return [
        "You are critically evaluating an implementation plan before it is handed to the implementer. Your job is to find every problem that would cause the implementation to fail, the tests to miss regressions, or the acceptance criteria to go unmet.",
        "",
        "Request:",
        original,
        "",
        "Plan to evaluate:",
        plan,
        "",
        "Work through these categories and report every finding:",
        "1. Completeness — Are all affected files listed? Are any call sites, consumers, or dependents of touched code missing?",
        "2. Correctness — Does the described logic actually solve the requirement? Are edge cases (empty inputs, concurrency, auth boundaries) unaccounted for?",
        "3. Feasibility — Are the changes compatible with the existing code structure and patterns? Does any phase assume something that does not yet exist?",
        "4. Dependency risks — Are new packages or versions introduced that could conflict with existing constraints?",
        "5. Phase ordering — Can each phase be implemented and tested independently? Are there hidden ordering constraints?",
        "6. Acceptance criteria quality — Is every criterion observable and unambiguous? Are error paths and regressions covered?",
        "7. Unverified assumptions — Did the planner state or imply something that cannot be confirmed from the codebase as-is?",
        "",
        "Output your critique using this format:",
        "",
        "## Verdict",
        "APPROVED | APPROVED WITH RESERVATIONS | REVISE BEFORE IMPLEMENTING",
        "",
        "## Critical Issues",
        "(Issues that must be fixed before the plan is safe to implement. If none, write: None.)",
        "",
        "## Minor Issues",
        "(Issues worth fixing but that will not block a careful implementer. If none, write: None.)",
        "",
        "## Unverified Assumptions",
        "(Statements in the plan that could not be confirmed against the codebase. If none, write: None.)",
        "",
        "## Acceptance Criteria Assessment",
        "(One line per criterion: abbreviated text | Testable? | Notes)",
        "",
        "If the verdict is REVISE BEFORE IMPLEMENTING, state exactly what the planner must fix. Do NOT rewrite the plan yourself.",
    ].join("\n");
}

export function revisePlanTask(
    original: string,
    plan: string,
    critique: string,
): string {
    return [
        "The critic REJECTED your implementation plan. Revise it to address the issues raised. Do not start over — adjust the existing plan.",
        "",
        "Original request:",
        original,
        "",
        "Your previous plan:",
        plan,
        "",
        "Critic findings to address:",
        critique,
        "",
        "Apply the fixes, then output an updated, complete plan. The critic will review your revision, so fix every critical issue it raised.",
    ].join("\n");
}

export function implementTask(original: string, plan: string): string {
    return [
        "Implement the following approved plan exactly. Do not redesign it; if it is infeasible, stop and report why.",
        "",
        "Original request:",
        original,
        "",
        "Plan:",
        plan,
        "",
        "When done, output a precise change summary: files changed, key code, how to exercise the new behavior, and the tests you ran.",
    ].join("\n");
}

export function fixTask(
    original: string,
    plan: string,
    feedback: string,
    prevSummary: string,
): string {
    return [
        "The validator REJECTED the previous attempt. Fix exactly the issues it raised. Do not start over — adjust the existing work.",
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
        "",
        "Apply the fixes, then output an updated change summary including what you changed in this pass.",
    ].join("\n");
}

export function testTask(
    original: string,
    plan: string,
    implSummary: string,
): string {
    return [
        "Test the change just implemented. Write the tests needed to cover the requirement and the plan's acceptance criteria, run the full relevant suite, and report pass/fail with output.",
        "",
        "Original requirement:",
        original,
        "",
        "Plan (contains the acceptance criteria your tests must cover):",
        plan,
        "",
        "Implementer's change summary:",
        implSummary,
        "",
        "Map each test to an acceptance criterion. Start your report with a summary line `TESTS: <N> passed, <M> failed`, then list any failures with file:line.",
    ].join("\n");
}

export function documentTask(
    original: string,
    plan: string,
    implSummary: string,
    testReport: string,
): string {
    return [
        "Document the change just implemented and verified. Write clear, concise documentation that matches the project's existing style.",
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
        "",
        "Do each of the following that applies:",
        "- Update the relevant README(s) and any affected docs to reflect the change. Inspect the existing docs first and match their tone, structure, and formatting; if there is no doc style, keep it simple and consistent.",
        "- Add concise inline comments only where the code is non-obvious — do not over-comment or restate the code.",
        "- Add or update usage examples (commands, code snippets, or API calls) that show how to use the new behavior.",
        "Edit the actual files. Do not change code behavior. Then report exactly which docs you changed and why.",
    ].join("\n");
}

export function validateTask(
    original: string,
    plan: string,
    testReport: string,
): string {
    return [
        "Validate the completed work. You are the correctness gate — do NOT commit, push, or open a pull request; that happens in a later step once the change is documented.",
        "",
        "Original requirement:",
        original,
        "",
        "Plan (with the acceptance criteria to confirm):",
        plan,
        "",
        "Tester's report:",
        testReport,
        "",
        "Run the full build/lint/type-check/test suite yourself, confirm every acceptance criterion from the plan, and check the diff for regressions.",
        "On the FIRST line output exactly `VERDICT: PASS` or `VERDICT: FAIL`.",
        "- PASS: the change is correct and complete.",
        "- FAIL: state exactly what must be fixed, where (file:line), so the implementer can address it.",
    ].join("\n");
}

export function shipTask(
    original: string,
    testReport: string,
    docReport: string,
): string {
    return [
        "The change has passed validation and been documented. Open the pull request now.",
        "",
        "Original requirement:",
        original,
        "",
        "Tester's report:",
        testReport,
        "",
        "Documenter's report (these doc changes must be committed too):",
        docReport,
        "",
        "Steps:",
        "1. Run the test suite once more as a final sanity check. If it fails, STOP and report instead of opening a PR.",
        "2. Check for a GitHub remote with `git remote -v`.",
        "3. Create a feature branch (never the default branch) and commit ALL changes — code, tests, and docs.",
        "- If a remote exists: push the branch and open a draft PR, then report the PR URL.",
        "- If there is NO remote: do the local branch and commit only, then STOP and report the exact commands the user must run to add a remote. Do NOT create or push a remote on your own.",
        "On the FIRST line output exactly `SHIP: SHIPPED` (PR opened) or `SHIP: PAUSED` (no remote).",
    ].join("\n");
}

export function specPlanTask(original: string, recon = ""): string {
    return [
        "You are producing a standalone implementation specification. Your plan will NOT be handed to a pi implementer — it will be transformed into a document that ANY AI agent (Copilot, Claude, Cursor, Codex, a different pi session, etc.) or human developer can use to build the feature from scratch.",
        "",
        "Request:",
        original,
        "",
        ...reconBlock(recon),
        "First classify this request as a BUG FIX, NEW FEATURE, or NEW APP (greenfield).",
        "",
        "Because the reader will have ONLY this document (plus access to the codebase), you must be unusually detailed. For every phase, spell out:",
        "- Exact file paths and the action for each (New / Modify / Reference)",
        "- Function signatures, type definitions, or data structures when relevant",
        "- Integration points: which existing modules to call, in what order, with what arguments",
        "- Edge cases, error handling, and failure modes",
        "- Naming conventions to follow (inspect the codebase before committing to a name)",
        "- Dependencies to add, with versions where they matter",
        "",
        "The reader does NOT have access to conversation history, prior plans, or unstated context. Assume the codebase is their only reference besides your document.",
        "",
        "Produce a structured, phased plan with file-level specificity and a complete, numbered Acceptance Criteria section. Be explicit about what the reader must verify before declaring each step done.",
    ].join("\n");
}

export function specCriticTask(original: string, plan: string): string {
    return [
        "You are critically evaluating an implementation plan before it is turned into a spec. Your job is to find every problem that would cause the spec to mislead, the implementation to fail, or the acceptance criteria to go unverified.",
        "",
        "Request:",
        original,
        "",
        "Plan to evaluate:",
        plan,
        "",
        "Work through these categories and report every finding:",
        "1. Completeness — Are all affected files listed? Are any call sites, consumers, or dependents of touched code missing?",
        "2. Correctness — Does the described logic actually solve the requirement? Are edge cases (empty inputs, concurrency, auth boundaries) unaccounted for?",
        "3. Feasibility — Are the changes compatible with the existing code structure and patterns? Does any phase assume something that does not yet exist?",
        "4. Dependency risks — Are new packages or versions introduced that could conflict with existing constraints?",
        "5. Phase ordering — Can each phase be implemented and tested independently? Are there hidden ordering constraints?",
        "6. Acceptance criteria quality — Is every criterion observable and unambiguous? Are error paths and regressions covered?",
        "7. Unverified assumptions — Did the planner state or imply something that cannot be confirmed from the codebase as-is?",
        "",
        "Output your critique using this format:",
        "",
        "## Verdict",
        "APPROVED | APPROVED WITH RESERVATIONS | REVISE BEFORE DOCUMENTING",
        "",
        "## Critical Issues",
        "(Issues that must be fixed before the plan is turned into a spec. If none, write: None.)",
        "",
        "## Minor Issues",
        "(Issues worth fixing but that will not block a careful reader. If none, write: None.)",
        "",
        "## Unverified Assumptions",
        "(Statements in the plan that could not be confirmed against the codebase. If none, write: None.)",
        "",
        "## Acceptance Criteria Assessment",
        "(One line per criterion: abbreviated text | Testable? | Notes)",
        "",
        "If the verdict is REVISE BEFORE DOCUMENTING, state exactly what the planner must fix. Do NOT rewrite the plan yourself.",
    ].join("\n");
}

export function specReviseTask(
    original: string,
    plan: string,
    critique: string,
): string {
    return [
        "The critic REJECTED your implementation plan. Revise it to address the issues raised. Do not start over — adjust the existing plan.",
        "",
        "Original request:",
        original,
        "",
        "Your previous plan:",
        plan,
        "",
        "Critic findings to address:",
        critique,
        "",
        "Apply the fixes, then output an updated, complete plan. The critic will review your revision, so fix every critical issue it raised.",
    ].join("\n");
}

export function specDocumentTask(original: string, plan: string): string {
    return [
        "You are transforming a raw implementation plan into a clean, standalone implementation specification. The reader is ANY AI agent (Copilot, Claude, Cursor, Codex, a different pi session, etc.) or human developer who will pick this spec up later and build the feature from scratch. They have access to the codebase but NO other context from the planning conversation.",
        "",
        "Your job:",
        "1. Restate the requirement in a single crisp summary paragraph at the top.",
        "2. List preconditions and assumptions explicitly (environment, existing files, dependencies).",
        "3. Re-organize the plan phases into clear, numbered build steps.",
        "4. For each step, state: the target file path(s), the exact change (New / Modify / Remove), function signatures or code snippets where helpful, integration points, and edge cases.",
        "5. Include a complete Acceptance Criteria section with testable, observable statements.",
        "6. Include a Verification section with the exact commands to run and what to expect.",
        "7. Include a Risks / Open Questions section if anything is unresolved.",
        `8. End with a one-line metadata block: \`Original request: ${original.replace(/`/g, "'")}\` so the reader can cross-check.`,
        "",
        "Style: dry and precise, no filler, no emojis. Use headings, tables, and code fences liberally.",
        "",
        "After writing the spec, save it as markdown to `specs/<slug>.md` where `<slug>` is a short kebab-case identifier derived from the request (e.g. `csv-export-reports`). Create the `specs/` directory in the project root if it does not exist. Do NOT modify any production files — the spec file is the only deliverable.",
        "",
        "Original request:",
        original,
        "",
        "Raw plan:",
        plan,
        "",
        "Output the full spec as a single markdown document and report the path where it was saved.",
    ].join("\n");
}
