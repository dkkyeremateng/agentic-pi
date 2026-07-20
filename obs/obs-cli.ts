// obs-cli.ts — the I/O layer for the Phase 1 agent observability analyzer.
//
// Locates the session logs a workflow run wrote (the per-agent JSONL files in
// the project's hashed session dir), pulls the `.agent/` pipeline facts, and
// renders the metrics from obs-metrics.ts (which does the pure math).
//
// Usage:
//   tsx obs/obs-cli.ts [projectPath] [--json] [--since ISO] [--until ISO]
//   tsx obs/obs-cli.ts --session <file.jsonl> [--json]
//   tsx obs/obs-cli.ts --all [root] [--json] [--since ISO] [--until ISO]
//   tsx obs/obs-cli.ts score <runId|--last> --pass|--fail [--note <text>]
//                                  [--sink <file>]
//   tsx obs/obs-cli.ts explain <runId|--last> [--json] [--sink <file>]
//   tsx obs/obs-cli.ts reap [--stale <minutes>] [--apply] [--json] [--sink <file>]
//   tsx obs/obs-cli.ts lessons [--json]
//
//   projectPath  defaults to the current directory. Its session dir is resolved
//                the same way the workflow spawns sub-agents (projectSessionHash).
//   --session    analyze a single JSONL file directly (e.g. an orchestrator log).
//   --all        cross-run trends: discover every .agent/metrics.jsonl under
//                [root] (default cwd) and aggregate all runs.
//   --since/--until  scope a continued session file to one run (single-project),
//                or filter runs by start date (--all).
//   --json       emit JSON instead of the text report.
//   lessons      show agent self-learning lessons broken down by source
//                (remember = saved on a passing run; reflect = distilled from a
//                failed run) so you can watch the balance of the two paths.

import {
    readFileSync,
    existsSync,
    readdirSync,
    statSync,
    appendFileSync,
    openSync,
    readSync,
    closeSync,
} from "fs";
import { join, basename, resolve as resolvePath } from "path";
import { homedir } from "os";
import {
    projectSessionHash,
    parseProgressLedger,
    type WorkflowMetrics,
} from "../utils/workflow/workflow-core";
import {
    makeFactory,
    serializeEvent,
    parseEventLine,
    type ObsEvent,
} from "./obs-events";
import { RunIndexer, LineScanner, type RunSummary } from "./obs-run-index";
import { lessonSourceStats } from "../utils/workflow/memory";
import { buildRunDigest, formatRunDigest } from "./obs-explain";
import { planReap, reapEvent } from "./obs-reap";
import { listLiveSessions } from "./obs-chat-control";
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

// ── score: append a manual verdict for a run to the obs sink ─────────────────
// The lightweight eval loop: a `verdict` event in the sink, attributed to the
// run, that the dashboard's run history and pickers surface. The workflow
// auto-emits one at terminal status; this command records (or overrides — the
// last verdict wins) the human judgement after the fact.

function obsSinkPath(explicit?: string): string {
    const p = explicit || process.env.PI_OBS_SINK;
    if (p) return resolvePath(p.replace(/^~(?=$|\/)/, homedir()));
    return join(homedir(), ".pi", "agent", "obs", "events.jsonl");
}

function indexSink(sink: string): RunIndexer {
    const idx = new RunIndexer();
    const fd = openSync(sink, "r");
    try {
        const CHUNK = 1 << 20;
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
            const n = readSync(fd, buf, 0, CHUNK, idx.scannedTo);
            if (n <= 0) break;
            idx.feed(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }
    return idx;
}

// One run's events from its indexed byte range (the range interleaves other
// runs' lines in a shared sink — filter by runId).
function readRunEvents(sink: string, run: RunSummary): ObsEvent[] {
    const events: ObsEvent[] = [];
    const scanner = new LineScanner((line) => {
        const ev = parseEventLine(line);
        if (ev && ev.runId === run.runId) events.push(ev);
    }, run.startOffset);
    const fd = openSync(sink, "r");
    try {
        const CHUNK = 1 << 20;
        const buf = Buffer.alloc(CHUNK);
        let pos = run.startOffset;
        while (pos < run.endOffset) {
            const n = readSync(
                fd,
                buf,
                0,
                Math.min(CHUNK, run.endOffset - pos),
                pos,
            );
            if (n <= 0) break;
            scanner.push(buf.subarray(0, n));
            pos += n;
        }
    } finally {
        closeSync(fd);
    }
    return events;
}

function runLabel(r: RunSummary): string {
    return r.name || new Date(r.firstTs).toLocaleString();
}

// Resolve <runId|--last> against the indexed runs (exact id or unique prefix);
// prints the recent runs and exits on no/ambiguous match.
function resolveRun(runs: RunSummary[], runArg: string, last: boolean): RunSummary {
    if (last) return runs[0]; // runs() is latest-first
    const matches = runs.filter(
        (r) => r.runId === runArg || r.runId.startsWith(runArg),
    );
    if (matches.length !== 1) {
        console.error(
            matches.length
                ? `Ambiguous run "${runArg}" (${matches.length} matches). Recent runs:`
                : `No run matching "${runArg}". Recent runs:`,
        );
        for (const r of runs.slice(0, 8))
            console.error(
                `  ${r.runId}  ${runLabel(r)}  ${r.agents.length} agent(s)`,
            );
        process.exit(1);
    }
    return matches[0];
}

function scoreCommand(argv: string[]): void {
    let runArg = "";
    let last = false;
    let status = "";
    let note: string | undefined;
    let sinkArg: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--pass") status = "pass";
        else if (a === "--fail") status = "fail";
        else if (a === "--last") last = true;
        else if (a === "--note") note = argv[++i];
        else if (a === "--sink") sinkArg = argv[++i];
        else if (!a.startsWith("--") && !runArg) runArg = a;
    }
    if (!status || (!runArg && !last)) {
        console.error(
            "usage: score <runId|--last> --pass|--fail [--note <text>] [--sink <file>]",
        );
        process.exit(1);
    }
    const sink = obsSinkPath(sinkArg);
    if (!existsSync(sink)) {
        console.error(
            `No obs sink at ${sink} — run a workflow with PI_OBS=1 first.`,
        );
        process.exit(1);
    }
    const runs = indexSink(sink).runs(); // latest-first
    if (!runs.length) {
        console.error(`No runs recorded in ${sink}.`);
        process.exit(1);
    }
    const run = resolveRun(runs, runArg, last);
    const f = makeFactory({
        sessionId: `score-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 7)}`,
        agent: "user",
        cwd: run.cwd,
        runId: run.runId,
    });
    const ev = f.next("verdict", {
        status,
        ...(note ? { note } : {}),
        source: "cli",
    });
    appendFileSync(sink, serializeEvent(ev) + "\n", "utf-8");
    const prev = run.verdict
        ? ` (overrides ${run.verdict.status}${
              run.verdict.source ? " from " + run.verdict.source : ""
          })`
        : "";
    console.log(
        `Scored ${run.runId} (${runLabel(run)}) as ${status.toUpperCase()}` +
            (note ? ` — ${note}` : "") +
            prev,
    );
}

// ── reap: close orphaned lanes (session_start with no session_end) ───────────
// A hard-killed session (SIGKILL, terminal closed, reboot, crash) never wrote a
// session_end, so its lane shows as stalled forever on the Live wall. This
// appends a synthetic session_end for each such lane older than --stale, never
// touching a genuinely-live session. Dry-run by default; --apply to write.
function reapCommand(argv: string[]): void {
    let sinkArg: string | undefined;
    let staleMin = 30;
    let apply = false;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--sink") sinkArg = argv[++i];
        else if (a === "--stale") staleMin = Number(argv[++i]);
        else if (a === "--apply") apply = true;
        else if (a === "--json") json = true;
        else {
            console.error("usage: reap [--stale <minutes>] [--apply] [--json] [--sink <file>]");
            process.exit(1);
        }
    }
    if (!(staleMin >= 0)) {
        console.error("--stale must be a non-negative number of minutes");
        process.exit(1);
    }
    const sink = obsSinkPath(sinkArg);
    if (!existsSync(sink)) {
        console.error(`No obs sink at ${sink} — run a workflow with PI_OBS=1 first.`);
        process.exit(1);
    }
    const events: ObsEvent[] = [];
    for (const line of readLines(sink)) {
        const ev = parseEventLine(line);
        if (ev) events.push(ev);
    }
    const now = Date.now();
    // Never reap a session that's still pid-alive with a fresh heartbeat.
    const live = new Set(listLiveSessions().map((s) => s.sessionId));
    const plan = planReap(events, now, staleMin * 60_000, live);

    if (json) {
        console.log(JSON.stringify({ ...plan, applied: apply }, null, 2));
    } else if (!plan.orphans.length) {
        console.log(
            `No orphaned lanes to reap — ${plan.sessions} sessions ` +
                `(${plan.ended} cleanly ended, ${plan.live} live, ${plan.fresh} too recent).`,
        );
    } else {
        console.log(
            `${plan.orphans.length} orphaned lane${plan.orphans.length === 1 ? "" : "s"} ` +
                `(of ${plan.sessions} sessions; skipped ${plan.live} live, ${plan.fresh} too recent):`,
        );
        for (const o of plan.orphans) {
            const age = Math.round((now - o.lastTs) / 60_000);
            console.log(
                `  ${o.sessionId}  ${o.agent}  ${o.events} ev  ` +
                    `idle ${age}m${o.runId ? `  ${o.runId}` : ""}`,
            );
        }
    }

    if (!apply) {
        if (plan.orphans.length && !json)
            console.log(`\nDry run — re-run with --apply to write ${plan.orphans.length} session_end event(s).`);
        return;
    }
    if (!plan.orphans.length) return;
    const lines = plan.orphans.map((o) => serializeEvent(reapEvent(o, now))).join("\n") + "\n";
    appendFileSync(sink, lines, "utf-8");
    if (!json) console.log(`\nReaped ${plan.orphans.length} lane(s) — appended session_end to ${sink}.`);
}

// ── explain: LLM-ready digest of one run (anomalies, timeline, rollups) ──────
// The metrics skill runs this and hands the output to pi — "what happened in
// that run / why was it slow or expensive" without reading the raw sink.
function explainCommand(argv: string[]): void {
    let runArg = "";
    let last = false;
    let json = false;
    let sinkArg: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--last") last = true;
        else if (a === "--json") json = true;
        else if (a === "--sink") sinkArg = argv[++i];
        else if (!a.startsWith("--") && !runArg) runArg = a;
    }
    if (!runArg && !last) {
        console.error("usage: explain <runId|--last> [--json] [--sink <file>]");
        process.exit(1);
    }
    const sink = obsSinkPath(sinkArg);
    if (!existsSync(sink)) {
        console.error(
            `No obs sink at ${sink} — run a workflow with PI_OBS=1 first.`,
        );
        process.exit(1);
    }
    const runs = indexSink(sink).runs();
    if (!runs.length) {
        console.error(`No runs recorded in ${sink}.`);
        process.exit(1);
    }
    const run = resolveRun(runs, runArg, last);
    const digest = buildRunDigest(readRunEvents(sink, run));
    if (json) {
        console.log(JSON.stringify(digest, null, 2));
        return;
    }
    console.log(formatRunDigest(digest).join("\n"));
}

// `lessons` — agent self-learning ledger by source. Counts each committed lesson
// as `remember` (agent-authored, kept on a passing run), `reflect` (distilled
// from a failed run), or `unknown` (written before source tracking / hand edit),
// so the balance of the two learning paths is visible instead of inferred.
function lessonsCommand(argv: string[]): void {
    const { byAgent, totals } = lessonSourceStats();
    if (argv.includes("--json")) {
        console.log(JSON.stringify({ byAgent, totals }, null, 2));
        return;
    }
    if (!totals.total) {
        console.log("No agent lessons saved yet.");
        return;
    }
    const pad = (s: string | number, n: number) => String(s).padEnd(n);
    console.log("Agent lessons by source");
    console.log("  remember = saved via the tool on a PASSING run; reflect = distilled from a FAILED run; unknown = pre-tracking/hand edit\n");
    console.log(`  ${pad("agent", 20)}${pad("remember", 10)}${pad("reflect", 10)}${pad("unknown", 10)}total`);
    console.log(`  ${"-".repeat(58)}`);
    for (const a of byAgent) {
        console.log(`  ${pad(a.agent, 20)}${pad(a.remember, 10)}${pad(a.reflect, 10)}${pad(a.unknown, 10)}${a.total}`);
    }
    console.log(`  ${"-".repeat(58)}`);
    console.log(`  ${pad("TOTAL", 20)}${pad(totals.remember, 10)}${pad(totals.reflect, 10)}${pad(totals.unknown, 10)}${totals.total}`);
}

function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === "score") {
        scoreCommand(argv.slice(1));
        return;
    }
    if (argv[0] === "lessons") {
        lessonsCommand(argv.slice(1));
        return;
    }
    if (argv[0] === "explain") {
        explainCommand(argv.slice(1));
        return;
    }
    if (argv[0] === "reap") {
        reapCommand(argv.slice(1));
        return;
    }
    const opts = parseArgs(argv);

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
