// ABOUTME: Shared orchestration for the agent-workflow extension.
// ABOUTME: runWorkflow / dispatchAgent / selectAgents are byte-
// ABOUTME: identical between the two except the per-agent vs single model strategy
// ABOUTME: and the SHARED_CONTEXT flag, so they live here over a shared state object
// ABOUTME: (held by the extension, also read by its widget/footer) and a host of
// ABOUTME: per-extension callbacks. The extension keeps the model-specific bits.

// Type-only import (erased at runtime, so this module stays pi-free at runtime):
// align our tool-result shape with pi's real AgentToolResult so the registered
// tools' execute() returns typecheck against pi's ToolDefinition.
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
    type AgentDef,
    type PhaseState,
    type RunArtifacts,
    DEFAULT_MAX_LOOPS,
    displayName,
    mkPhase,
    freshPhases,
    buildPhaseMap,
    failPhase,
    validatePlan,
    parsePlanPhases,
    contextBundleForPhase,
    buildWorkflowReport,
    scoutTask,
    planTask,
    refineTask,
    reviewTask,
    reviewFixTask,
    implementTask,
    fixTask,
    validateTask,
    shipTask,
} from "./workflow-core";
import {
    type Verdict,
    type CritiqueVerdict,
    detectVerdict,
    detectShip,
    detectCritique,
    isTrivialPing,
    secs,
    isModelFailure,
} from "./workflow-utils";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileLink } from "./workflow-widgets";
import { slugifyBranch } from "./checkpoint";

// The mutable run/session state shared between the orchestration here and the
// extension's widget/footer/hooks. Created by the extension; mutated by both.
export interface OrchestratorState {
    agents: Map<string, AgentDef>;
    teams: Record<string, string[]>;
    activeTeamName: string;
    phases: PhaseState[];
    iteration: number;
    maxLoopsRef: number;
    lastStatus: string;
    running: boolean;
    phaseLogs: { label: string; log: string }[];
    totalDroppedLines: number;
    totalToolCalls: number;
    totalTokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    totalCostUsd: number;
    runStartedAt: number;
    runElapsedMs: number;
    includeScout: boolean;
    dispatchMode: boolean;
    freshDispatchSession: boolean;
    dispatchStartedAt: number;
    dispatchElapsedMs: number;
    primaryTurnStartedAt: number;
    pipelineRanThisTurn: boolean;
    dispatchedThisTurn: boolean;
    dispatchesThisTurn: number;
}

export function newOrchestratorState(): OrchestratorState {
    return {
        agents: new Map(),
        teams: {},
        activeTeamName: "",
        phases: [],
        iteration: 0,
        maxLoopsRef: DEFAULT_MAX_LOOPS,
        lastStatus: "idle",
        running: false,
        phaseLogs: [],
        totalDroppedLines: 0,
        totalToolCalls: 0,
        totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        totalCostUsd: 0,
        runStartedAt: 0,
        runElapsedMs: 0,
        includeScout: false,
        dispatchMode: false,
        freshDispatchSession: false,
        dispatchStartedAt: 0,
        dispatchElapsedMs: 0,
        primaryTurnStartedAt: 0,
        pipelineRanThisTurn: false,
        dispatchedThisTurn: false,
        dispatchesThisTurn: 0,
    };
}

// Per-extension callbacks + config the orchestration delegates to.
// Execution callbacks: run phases or individual agents
export interface ExecutionCallbacks {
    // Run one phase (wraps the extension's model strategy + subprocess spawn).
    runPhase: (
        phase: PhaseState,
        task: string,
        cwd: string,
    ) => Promise<{ output: string; ok: boolean }>;
    // Run a single agent directly (dispatch_agent path).
    runAgent: (
        def: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
    ) => Promise<{ output: string; exitCode: number }>;
}

// UI and notification callbacks
export interface UICallbacks {
    updateWidget: () => void;
    notify: (msg: string, level: string) => void;
    publishLogs: () => void;
}

// Setup and initialization callbacks
export interface SetupCallbacks {
    setupSessions: (cwd: string, wipe: boolean) => void;
    loadAgents: (cwd: string) => Map<string, AgentDef>;
    prepareRun: (ctx: any) => void; // capture the model(s) for this run
    // Switch to the run's work branch before the implementer commits, so per-phase
    // commits never land on the default branch. Returns the base sha (squash/revert
    // floor) or null when not applicable (not a git repo / no commits). Git side-
    // effects live in the extension; the core just decides when to call it.
    ensureWorkBranch?: (
        cwd: string,
        request: string,
    ) => { branch: string; base: string } | null;
}

// Configuration flags
export interface OrchestratorConfig {
    sharedContext: boolean; // apply the curated context bundle
    maxDispatchesPerTurn: number;
    minDispatchOutputChars: number;
    // Archive each shipped run's final plan to docs/plans/ (committed with the
    // change). Also auto-enabled when a docs/plans/ dir already exists. Optional
    // (defaults to false) so existing host fakes need not set it.
    archivePlans?: boolean;
}

export interface OrchestratorHost {
    execution: ExecutionCallbacks;
    ui: UICallbacks;
    setup: SetupCallbacks;
    config: OrchestratorConfig;
    // Optional abort signal from the tool handler. When aborted, the pipeline
    // stops before the next phase instead of spawning a new subprocess.
    signal?: AbortSignal;
}

type RunResult = { status: string; report: string };
type ToolResult = AgentToolResult<unknown>;

// ── Shared command handler ───────────────────────
// runWorkflowCommand is used by the agent-workflow extension
// (same notifications, same dropped-lines warning, same publishReport call).
// Extracted here so both extensions share one copy.

export async function runFullWorkflowCommand(
    s: OrchestratorState,
    h: OrchestratorHost,
    request: string,
    ctx: any,
    publishReport: (report: string) => void,
    maxLoops: number = DEFAULT_MAX_LOOPS,
): Promise<void> {
    ctx.ui.notify(
        `Starting workflow: ${request} (max retries: ${maxLoops})`,
        "info",
    );
    const result = await runWorkflowCore(s, h, request, maxLoops, ctx);

    const level =
        result.status === "shipped"
            ? "success"
            : result.status.startsWith("error") ||
                result.status === "failed-after-retries"
              ? "error"
              : "warning";
    // Clickable link to the on-disk report (degrades to plain text where OSC 8
    // isn't supported).
    const reportLink = fileLink(
        join(ctx.cwd, "workflow-report.md"),
        "workflow-report.md",
    );
    ctx.ui.notify(
        `Workflow ${result.status} in ${secs(s.runElapsedMs)}. Report: ${reportLink} (also shown below).`,
        level as any,
    );
    if (s.totalDroppedLines > 0) {
        ctx.ui.notify(
            `Heads up: ${s.totalDroppedLines} malformed JSON line(s) were dropped from agent output — possible pi subprocess issue (see report diagnostic).`,
            "warning",
        );
    }

    if (result.report && result.report.trim().length > 0) {
        publishReport(result.report);
    }
}

// Team members that resolve to a loaded agent .md.
function activeMembers(s: OrchestratorState): string[] {
    return (s.teams[s.activeTeamName] || []).filter((m) =>
        s.agents.has(m.toLowerCase()),
    );
}

function fail(s: OrchestratorState, label: string, output: string): RunResult {
    s.running = false;
    s.lastStatus = "error";
    return failPhase(label, output);
}

// Check if the workflow was aborted externally (e.g. user pressed escape).
// Returns an error RunResult if aborted, or null to continue.
function checkAbort(
    s: OrchestratorState,
    h: OrchestratorHost,
): RunResult | null {
    if (h.signal?.aborted) {
        s.running = false;
        s.lastStatus = "aborted";
        s.runElapsedMs = Date.now() - s.runStartedAt;
        h.ui.updateWidget();
        return {
            status: "aborted",
            report: "Workflow aborted by user.",
        };
    }
    return null;
}

// ── Full plan → implement → test → validate → document → ship pipeline ──
export async function runWorkflowCore(
    s: OrchestratorState,
    h: OrchestratorHost,
    request: string,
    maxLoops: number,
    ctx: any,
): Promise<RunResult> {
    // Re-entry guard: prevent a second invocation from corrupting state.
    if (s.running) {
        return {
            status: "error",
            report: "A workflow is already running.",
        };
    }
    h.setup.prepareRun(ctx);
    const cwd = ctx.cwd;

    // ── Ping mode ──
    // A trivial ping / health check runs EVERY loaded agent in PARALLEL (each
    // replies "pong" per the trivial-ping rule) instead of the real pipeline —
    // which would otherwise fail plan validation on a non-task request.
    if (isTrivialPing(request)) {
        s.dispatchMode = false;
        s.includeScout = false;
        h.setup.setupSessions(cwd, true);
        s.phases = Array.from(s.agents.keys()).map((k) =>
            mkPhase(displayName(k), k),
        );
        s.phaseLogs = [];
        s.totalDroppedLines = 0;
        s.totalToolCalls = 0;
        s.totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        s.totalCostUsd = 0;
        s.runStartedAt = Date.now();
        s.runElapsedMs = 0;
        s.iteration = 0;
        s.maxLoopsRef = 1;
        s.lastStatus = "running";
        s.running = true;
        h.ui.updateWidget();

        // Run them all at once — independent health checks, no ordering.
        const results = await Promise.all(
            s.phases.map(async (phase) => {
                const res = await h.execution.runPhase(phase, request, cwd);
                return { agent: phase.agent, ok: res.ok, output: res.output };
            }),
        );

        s.runElapsedMs = Date.now() - s.runStartedAt;
        s.running = false;
        const okCount = results.filter((r) => r.ok).length;
        s.lastStatus = okCount === results.length ? "done" : "needs-review";
        h.ui.updateWidget();

        const report = [
            `# Ping Report`,
            ``,
            `**Request:** ${request}`,
            `**Pinged ${results.length} agent(s) in parallel** — ${okCount}/${results.length} responded.`,
            ``,
            ...results.map(
                (r) =>
                    `- **${displayName(r.agent)}** — ${r.ok ? r.output.trim().split("\n")[0] || "pong" : "no response"}`,
            ),
        ].join("\n");
        writeReport(h, cwd, report);
        h.ui.publishLogs();
        return { status: s.lastStatus, report };
    }

    // The active team's roster IS the pipeline: run exactly the agents it lists,
    // in canonical order. With no team selected (e.g. the run_agent_workflow tool),
    // fall back to every loaded agent so the whole pipeline runs.
    let members = activeMembers(s);
    if (members.length === 0) members = Array.from(s.agents.keys());

    // A predefined team runs the canonical pipeline (scout → … → ship); only the
    // pipeline roles in its roster execute. Non-pipeline specialists are not run as
    // teams — research and other ad-hoc work goes through the orchestrator, which
    // picks the skills/agents itself per the request (see prompts/orchestrator.md).
    s.includeScout = members.some((m) => m.toLowerCase() === "scout");
    s.dispatchMode = false;
    h.setup.setupSessions(cwd, true);
    s.phases = freshPhases(members);
    s.phaseLogs = [];
    s.totalDroppedLines = 0;
    s.totalToolCalls = 0;
    s.totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    s.totalCostUsd = 0;
    s.runStartedAt = Date.now();
    s.runElapsedMs = 0;
    s.iteration = 0;
    s.maxLoopsRef = maxLoops;
    s.lastStatus = "running";
    s.running = true;
    h.ui.updateWidget();

    // Every roster member must resolve to a loaded agent definition.
    const roster = s.teams[s.activeTeamName] || [];
    const missing = roster.filter((m) => !s.agents.has(m.toLowerCase()));
    if (missing.length) {
        s.running = false;
        s.lastStatus = "error";
        return {
            status: "error",
            report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
        };
    }

    const runArtifacts: RunArtifacts = {};
    resetRunScratch(cwd);
    const shared = (task: string, phaseAgent: string) => {
        if (!h.config.sharedContext) return task;
        const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
        return bundle ? `${bundle}\n\n---\n\n${task}` : task;
    };

    const pm = buildPhaseMap(s.phases);
    const scoutP = pm.scout;
    const planP = pm.planner;
    const refinerP = pm.refiner;
    const reviewerP = pm.reviewer;
    const implP = pm.implementer;
    const valP = pm.validator;
    const shipP = pm.shipper;

    let aborted: RunResult | null;

    // ── Scout (read-only recon) ──
    let scoutFindings = "";
    if (scoutP) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        const scoutRes = await h.execution.runPhase(
            scoutP,
            scoutTask(request),
            cwd,
        );
        if (!scoutRes.ok) return fail(s, "Scouting", scoutRes.output);
        scoutFindings = scoutRes.output;
        runArtifacts.recon = scoutFindings;
    }

    // ── Plan ──
    let plan = { output: "", ok: true };
    if (planP) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        plan = await h.execution.runPhase(
            planP,
            planTask(request, scoutFindings),
            cwd,
        );
        if (!plan.ok) return fail(s, "Planning", plan.output);
        // The plan lives in .agent/plan.md (the planner writes it there) — that file
        // is the source of truth downstream agents read. Prefer it; fall back to the
        // message if the planner only emitted it. capturePlan then records the
        // canonical content and persists the fallback so the file always exists.
        plan.output = readPlan(cwd) || plan.output;
        capturePlan(runArtifacts, cwd, plan.output);
    }

    // ── Refine (review + harden the plan before implementation) ──
    // The refiner reviews the planner's draft against the codebase and rewrites a
    // hardened plan; that becomes THE plan threaded to the implementer/reviewer.
    if (refinerP && planP && plan.ok) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        const refine = await h.execution.runPhase(
            refinerP,
            shared(refineTask(request, scoutFindings), "refiner"),
            cwd,
        );
        if (!refine.ok) return fail(s, "Refining", refine.output);
        // The refiner overwrote .agent/plan.md with the hardened plan — read it back
        // as the canonical plan (it only emits a summary, not the full plan).
        plan = refine;
        plan.output = readPlan(cwd) || plan.output;
        capturePlan(runArtifacts, cwd, plan.output);
    }

    // Enforce plan structure on the FINAL plan (post-refine), only when an
    // implementer will consume it.
    if (planP && implP) {
        const planCheck = validatePlan(plan.output);
        if (!planCheck.ok) {
            s.running = false;
            s.lastStatus = "error";
            return {
                status: "error",
                report: `Plan is missing required structure. The plan lacks:\n- ${planCheck.missing.join("\n- ")}\n\nThe implementer cannot act reliably on this plan. Re-run with a more specific request, or check that the planner/refiner agent definitions are complete.`,
            };
        }
    }

    // ── Implement (first pass) ──
    let impl = { output: "", ok: false };
    if (implP) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        // Switch to the run's work branch BEFORE the implementer commits, so its
        // per-phase commits never land on the default branch. Then seed the progress
        // ledger from the plan's phases (with the base sha when on git) so phase
        // status is tracked even without git. Done once, here — re-runs in the
        // review/validate fix loops reuse the branch and the ledger.
        const wb = h.setup.ensureWorkBranch?.(cwd, request) ?? null;
        initProgressLedger(cwd, wb?.base ?? "", plan.output);
        impl = await h.execution.runPhase(
            implP,
            shared(implementTask(request), "implementer"),
            cwd,
        );
        if (!impl.ok) return fail(s, "Implementing", impl.output);
        runArtifacts.implSummary = impl.output;
    }

    // ── Review ⇄ implement ──
    // The reviewer checks the implementation against the plan; on REVISE BEFORE
    // MERGE the implementer fixes exactly the issues raised and the reviewer
    // re-reviews, looping up to maxLoops.
    let review = { output: "", ok: true };
    let reviewVerdict: CritiqueVerdict = "unknown";
    if (reviewerP && impl.ok) {
        for (let loop = 1; loop <= maxLoops; loop++) {
            aborted = checkAbort(s, h);
            if (aborted) return aborted;
            reviewerP.status = "pending";
            h.ui.updateWidget();
            review = await h.execution.runPhase(
                reviewerP,
                shared(reviewTask(request, impl.output), "reviewer"),
                cwd,
            );
            if (!review.ok) return fail(s, "Review", review.output);

            reviewVerdict = detectCritique(review.output);
            if (reviewVerdict !== "revise") break;

            if (loop === maxLoops || !implP) break;
            aborted = checkAbort(s, h);
            if (aborted) return aborted;
            implP.status = "pending";
            implP.note = "";
            h.ui.updateWidget();
            impl = await h.execution.runPhase(
                implP,
                shared(
                    reviewFixTask(request, review.output, impl.output),
                    "implementer",
                ),
                cwd,
            );
            if (!impl.ok) return fail(s, "Implementing", impl.output);
            runArtifacts.implSummary = `[review fix] ${impl.output}`;
        }
        runArtifacts.review = review.output;
    }

    let val = { output: "", ok: false };
    let ship = { output: "", ok: false };
    let verdict: Verdict = "unknown";

    // ── Validate ⇄ implement ──
    // The validator is the independent gate: it RUNS the full suite (including the
    // tests the implementer wrote) and confirms the acceptance criteria, then emits
    // the verdict. On FAIL its findings go back to the implementer and it re-runs,
    // looping up to maxLoops.
    if (valP) {
        for (let loop = 1; loop <= maxLoops; loop++) {
            aborted = checkAbort(s, h);
            if (aborted) return aborted;
            s.iteration = loop;

            valP.status = "pending";
            h.ui.updateWidget();
            val = await h.execution.runPhase(
                valP,
                shared(validateTask(request, impl.output), "validator"),
                cwd,
            );
            if (!val.ok) return fail(s, "Validation", val.output);

            verdict = detectVerdict(val.output);
            if (verdict !== "fail") break;

            if (loop === maxLoops || !implP) break;
            aborted = checkAbort(s, h);
            if (aborted) return aborted;
            implP.status = "pending";
            implP.note = "";
            h.ui.updateWidget();
            impl = await h.execution.runPhase(
                implP,
                shared(
                    // feedback = validator findings (val.output); prevSummary = the
                    // previous implementer summary (impl.output).
                    fixTask(request, val.output, impl.output),
                    "implementer",
                ),
                cwd,
            );
            if (!impl.ok) return fail(s, "Implementing", impl.output);
            runArtifacts.implSummary = `[attempt ${implP.attempt}] ${impl.output}`;
        }
    }

    // ── Ship ──
    // When a validator ran, ship only on PASS; otherwise (no validator to gate on)
    // ship straight after whatever build work happened. The implementer updates any
    // docs/comments as part of the change, so there is no separate document phase.
    const passed = valP ? verdict === "pass" : true;

    // On success, reconcile the ledger so every phase reads done even if the
    // implementer didn't flip them itself — code-guaranteed end-state tracking.
    if (passed && implP) {
        markAllPhasesDone(cwd);
    }

    // Archive the final plan to docs/plans/ (opt-in) whenever implementation ran —
    // pass OR fail — so every attempt is tracked, independent of the shipper and of
    // git/versioning. The outcome is stamped into the file so failed attempts are
    // distinguishable; on success with a shipper, the file is already there to
    // commit with the change.
    if (implP) {
        const outcome = passed
            ? "passed"
            : verdict === "fail"
              ? "failed"
              : "needs-review";
        archivePlan(
            cwd,
            request,
            plan.output,
            !!h.config.archivePlans,
            outcome,
        );
    }

    if (passed && shipP) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        ship = await h.execution.runPhase(
            shipP,
            shared(shipTask(request, val.output), "shipper"),
            cwd,
        );
        if (!ship.ok) return fail(s, "Shipping", ship.output);
    }

    // ── Terminal status, from whichever phases ran ──
    let status: string;
    if (!passed) {
        status = verdict === "fail" ? "failed-after-retries" : "needs-review";
    } else if (shipP) {
        status =
            detectShip(ship.output) === "paused"
                ? "paused-no-remote"
                : "shipped";
    } else if (reviewerP && reviewVerdict === "revise") {
        status = "needs-review";
    } else {
        status = "done";
    }

    s.runElapsedMs = Date.now() - s.runStartedAt;
    s.running = false;
    s.lastStatus = status;
    h.ui.updateWidget();

    const passes = s.iteration;
    const prUrl =
        (ship.output.match(/https?:\/\/\S*\/pull\/\d+/) || [])[0] || "";

    const report = buildWorkflowReport({
        request,
        status,
        verdict,
        passes,
        maxLoops,
        passed,
        prUrl,
        totals: {
            runElapsedMs: s.runElapsedMs,
            totalToolCalls: s.totalToolCalls,
            totalTokens: s.totalTokens,
            totalDroppedLines: s.totalDroppedLines,
            totalCostUsd: s.totalCostUsd,
        },
        scoutP,
        planP,
        refinerP,
        implP,
        reviewerP,
        valP,
        shipP,
        scoutFindings,
        plan: plan.output,
        impl: impl.output,
        review: review.output,
        val: val.output,
        ship: ship.output,
    });

    writeReport(h, cwd, report);
    h.ui.publishLogs();
    return { status, report };
}

function writeReport(h: OrchestratorHost, cwd: string, report: string): void {
    try {
        writeFileSync(join(cwd, "workflow-report.md"), report, "utf-8");
    } catch (e: any) {
        h.ui.notify(
            `Could not write workflow-report.md: ${e.message}`,
            "warning",
        );
    }
}

const textResult = (text: string): ToolResult => ({
    content: [{ type: "text", text }],
    details: undefined,
});

// Capture the (possibly revised) plan: record it as the run artifact AND persist
// it to `.agent/plan.md` so every downstream agent can read it from disk. The planner
// agent also writes this file; doing it here too guarantees it regardless of
// whether the agent followed the instruction. Best-effort — never fails the run.
// Remove a stale plan file from a previous run, so capturePlan's "the planner
// already wrote it" check (existsSync) is reliable for THIS run.
// Clear per-run scratch under .agent/ at the start of a workflow run so stale
// state from a previous run can't leak in: the plan file and the implementer's
// phase-progress ledger. Without this a leftover progress.md would make the
// implementer wrongly "resume" a finished run. NOTE: `.agent/checkpoints/` is
// intentionally left alone — that belongs to the /revert checkpoint system.
export function resetRunScratch(cwd: string): void {
    const agent = join(cwd, ".agent");
    for (const f of ["plan.md", "progress.md"]) {
        try {
            rmSync(join(agent, f), { force: true });
        } catch {}
    }
}

// Initialize the implementer's progress ledger BEFORE implementation so phase
// status is tracked WITH OR WITHOUT git: an unchecked entry per plan phase (the
// implementer only flips [ ] -> [x] as it finishes each), plus a `Base: <sha>`
// line when on git (the squash/revert floor that the implementer, validator, and
// shipper all read). Written after resetRunScratch and with no `[x]` lines, so the
// implementer sees a fresh (non-resume) run. Empty base ⇒ non-git: no Base line,
// the implementer skips commits but still tracks phase status.
export function initProgressLedger(
    cwd: string,
    base: string,
    plan: string,
): void {
    try {
        const file = join(cwd, ".agent", "progress.md");
        mkdirSync(dirname(file), { recursive: true });
        const phases = parsePlanPhases(plan);
        const lines = ["# Implementation progress", ""];
        if (base) lines.push(`Base: ${base}`, "");
        if (phases.length) {
            for (const p of phases) lines.push(`- [ ] ${p}`);
        } else {
            lines.push("- [ ] Implementation");
        }
        lines.push("");
        writeFileSync(file, lines.join("\n"), "utf-8");
    } catch {}
}

// Read the phase-status lines ("- [ ] …" / "- [x] …") from the progress ledger.
function readPhaseStatus(cwd: string): string[] {
    const file = join(cwd, ".agent", "progress.md");
    if (!existsSync(file)) return [];
    try {
        return readFileSync(file, "utf-8")
            .split(/\r?\n/)
            .filter((l) => /^\s*-\s*\[[ xX]\]/.test(l));
    } catch {
        return [];
    }
}

// On a successful run, reconcile the progress ledger so every phase reads done:
// the implementer finished and validation passed, so the phases are objectively
// complete. Flip any remaining unchecked boxes — guaranteeing correct end-state
// tracking in CODE even if the implementer didn't mark them itself. Only the
// checkbox changes, preserving each line's annotations (commit sha, test command).
export function markAllPhasesDone(cwd: string): void {
    try {
        const file = join(cwd, ".agent", "progress.md");
        if (!existsSync(file)) return;
        const body = readFileSync(file, "utf-8").replace(
            /^(\s*-\s*)\[ \]/gm,
            "$1[x]",
        );
        writeFileSync(file, body, "utf-8");
    } catch {}
}

// File name for an archived plan: <YYYY-MM-DD>-<slug>.md.
export function planArchiveName(request: string, now: Date = new Date()): string {
    const date = now.toISOString().slice(0, 10);
    return `${date}-${slugifyBranch(request)}.md`;
}

// Save a run's final plan to docs/plans/<date>-<slug>.md as a durable, reviewable
// record, instead of letting it be wiped with the .agent scratch. Written whether
// or not a shipper runs, and for failed attempts as well as successful ones — so
// projects without git/versioning track every attempt; when a shipper does run on
// success, the file is already there to commit with the change. The `outcome`
// (passed/failed/needs-review) is stamped at the top so failures are
// distinguishable, and the file name is uniquified so a later attempt never
// overwrites an earlier one's record. Opt-in: only when `enabled` (the config
// flag) OR a docs/plans/ directory already exists. Returns the repo-relative path
// written (for the shipper to stage), or null when skipped. The active
// .agent/plan.md stays per-run — this never makes a plan cumulative.
export function archivePlan(
    cwd: string,
    request: string,
    plan: string,
    enabled: boolean,
    outcome: string = "",
    now: Date = new Date(),
): string | null {
    const dir = join(cwd, "docs", "plans");
    if (!enabled && !existsSync(dir)) return null;
    if (!plan.trim()) return null;
    try {
        mkdirSync(dir, { recursive: true });
        // Never overwrite a prior attempt — uniquify so every run's record (failed
        // or successful) is preserved for tracking.
        const baseName = planArchiveName(request, now);
        let name = baseName;
        for (let n = 2; existsSync(join(dir, name)); n++) {
            name = baseName.replace(/\.md$/, `-${n}.md`);
        }
        const header = outcome
            ? `> **Run outcome:** ${outcome} — ${now.toISOString().slice(0, 10)}\n\n`
            : "";
        // Fold the final phase-completion status into the durable record, so it
        // captures which phases landed (not just the plan) — the .agent/ ledger is
        // gitignored scratch wiped each run, this archive is not.
        const status = readPhaseStatus(cwd);
        const statusBlock = status.length
            ? `\n\n## Phase status\n\n${status.join("\n")}\n`
            : "";
        const rel = join("docs", "plans", name);
        writeFileSync(join(cwd, rel), header + plan + statusBlock, "utf-8");
        return rel;
    } catch {
        return null;
    }
}

// Read the plan the planner/refiner wrote to .agent/plan.md. The file is the
// single source of truth: downstream agents read it directly (so it isn't threaded
// through every task) and the orchestrator reads it here for validation, the
// progress ledger, the archive, and the report. Returns "" when absent.
export function readPlan(cwd: string): string {
    try {
        return readFileSync(join(cwd, ".agent", "plan.md"), "utf-8");
    } catch {
        return "";
    }
}

export function capturePlan(
    runArtifacts: RunArtifacts,
    cwd: string,
    plan: string,
): void {
    runArtifacts.plan = plan;
    try {
        const file = join(cwd, ".agent", "plan.md");
        // The planner writes .agent/plan.md itself. Only write here as a FALLBACK —
        // when no plan file was written this run — so the planner's version is never
        // clobbered.
        if (!existsSync(file)) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, plan, "utf-8");
        }
    } catch {}
}

// Resolve an agent by its name or one of its frontmatter `aliases` (e.g. "atl"
// for "atlassian"). Aliases are matched only when the name lookup misses, so they
// never shadow a real agent, and the canonical def (with its real `name`) is
// returned — phases/dashboard always show the proper name.
export function resolveAgent(
    agents: Map<string, AgentDef>,
    key: string,
): AgentDef | undefined {
    const k = (key || "").toLowerCase();
    const direct = agents.get(k);
    if (direct) return direct;
    for (const def of agents.values())
        if (def.aliases?.some((a) => a.toLowerCase() === k)) return def;
    return undefined;
}

// ── dispatch_agent: run one specialist on a focused task ──
export async function dispatchAgentCore(
    s: OrchestratorState,
    h: OrchestratorHost,
    agent: string,
    task: string,
    onUpdate: ((u: ToolResult) => void) | undefined,
    ctx: any,
): Promise<ToolResult> {
    if (s.running)
        return textResult(
            "Cannot dispatch while a workflow is running. Wait for it to finish or cancel it first.",
        );

    // Recursion guard. Sub-agents are separate processes; their depth and the
    // chain of agents that led here ride down through the env (set by
    // spawnAgentWithModel/dispatchEnv). Depth bounds how deep dispatch can nest;
    // ancestry catches cycles (A dispatches B dispatches A). Default max depth 1 =
    // single level (only the top dispatches); raise PI_DISPATCH_MAX_DEPTH to allow
    // sub-agents to dispatch further.
    const dispatchDepth =
        parseInt(process.env.PI_DISPATCH_DEPTH || "0", 10) || 0;
    const maxDispatchDepth =
        parseInt(process.env.PI_DISPATCH_MAX_DEPTH || "1", 10) || 1;
    if (dispatchDepth >= maxDispatchDepth)
        return textResult(
            `Dispatch depth limit reached (max ${maxDispatchDepth}). This agent is ${dispatchDepth} dispatch level(s) deep — do the work yourself or report back instead of dispatching further. (Raise PI_DISPATCH_MAX_DEPTH to allow deeper nesting.)`,
        );
    const dispatchAncestry = (process.env.PI_DISPATCH_ANCESTRY || "")
        .split(">")
        .filter(Boolean);
    if (dispatchAncestry.includes(agent.toLowerCase()))
        return textResult(
            `Cycle detected: "${agent}" is already an ancestor in this dispatch chain (${dispatchAncestry.join(" > ")}). Refusing to avoid an infinite loop — do the work yourself or report back.`,
        );

    if (s.dispatchesThisTurn >= h.config.maxDispatchesPerTurn)
        return textResult(
            `Dispatch limit reached (${h.config.maxDispatchesPerTurn} per turn). Summarize what has been done and stop — do not dispatch more agents this turn.`,
        );

    // Only refresh agents from disk on a fresh user request. During a burst
    // of dispatches within the same turn the agent definitions don't change,
    // so re-reading from disk is wasted I/O.
    if (s.freshDispatchSession) s.agents = h.setup.loadAgents(ctx.cwd);
    const def = resolveAgent(s.agents, agent);
    if (!def) {
        const available = Array.from(s.agents.values())
            .map((d) => d.name)
            .join(", ");
        return textResult(
            `Agent "${agent}" not found. Available agents: ${available}`,
        );
    }

    if (onUpdate) onUpdate(textResult(`Dispatching to ${def.name}...`));

    // Capture the session model from the context (same as runWorkflowCore does).
    // This ensures subagents inherit the primary agent's model when no explicit
    // model is configured.
    h.setup.prepareRun(ctx);

    // dispatch_agent can be called standalone, so ensure the session dir exists.
    h.setup.setupSessions(ctx.cwd, false);

    // Enter dispatch mode. A new user request (freshDispatchSession) starts clean.
    if (!s.dispatchMode || s.freshDispatchSession) {
        s.dispatchMode = true;
        s.phases = [];
        s.dispatchStartedAt = s.primaryTurnStartedAt || Date.now();
        s.dispatchElapsedMs = 0;
    }
    s.freshDispatchSession = false;
    s.dispatchedThisTurn = true;
    s.dispatchesThisTurn++;

    // Track this agent as a phase. Each dispatch gets a unique ID to allow
    // parallel instances of the same agent.
    const agentKey = def.name.toLowerCase();
    const dispatchId = `${agentKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Look for an existing phase with the same agent name:
    // - If there's a PENDING phase, reuse it (from select_agents)
    // - If all existing phases are RUNNING, create a new phase (parallel dispatch)
    // - If there's a DONE/ERROR phase and no pending, reuse it (sequential re-dispatch)
    const existingPending = s.phases.find(
        (p) => p.agent === agentKey && p.status === "pending",
    );
    const existingRunning = s.phases.find(
        (p) => p.agent === agentKey && p.status === "running",
    );
    const existingPhase = s.phases.find((p) => p.agent === agentKey);

    let phase: PhaseState;
    if (existingPending) {
        // Reuse pending phase (from select_agents or previous dispatch)
        // Preserve the dispatchId to maintain session continuity
        const preservedDispatchId = existingPending.dispatchId;
        const fresh = mkPhase(displayName(def.name), agentKey, dispatchId);
        Object.assign(existingPending, fresh);
        // Restore the original dispatchId if it existed
        if (preservedDispatchId) {
            existingPending.dispatchId = preservedDispatchId;
        }
        phase = existingPending;
    } else if (existingRunning) {
        // All existing phases are running - create new phase for parallel dispatch
        phase = mkPhase(displayName(def.name), agentKey, dispatchId);
        s.phases.push(phase);
    } else if (existingPhase) {
        // Reuse existing phase (reset it for sequential re-dispatch)
        const preservedDispatchId = existingPhase.dispatchId;
        const fresh = mkPhase(displayName(def.name), agentKey, dispatchId);
        Object.assign(existingPhase, fresh);
        if (preservedDispatchId) {
            existingPhase.dispatchId = preservedDispatchId;
        }
        phase = existingPhase;
    } else {
        // No existing phase - create new one
        phase = mkPhase(displayName(def.name), agentKey, dispatchId);
        s.phases.push(phase);
    }
    h.ui.updateWidget();

    const start = Date.now();
    phase.attempt = 1;
    phase.status = "running";
    h.ui.updateWidget();

    const res = await h.execution.runAgent(def, task, phase, ctx.cwd);

    // A clean exit with (near-)empty output usually means the agent did no real
    // work — fail it so the orchestrator re-dispatches instead of building on
    // nothing. But tool-driven agents (e.g. a browser/research agent that works
    // through bash + playwright-cli) do their work via tool calls and often end
    // with only a terse summary; the captured output is just the final assistant
    // text, not the tool activity. So only treat short output as "empty" when the
    // agent also made no tool calls — that is the genuine did-nothing case.
    // A trivial ping legitimately returns a short "pong" with no tools — don't
    // count that as an empty/failed dispatch.
    const emptyOutput =
        !isTrivialPing(task) &&
        res.output.trim().length < h.config.minDispatchOutputChars &&
        phase.toolCount === 0;
    const ok = res.exitCode === 0 && !emptyOutput;

    phase.status = ok ? "done" : "error";
    phase.elapsed = Date.now() - start;
    s.dispatchElapsedMs = Date.now() - s.dispatchStartedAt;
    h.ui.updateWidget();

    // Build error message: show actual output for diagnosis, flag model failures
    const modelFail = !ok && isModelFailure(res.output);
    const errMsg = !ok
        ? emptyOutput
            ? res.output.trim()
                ? `: ${res.output.trim().slice(0, 120)}${modelFail ? " (model failure)" : ""}`
                : ": returned no usable output"
            : `: ${res.output
                  .split("\n")
                  .filter((l) => l.trim())
                  .slice(-2)
                  .join(" ")
                  .slice(0, 120)}${modelFail ? " (model failure)" : ""}`
        : "";
    h.ui.notify(
        `${def.name} ${ok ? "done" : "failed"} in ${secs(phase.elapsed)}${errMsg}`,
        ok ? "success" : "error",
    );

    const truncated =
        res.output.length > 8000
            ? res.output.slice(0, 8000) + "\n\n... [truncated]"
            : res.output;

    const status = ok ? "done" : "error";
    const summary = `[${def.name}] ${status} in ${secs(phase.elapsed)}`;

    const remaining = s.phases
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
            { type: "text", text: `${summary}\n\n${truncated}${nextStep}` },
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
}

// ── dispatch_parallel: run several specialists CONCURRENTLY ──
// Unlike repeated dispatch_agent (each awaited in turn), this runs the whole batch
// together via Promise.all and returns all results at once. Each item gets its own
// phase up front (unique dispatchId), so the concurrent runs never touch the same
// phase — and since JS is single-threaded, the shared-state updates between awaits
// are safe.
export async function dispatchParallelCore(
    s: OrchestratorState,
    h: OrchestratorHost,
    items: { agent: string; task: string }[],
    onUpdate: ((u: ToolResult) => void) | undefined,
    ctx: any,
): Promise<ToolResult> {
    if (s.running)
        return textResult(
            "Cannot dispatch while a workflow is running. Wait for it to finish or cancel it first.",
        );

    const dispatchDepth =
        parseInt(process.env.PI_DISPATCH_DEPTH || "0", 10) || 0;
    const maxDispatchDepth =
        parseInt(process.env.PI_DISPATCH_MAX_DEPTH || "1", 10) || 1;
    if (dispatchDepth >= maxDispatchDepth)
        return textResult(
            `Dispatch depth limit reached (max ${maxDispatchDepth}). This agent is ${dispatchDepth} level(s) deep — do the work yourself or report back. (Raise PI_DISPATCH_MAX_DEPTH to allow deeper nesting.)`,
        );

    if (!items || items.length === 0)
        return textResult(
            "dispatch_parallel needs a non-empty list of { agent, task } items.",
        );

    if (s.freshDispatchSession) s.agents = h.setup.loadAgents(ctx.cwd);

    // Resolve each item; skip unknown agents and any that would form a cycle.
    const ancestry = (process.env.PI_DISPATCH_ANCESTRY || "")
        .split(">")
        .filter(Boolean);
    const runnable: { def: AgentDef; task: string }[] = [];
    const skipped: string[] = [];
    for (const it of items) {
        const def = resolveAgent(s.agents, it.agent || "");
        if (!def) {
            skipped.push(`${it.agent} (unknown)`);
            continue;
        }
        if (ancestry.includes(def.name.toLowerCase())) {
            skipped.push(`${def.name} (cycle)`);
            continue;
        }
        runnable.push({ def, task: it.task });
    }

    if (runnable.length === 0) {
        const available = Array.from(s.agents.values())
            .map((d) => d.name)
            .join(", ");
        return textResult(
            `No runnable agents${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}. Available agents: ${available}`,
        );
    }

    if (s.dispatchesThisTurn + runnable.length > h.config.maxDispatchesPerTurn)
        return textResult(
            `Dispatch limit reached (${h.config.maxDispatchesPerTurn} per turn). This batch of ${runnable.length} would exceed it — dispatch fewer at once or summarize and stop.`,
        );

    h.setup.prepareRun(ctx);
    h.setup.setupSessions(ctx.cwd, false);

    if (!s.dispatchMode || s.freshDispatchSession) {
        s.dispatchMode = true;
        s.phases = [];
        s.dispatchStartedAt = s.primaryTurnStartedAt || Date.now();
        s.dispatchElapsedMs = 0;
    }
    s.freshDispatchSession = false;
    s.dispatchedThisTurn = true;
    s.dispatchesThisTurn += runnable.length;

    if (onUpdate)
        onUpdate(
            textResult(
                `Dispatching ${runnable.length} agents in parallel: ${runnable.map((r) => r.def.name).join(" ∥ ")}...`,
            ),
        );

    // One distinct phase per item, all marked running up front. Reuse a queued
    // phase that select_agents already declared for this agent (each claimed at
    // most once) so the cards are NOT duplicated; otherwise add a fresh one.
    const start = Date.now();
    const claimed = new Set<PhaseState>();
    const entries = runnable.map(({ def, task }, i) => {
        const agentKey = def.name.toLowerCase();
        const dispatchId = `${agentKey}-${start}-${i}`;
        let phase =
            s.phases.find(
                (p) =>
                    p.agent === agentKey &&
                    p.status === "pending" &&
                    !claimed.has(p),
            ) ?? null;
        if (phase) {
            claimed.add(phase);
            phase.dispatchId = dispatchId;
        } else {
            phase = mkPhase(displayName(def.name), agentKey, dispatchId);
            s.phases.push(phase);
        }
        phase.attempt = 1;
        phase.status = "running";
        return { def, task, phase };
    });
    h.ui.updateWidget();

    const results = await Promise.all(
        entries.map(async ({ def, task, phase }) => {
            const t0 = Date.now();
            const res = await h.execution.runAgent(def, task, phase, ctx.cwd);
            // A trivial ping legitimately returns a short "pong" with no tools —
            // don't count that as an empty/failed dispatch.
            const emptyOutput =
                !isTrivialPing(task) &&
                res.output.trim().length < h.config.minDispatchOutputChars &&
                phase.toolCount === 0;
            const ok = res.exitCode === 0 && !emptyOutput;
            phase.status = ok ? "done" : "error";
            phase.elapsed = Date.now() - t0;
            h.ui.updateWidget();
            const truncated =
                res.output.length > 4000
                    ? res.output.slice(0, 4000) + "\n... [truncated]"
                    : res.output;
            return { name: def.name, ok, elapsed: phase.elapsed, truncated };
        }),
    );

    s.dispatchElapsedMs = Date.now() - s.dispatchStartedAt;
    h.ui.updateWidget();
    for (const r of results)
        h.ui.notify(
            `${r.name} ${r.ok ? "done" : "failed"} in ${secs(r.elapsed)}`,
            r.ok ? "success" : "error",
        );

    const okCount = results.filter((r) => r.ok).length;
    const skipNote = skipped.length ? ` Skipped: ${skipped.join(", ")}.` : "";
    const blocks = results
        .map(
            (r) =>
                `[${r.name}] ${r.ok ? "done" : "FAILED"} in ${secs(r.elapsed)}\n${r.truncated}`,
        )
        .join("\n\n---\n\n");
    const summary = `Parallel dispatch complete: ${okCount}/${results.length} succeeded.${skipNote}`;

    return {
        content: [{ type: "text", text: `${summary}\n\n${blocks}` }],
        details: {
            parallel: true,
            results: results.map((r) => ({
                agent: r.name,
                status: r.ok ? "done" : "error",
                elapsed: r.elapsed,
            })),
            skipped,
        },
    };
}

// ── select_agents: declare the agents the orchestrator will use ──
export function selectAgentsCore(
    s: OrchestratorState,
    h: OrchestratorHost,
    names: string[],
    ctx: any,
): ToolResult {
    if (s.running)
        return textResult(
            "Cannot change the selection while a full workflow is running.",
        );

    // Only refresh agents on a fresh session (new user request).
    if (s.freshDispatchSession) s.agents = h.setup.loadAgents(ctx.cwd);

    const resolved: string[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const n of names) {
        const def = resolveAgent(s.agents, n);
        if (def) {
            const key = def.name.toLowerCase();
            // Deduplicate: only add each agent once to the selection
            if (!seen.has(key)) {
                resolved.push(key);
                seen.add(key);
            }
        } else {
            unknown.push(n);
        }
    }

    if (resolved.length === 0) {
        const available = Array.from(s.agents.values())
            .map((d) => d.name)
            .join(", ");
        return textResult(
            `No valid agents in selection. Available agents: ${available}`,
        );
    }

    // Loop-breaker: a repeat select_agents naming the SAME agents that are already
    // selected and still all queued (none dispatched yet) is a no-op. Weak
    // orchestrators get stuck re-declaring the plan here instead of executing it,
    // so steer firmly to dispatch rather than silently re-selecting.
    if (
        s.dispatchMode &&
        !s.freshDispatchSession &&
        s.phases.length === resolved.length &&
        s.phases.every(
            (p) => p.status === "pending" && resolved.includes(p.agent),
        )
    ) {
        const queued = resolved.map((k) => displayName(k)).join(", ");
        return textResult(
            `${queued} are already selected and queued — do NOT call select_agents again. Dispatch now: call dispatch_agent agent="${resolved[0]}" task="<their task>", then dispatch the next selected agent.`,
        );
    }

    s.dispatchMode = true;
    if (s.freshDispatchSession) {
        s.dispatchStartedAt = s.primaryTurnStartedAt || Date.now();
        s.dispatchElapsedMs = 0;
    }
    const byAgent = s.freshDispatchSession
        ? new Map<string, PhaseState>()
        : new Map(s.phases.map((p) => [p.agent, p]));
    s.freshDispatchSession = false;

    // Check if the original request had duplicates (parallel dispatch intent)
    const originalNames = names.map((n) => n.toLowerCase());
    const hasDuplicates = new Set(originalNames).size < originalNames.length;

    // For parallel execution, create one phase per requested agent (including duplicates)
    // For sequential execution, create one phase per unique agent
    if (hasDuplicates) {
        // Parallel: create a phase for each request with a unique dispatchId
        // so that multiple instances of the same agent can be distinguished
        s.phases = originalNames.map((key, index) => {
            const existing = byAgent.get(key);
            if (existing) return existing;
            // Assign a unique dispatchId for parallel instances
            const dispatchId = `${key}-${index + 1}`;
            return mkPhase(displayName(key), key, dispatchId);
        });
    } else {
        // Sequential: create one phase per unique agent (no dispatchId needed)
        s.phases = resolved.map(
            (key) => byAgent.get(key) ?? mkPhase(displayName(key), key),
        );
    }

    h.setup.setupSessions(ctx.cwd, false);
    h.ui.updateWidget();

    // Separator reflects how the agents actually run: ∥ ONLY for genuine parallel
    // instances (the same agent listed more than once, e.g. ['seeker','seeker']);
    // distinct agents are dispatched in order, so they read as a sequence with →.
    // (True concurrent execution of distinct agents goes through dispatch_parallel,
    // and the dashboard/footer show ∥ live while several actually run at once.)
    const isParallel = hasDuplicates;
    const separator = isParallel ? " ∥ " : " → ";
    const displayNames = names.map((n) => displayName(n.toLowerCase()));
    const order = displayNames.join(separator);

    const warn = unknown.length
        ? ` (ignored unknown: ${unknown.join(", ")})`
        : "";

    const parallelNote = hasDuplicates
        ? " For parallel execution, dispatch the same agent multiple times with different tasks."
        : "";

    return {
        content: [
            {
                type: "text",
                text: `Selected ${displayNames.length} agent${displayNames.length === 1 ? "" : "s"} for the work: ${order}.${warn}${parallelNote} The dashboard now shows them queued — dispatch them in order.`,
            },
        ],
        details: {
            selected: resolved,
            order,
            unknown,
            isParallel: hasDuplicates,
            originalCount: displayNames.length,
        },
    };
}
