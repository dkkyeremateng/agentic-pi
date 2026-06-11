// obs-cli.ts — the I/O layer for the Phase 1 agent observability analyzer.
//
// Locates the session logs a workflow run wrote (the per-agent JSONL files in
// the project's hashed session dir), pulls the `.agent/` pipeline facts, and
// renders the metrics from obs-metrics.ts (which does the pure math).
//
// Usage:
//   tsx utils/obs/obs-cli.ts [projectPath] [--json] [--since ISO] [--until ISO]
//   tsx utils/obs/obs-cli.ts --session <file.jsonl> [--json]
//   tsx utils/obs/obs-cli.ts --all [root] [--json] [--since ISO] [--until ISO]
//
//   projectPath  defaults to the current directory. Its session dir is resolved
//                the same way the workflow spawns sub-agents (projectSessionHash).
//   --session    analyze a single JSONL file directly (e.g. an orchestrator log).
//   --all        cross-run trends: discover every .agent/metrics.jsonl under
//                [root] (default cwd) and aggregate all runs.
//   --since/--until  scope a continued session file to one run (single-project),
//                or filter runs by start date (--all).
//   --json       emit JSON instead of the text report.

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename, resolve as resolvePath } from "path";
import { homedir } from "os";
import {
    projectSessionHash,
    parseProgressLedger,
    type WorkflowMetrics,
} from "../workflow/workflow-core";
import {
    parseSession,
    aggregateRun,
    aggregateTrends,
    formatRunReport,
    formatTrendReport,
    parseWorkflowReport,
    formatReportSummary,
    formatSessionLine,
    type SessionMetrics,
    type PipelineFacts,
    type ShipOutcome,
    type ParseOptions,
    type WorkflowReportSummary,
    type TrendRun,
} from "./obs-metrics";

// Recursively find every `<project>/.agent/metrics.jsonl` under `root`, pruning
// heavy/irrelevant dirs. Bounded depth keeps a high root from walking forever.
function findMetricsLogs(root: string, maxDepth = 6): string[] {
    const SKIP = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        "coverage",
        "vendor",
        ".venv",
    ]);
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
        const log = join(dir, ".agent", "metrics.jsonl");
        if (existsSync(log)) found.push(log);
        if (depth >= maxDepth) return;
        let entries: import("fs").Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory() || e.name === ".agent" || SKIP.has(e.name))
                continue;
            if (e.name.startsWith(".") && e.name !== ".") continue;
            walk(join(dir, e.name), depth + 1);
        }
    };
    walk(root, 0);
    return found;
}

// One .agent/metrics.jsonl line -> normalized TrendRun (drops to a per-project
// label from the file path; metrics records carry no cwd).
function metricsToTrendRun(m: WorkflowMetrics, project: string): TrendRun {
    return {
        project,
        startedAt: m.startedAt,
        shipOutcome: m.shipOutcome,
        passed: m.passed,
        passes: m.passes,
        maxLoops: m.maxLoops,
        costUsd: m.totals.costUsd ?? 0,
        tokensTotal: m.totals.tokens.total,
        wallclockMs: m.totals.wallclockMs,
        phases: m.phases.map((p) => ({
            label: p.label || p.agent,
            elapsedMs: p.elapsedMs,
            costUsd: p.tokens?.costUsd ?? 0,
            attempt: p.attempt,
        })),
    };
}

function runAllTrends(opts: {
    root?: string;
    json: boolean;
    since?: string;
    until?: string;
}): void {
    const root = resolvePath(opts.root ?? process.cwd());
    const logs = findMetricsLogs(root);
    const lo = opts.since ? Date.parse(opts.since) : undefined;
    const hi = opts.until ? Date.parse(opts.until) : undefined;

    const runs: TrendRun[] = [];
    for (const log of logs) {
        const project = basename(join(log, "..", ".."));
        for (const line of readFileSync(log, "utf-8").split("\n")) {
            const s = line.trim();
            if (!s) continue;
            let m: WorkflowMetrics;
            try {
                m = JSON.parse(s) as WorkflowMetrics;
            } catch {
                continue;
            }
            const ts = m.startedAt ? Date.parse(m.startedAt) : undefined;
            if (lo !== undefined && ts !== undefined && ts < lo) continue;
            if (hi !== undefined && ts !== undefined && ts > hi) continue;
            runs.push(metricsToTrendRun(m, project));
        }
    }

    if (!runs.length) {
        console.error(
            `No runs found: no .agent/metrics.jsonl under ${root}\n` +
                "(metrics are written by workflow runs from this version onward.)",
        );
        process.exit(1);
    }

    const trends = aggregateTrends(runs);
    if (opts.json) {
        console.log(JSON.stringify(trends, null, 2));
        return;
    }
    console.log(formatTrendReport(trends).join("\n"));
    console.log(
        `scanned ${logs.length} project(s) under ${root} · ${runs.length} run(s)`,
    );
}

function sessionsRoot(): string {
    const env = process.env.PI_WORKFLOW_SESSION_DIR;
    if (env) return env.replace(/^~(?=$|\/)/, homedir());
    return join(homedir(), ".pi", "agent", "sessions");
}

// Display name for a session file: drop the .json/.jsonl and the dispatch suffix
// (e.g. "scout-scout-1781096070397-7elj7s" -> "scout").
function agentName(file: string): string {
    const stem = basename(file).replace(/\.(jsonl?|json)$/i, "");
    const m = stem.match(/^([a-z]+)-\1-\d+/i);
    return m ? m[1] : stem;
}

function readLines(file: string): string[] {
    return readFileSync(file, "utf-8").split("\n");
}

function detectShipOutcome(text: string): ShipOutcome {
    // The shipper writes an explicit, canonical marker: `SHIP: SHIPPED|PAUSED`
    // (and FAILED/BLOCKED on a terminal failure). Prefer it; it is unambiguous.
    const marker = text.match(/SHIP:\s*(SHIPPED|PAUSED|FAILED|BLOCKED)/i);
    if (marker) {
        const v = marker[1].toUpperCase();
        if (v === "SHIPPED") return "shipped";
        if (v === "PAUSED") return "paused";
        return "failed";
    }
    // Fallback heuristics if no marker (older/partial reports).
    const t = text.toLowerCase();
    if (/paused|no\s+(git\s+)?remote|outward-facing/.test(t)) return "paused";
    if (/shipped|opened (a )?pr|pull request|merged|pushed/.test(t))
        return "shipped";
    if (/\b(aborted|blocked)\b|ship:\s*fail/.test(t)) return "failed";
    return "unknown";
}

function loadPipelineFacts(projectPath: string): PipelineFacts {
    const facts: PipelineFacts = {};
    const progress = join(projectPath, ".agent", "progress.md");
    if (existsSync(progress)) {
        const items = parseProgressLedger(readFileSync(progress, "utf-8"));
        if (items.length) {
            facts.phaseLabels = items.map((i) => ({
                label: i.label,
                done: i.done,
            }));
            facts.phasesTotal = items.length;
            facts.phasesDone = items.filter((i) => i.done).length;
        }
    }
    // Phase count from plan.md if progress.md was absent.
    if (facts.phasesTotal === undefined) {
        const plan = join(projectPath, ".agent", "plan.md");
        if (existsSync(plan)) {
            const n = (
                readFileSync(plan, "utf-8").match(/^#+\s*Phase\s+\d+/gim) ?? []
            ).length;
            if (n) facts.phasesTotal = n;
        }
    }
    // Ship outcome from a workflow report, if one was written.
    for (const cand of [
        join(projectPath, ".agent", "workflow-report.md"),
        join(projectPath, "workflow-report.md"),
    ]) {
        if (existsSync(cand)) {
            facts.shipOutcome = detectShipOutcome(readFileSync(cand, "utf-8"));
            break;
        }
    }
    return facts;
}

function parseArgs(argv: string[]) {
    const opts: {
        projectPath?: string;
        session?: string;
        all: boolean;
        json: boolean;
        since?: string;
        until?: string;
    } = { all: false, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--json") opts.json = true;
        else if (a === "--all") opts.all = true;
        else if (a === "--session") opts.session = argv[++i];
        else if (a === "--since") opts.since = argv[++i];
        else if (a === "--until") opts.until = argv[++i];
        else if (!a.startsWith("--") && !opts.projectPath) opts.projectPath = a;
    }
    return opts;
}

// Convert the structured metrics record into the display summary shape.
function metricsToSummary(m: WorkflowMetrics): WorkflowReportSummary {
    return {
        request: m.request,
        outcome: undefined,
        result: m.status,
        shipOutcome: m.shipOutcome,
        verdict: m.verdict,
        attempts: m.passes,
        attemptsMax: m.maxLoops,
        wallclockMs: m.totals.wallclockMs,
        toolCalls: m.totals.toolCalls,
        tokens: {
            input: m.totals.tokens.input,
            output: m.totals.tokens.output,
            cache: m.totals.tokens.cacheRead + m.totals.tokens.cacheWrite,
            total: m.totals.tokens.total,
        },
        costUsd: m.totals.costUsd,
        phases: m.phases.map((p) => ({
            name: p.label || p.agent,
            durationMs: p.elapsedMs,
            tokens: p.tokens?.total ?? 0,
            costUsd: p.tokens?.costUsd ?? 0,
        })),
    };
}

// Locate the authoritative per-run record and the run's time window (used to
// auto-scope the session-log enrichment so reused per-agent files aren't counted
// cumulatively). Prefers the structured .agent/metrics.json (exact startedAt/
// endedAt) and falls back to parsing workflow-report.md (mtime − wall-clock).
function loadReport(projectPath: string): {
    summary?: WorkflowReportSummary;
    window?: ParseOptions["window"];
} {
    const metricsFile = join(projectPath, ".agent", "metrics.json");
    if (existsSync(metricsFile)) {
        try {
            const m = JSON.parse(
                readFileSync(metricsFile, "utf-8"),
            ) as WorkflowMetrics;
            const summary = metricsToSummary(m);
            const start = m.startedAt ? Date.parse(m.startedAt) : undefined;
            const end = m.endedAt ? Date.parse(m.endedAt) : undefined;
            const window =
                start && end
                    ? { start: start - 5_000, end: end + 5_000 }
                    : undefined;
            return { summary, window };
        } catch {
            // fall through to markdown
        }
    }
    for (const cand of [
        join(projectPath, "workflow-report.md"),
        join(projectPath, ".agent", "workflow-report.md"),
    ]) {
        if (!existsSync(cand)) continue;
        const summary = parseWorkflowReport(readFileSync(cand, "utf-8"));
        let window: ParseOptions["window"] | undefined;
        if (summary.wallclockMs) {
            const end = statSync(cand).mtimeMs;
            window = {
                start: end - summary.wallclockMs - 60_000, // pad for clock skew
                end: end + 60_000,
            };
        }
        return { summary, window };
    }
    return {};
}

function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.all) {
        runAllTrends({
            root: opts.projectPath,
            json: opts.json,
            since: opts.since,
            until: opts.until,
        });
        return;
    }

    let window: ParseOptions["window"] | undefined =
        opts.since || opts.until
            ? { start: opts.since, end: opts.until }
            : undefined;

    let sessions: SessionMetrics[] = [];
    let facts: PipelineFacts = {};
    let cwdLabel = "";
    let report: WorkflowReportSummary | undefined;

    if (opts.session) {
        if (!existsSync(opts.session)) {
            console.error(`No such session file: ${opts.session}`);
            process.exit(1);
        }
        sessions = [
            parseSession(readLines(opts.session), {
                agent: agentName(opts.session),
                window,
            }),
        ];
        cwdLabel = sessions[0].cwd ?? opts.session;
    } else {
        const projectPath = resolvePath(opts.projectPath ?? process.cwd());
        cwdLabel = projectPath;
        const loaded = loadReport(projectPath);
        report = loaded.summary;
        // Auto-scope log enrichment to this run unless the user set a window.
        if (!window && loaded.window) window = loaded.window;
        const dir = join(sessionsRoot(), projectSessionHash(projectPath));
        if (!existsSync(dir)) {
            console.error(
                `No session logs found for ${projectPath}\n  (looked in ${dir})`,
            );
            process.exit(1);
        }
        const files = readdirSync(dir)
            .filter((f) => /\.(jsonl?|json)$/i.test(f))
            .map((f) => join(dir, f));
        sessions = files
            .map((f) =>
                parseSession(readLines(f), { agent: agentName(f), window }),
            )
            // Drop empty/aborted shells with no real activity.
            .filter((s) => s.turns > 0 || s.toolCalls > 0 || s.tokens.total > 0);
        facts = loadPipelineFacts(projectPath);
    }

    if (!sessions.length) {
        console.error("No agent activity found to report.");
        process.exit(1);
    }

    if (report) facts.shipOutcome = report.shipOutcome;
    const runReport = aggregateRun(sessions, facts);
    if (!runReport.cwd) runReport.cwd = cwdLabel;

    if (opts.json) {
        console.log(JSON.stringify({ report, run: runReport }, null, 2));
        return;
    }

    const lines: string[] = [""];
    if (report) {
        // Report header is authoritative for the trifecta/per-phase rollup;
        // the session logs add the per-agent tool/prune/error detail below.
        lines.push(...formatReportSummary(report));
        lines.push(`project   ${runReport.cwd}`);
        if (runReport.pipeline.phaseLabels?.length) {
            lines.push("");
            lines.push("Phases (from progress.md)");
            for (const ph of runReport.pipeline.phaseLabels)
                lines.push(`   [${ph.done ? "x" : " "}] ${ph.label}`);
        }
        lines.push("");
        lines.push("Detail (from session logs — tool/prune/error breakdown)");
        for (const s of runReport.agents) {
            lines.push(...formatSessionLine(s));
        }
    } else {
        lines.push(...formatRunReport(runReport));
    }
    console.log(lines.join("\n"));

    if (!report && !window && sessions.length > 1) {
        console.log(
            "note: no workflow-report.md found and per-agent session files are " +
                "reused across runs; if this project ran more than once, totals " +
                "are cumulative. Use --since/--until to scope a single run.",
        );
    }
}

main();
