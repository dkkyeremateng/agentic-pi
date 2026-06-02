// ABOUTME: Shared orchestration for the agent-pipeline / agent-team extensions.
// ABOUTME: runWorkflow / runSpecWorkflow / dispatchAgent / selectAgents are byte-
// ABOUTME: identical between the two except the per-agent vs single model strategy
// ABOUTME: and the SHARED_CONTEXT flag, so they live here over a shared state object
// ABOUTME: (held by the extension, also read by its widget/footer) and a host of
// ABOUTME: per-extension callbacks. The extension keeps the model-specific bits.

import {
    type AgentDef,
    type PhaseState,
    type RunArtifacts,
    REQUIRED_AGENTS,
    DEFAULT_MAX_LOOPS,
    displayName,
    mkPhase,
    freshPhases,
    buildPhaseMap,
    failPhase,
    validatePlan,
    contextBundleForPhase,
    buildWorkflowReport,
    buildSpecReport,
    scoutTask,
    planTask,
    criticTask,
    revisePlanTask,
    implementTask,
    fixTask,
    testTask,
    validateTask,
    documentTask,
    shipTask,
    specPlanTask,
    specCriticTask,
    specReviseTask,
    specDocumentTask,
} from "./workflow-core";
import {
    type Verdict,
    type CritiqueVerdict,
    detectVerdict,
    detectShip,
    detectCritique,
    secs,
} from "./workflow-utils";
import { writeFileSync } from "fs";
import { join } from "path";

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
    totalTokens: { input: number; output: number };
    runStartedAt: number;
    runElapsedMs: number;
    includeScout: boolean;
    isSpecMode: boolean;
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
        totalTokens: { input: 0, output: 0 },
        runStartedAt: 0,
        runElapsedMs: 0,
        includeScout: false,
        isSpecMode: false,
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
}

// Configuration flags
export interface OrchestratorConfig {
    sharedContext: boolean; // apply the curated context bundle
    maxDispatchesPerTurn: number;
    minDispatchOutputChars: number;
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
type ToolResult = { content: { type: string; text: string }[]; details?: any };

// ── Shared command handlers ──────────────────────
// runFullWorkflowCommand and runSpecWorkflowCommand are byte-identical between
// agent-pipeline and agent-team (same notifications, same dropped-lines warning,
// same publishReport call). Extracted here so both extensions share one copy.

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
    ctx.ui.notify(
        `Workflow ${result.status} in ${secs(s.runElapsedMs)}. Report is shown below.`,
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

export async function runSpecWorkflowCommand(
    s: OrchestratorState,
    h: OrchestratorHost,
    request: string,
    ctx: any,
    publishReport: (report: string) => void,
): Promise<void> {
    ctx.ui.notify(`Generating implementation spec: ${request}`, "info");
    const result = await runSpecWorkflowCore(s, h, request, ctx);

    const level =
        result.status === "done"
            ? "success"
            : result.status.startsWith("error")
              ? "error"
              : "warning";
    ctx.ui.notify(
        `Spec generation ${result.status} in ${secs(s.runElapsedMs)}. Report is shown below.`,
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
    s.isSpecMode = false;
    h.setup.prepareRun(ctx);
    const cwd = ctx.cwd;
    s.includeScout = activeMembers(s).some((m) => m.toLowerCase() === "scout");
    s.dispatchMode = false;
    h.setup.setupSessions(cwd, true);
    s.phases = freshPhases(s.includeScout, s.isSpecMode);
    s.phaseLogs = [];
    s.totalDroppedLines = 0;
    s.totalToolCalls = 0;
    s.totalTokens = { input: 0, output: 0 };
    s.runStartedAt = Date.now();
    s.runElapsedMs = 0;
    s.iteration = 0;
    s.maxLoopsRef = maxLoops;
    s.lastStatus = "running";
    s.running = true;
    h.ui.updateWidget();

    const missing = REQUIRED_AGENTS.filter((a) => !s.agents.has(a));
    if (missing.length) {
        s.running = false;
        s.lastStatus = "error";
        return {
            status: "error",
            report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
        };
    }

    const runArtifacts: RunArtifacts = {};
    const shared = (task: string, phaseAgent: string) => {
        if (!h.config.sharedContext) return task;
        const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
        return bundle ? `${bundle}\n\n---\n\n${task}` : task;
    };

    const pm = buildPhaseMap(s.phases);
    const scoutP = pm.scout ?? null;
    const planP = pm.planner;
    const critiqueP = pm.critic;
    const implP = pm.implementer;
    const testP = pm.tester;
    const valP = pm.validator;
    const docP = pm.documenter;
    const shipP = pm.shipper;

    let scoutFindings = "";
    if (scoutP) {
        const abort = checkAbort(s, h);
        if (abort) return abort;
        const scoutRes = await h.execution.runPhase(
            scoutP,
            scoutTask(request),
            cwd,
        );
        if (!scoutRes.ok) return fail(s, "Scouting", scoutRes.output);
        scoutFindings = scoutRes.output;
        runArtifacts.recon = scoutFindings;
    }

    let aborted = checkAbort(s, h);
    if (aborted) return aborted;
    let plan = await h.execution.runPhase(
        planP,
        planTask(request, scoutFindings),
        cwd,
    );
    if (!plan.ok) return fail(s, "Planning", plan.output);
    runArtifacts.plan = plan.output;

    const planCheck = validatePlan(plan.output);
    if (!planCheck.ok) {
        s.running = false;
        s.lastStatus = "error";
        return {
            status: "error",
            report: `Plan is missing required structure. The planner's output lacks:\n- ${planCheck.missing.join("\n- ")}\n\nThe implementer cannot act reliably on this plan. Re-run with a more specific request, or check that the planner agent definition is complete.`,
        };
    }

    // Phase 2 — Critique (plan ⇄ critic loop)
    let critique = { output: "", ok: true };

    for (let loop = 1; loop <= maxLoops; loop++) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        critiqueP.status = "pending";
        h.ui.updateWidget();
        critique = await h.execution.runPhase(
            critiqueP,
            shared(criticTask(request, plan.output), "critic"),
            cwd,
        );
        if (!critique.ok) return fail(s, "Critique", critique.output);

        const critiqueVerdict = detectCritique(critique.output);
        if (critiqueVerdict !== "revise") break;

        if (loop === maxLoops) break;
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        planP.status = "pending";
        planP.note = "";
        h.ui.updateWidget();
        plan = await h.execution.runPhase(
            planP,
            revisePlanTask(request, plan.output, critique.output),
            cwd,
        );
        if (!plan.ok) return fail(s, "Planning", plan.output);
        runArtifacts.plan = plan.output;
    }

    runArtifacts.critique = critique.output;

    // Phase 3 — Implement (first pass)
    aborted = checkAbort(s, h);
    if (aborted) return aborted;
    let impl = await h.execution.runPhase(
        implP,
        shared(implementTask(request, plan.output), "implementer"),
        cwd,
    );
    if (!impl.ok) return fail(s, "Implementing", impl.output);
    runArtifacts.implSummary = impl.output;

    let test = { output: "", ok: false };
    let val = { output: "", ok: false };
    let doc: { output: string; ok: boolean } = { output: "", ok: false };
    let ship = { output: "", ok: false };
    let verdict: Verdict = "unknown";

    // Correctness loop — test ⇄ validate, gated by the validator.
    for (let loop = 1; loop <= maxLoops; loop++) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        s.iteration = loop;

        testP.status = "pending";
        valP.status = "pending";
        h.ui.updateWidget();
        test = await h.execution.runPhase(
            testP,
            shared(testTask(request, plan.output, impl.output), "tester"),
            cwd,
        );
        if (!test.ok) return fail(s, "Testing", test.output);
        runArtifacts.testReport = test.output;

        val = await h.execution.runPhase(
            valP,
            shared(
                validateTask(request, plan.output, test.output),
                "validator",
            ),
            cwd,
        );
        if (!val.ok) return fail(s, "Validation", val.output);

        verdict = detectVerdict(val.output);
        if (verdict !== "fail") break;

        if (loop === maxLoops) break;
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        implP.status = "pending";
        implP.note = "";
        h.ui.updateWidget();
        impl = await h.execution.runPhase(
            implP,
            shared(
                fixTask(request, plan.output, impl.output, val.output),
                "implementer",
            ),
            cwd,
        );
        if (!impl.ok) return fail(s, "Implementing", impl.output);
        runArtifacts.implSummary = `[attempt ${implP.attempt}] ${impl.output}`;
    }

    // Document + ship only once the change has passed validation.
    let status: string;
    if (verdict === "pass") {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        doc = await h.execution.runPhase(
            docP,
            shared(
                documentTask(request, plan.output, impl.output, test.output),
                "documenter",
            ),
            cwd,
        );
        if (!doc.ok) {
            h.ui.notify(
                "Documenter failed — code changes are valid but docs were not updated. Proceeding to ship.",
                "warning",
            );
            doc = {
                output: "[Documenter failed — see activity logs]",
                ok: false,
            };
        } else {
            runArtifacts.docReport = doc.output;
        }

        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        ship = await h.execution.runPhase(
            shipP,
            shared(shipTask(request, test.output, doc.output), "shipper"),
            cwd,
        );
        if (!ship.ok) return fail(s, "Shipping", ship.output);

        status =
            detectShip(ship.output) === "paused"
                ? "paused-no-remote"
                : "shipped";
    } else {
        status = verdict === "fail" ? "failed-after-retries" : "needs-review";
    }

    s.runElapsedMs = Date.now() - s.runStartedAt;
    s.running = false;
    s.lastStatus = status;
    h.ui.updateWidget();

    const passes = s.iteration;
    const passed = verdict === "pass";
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
        },
        scoutP,
        planP,
        critiqueP,
        implP,
        testP,
        valP,
        docP,
        shipP,
        scoutFindings,
        plan: plan.output,
        critique: critique.output,
        impl: impl.output,
        test: test.output,
        val: val.output,
        doc: doc.output,
        ship: ship.output,
    });

    writeReport(h, cwd, report);
    h.ui.publishLogs();
    return { status, report };
}

// ── Spec-only pipeline: plan → critique → document ──
export async function runSpecWorkflowCore(
    s: OrchestratorState,
    h: OrchestratorHost,
    request: string,
    ctx: any,
): Promise<RunResult> {
    // Re-entry guard.
    if (s.running) {
        return {
            status: "error",
            report: "A workflow is already running.",
        };
    }
    s.isSpecMode = true;
    h.setup.prepareRun(ctx);
    const cwd = ctx.cwd;
    s.includeScout = activeMembers(s).some((m) => m.toLowerCase() === "scout");
    s.dispatchMode = false;
    h.setup.setupSessions(cwd, true);
    s.phases = freshPhases(s.includeScout, s.isSpecMode);
    s.phaseLogs = [];
    s.totalDroppedLines = 0;
    s.totalToolCalls = 0;
    s.totalTokens = { input: 0, output: 0 };
    s.runStartedAt = Date.now();
    s.runElapsedMs = 0;
    s.iteration = 1;
    s.maxLoopsRef = 1;
    const maxCritiqueLoops = 1;
    s.lastStatus = "running";
    s.running = true;
    h.ui.updateWidget();

    // Spec mode only runs planner -> critic -> documenter (+ optional scout).
    const missing = ["planner", "critic", "documenter"].filter(
        (a) => !s.agents.has(a),
    );
    if (missing.length) {
        s.running = false;
        s.lastStatus = "error";
        return {
            status: "error",
            report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
        };
    }

    const pm = buildPhaseMap(s.phases);
    const scoutP = pm.scout ?? null;
    const planP = pm.planner;
    const critiqueP = pm.critic;
    const docP = pm.documenter;

    const runArtifacts: RunArtifacts = {};
    const shared = (task: string, phaseAgent: string) => {
        if (!h.config.sharedContext) return task;
        const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
        return bundle ? `${bundle}\n\n---\n\n${task}` : task;
    };

    let scoutFindings = "";
    if (scoutP) {
        const abort = checkAbort(s, h);
        if (abort) return abort;
        const scoutRes = await h.execution.runPhase(
            scoutP,
            scoutTask(request),
            cwd,
        );
        if (!scoutRes.ok) return fail(s, "Scouting", scoutRes.output);
        scoutFindings = scoutRes.output;
        runArtifacts.recon = scoutFindings;
    }

    let aborted = checkAbort(s, h);
    if (aborted) return aborted;
    let plan = await h.execution.runPhase(
        planP,
        specPlanTask(request, scoutFindings),
        cwd,
    );
    if (!plan.ok) return fail(s, "Planning", plan.output);
    runArtifacts.plan = plan.output;

    let critique = { output: "", ok: true };
    let critiqueVerdict: CritiqueVerdict = "unknown";

    for (let loop = 1; loop <= maxCritiqueLoops; loop++) {
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        critiqueP.status = "pending";
        h.ui.updateWidget();
        critique = await h.execution.runPhase(
            critiqueP,
            shared(specCriticTask(request, plan.output), "critic"),
            cwd,
        );
        if (!critique.ok) return fail(s, "Critique", critique.output);

        critiqueVerdict = detectCritique(critique.output);
        if (critiqueVerdict !== "revise") break;

        if (loop === maxCritiqueLoops) break;
        aborted = checkAbort(s, h);
        if (aborted) return aborted;
        planP.status = "pending";
        planP.note = "";
        h.ui.updateWidget();
        plan = await h.execution.runPhase(
            planP,
            specReviseTask(request, plan.output, critique.output),
            cwd,
        );
        if (!plan.ok) return fail(s, "Plan revision", plan.output);
        runArtifacts.plan = plan.output;
    }

    runArtifacts.critique = critique.output;

    aborted = checkAbort(s, h);
    if (aborted) return aborted;
    const doc = await h.execution.runPhase(
        docP,
        shared(specDocumentTask(request, plan.output), "documenter"),
        cwd,
    );
    if (!doc.ok) return fail(s, "Documentation", doc.output);
    runArtifacts.docReport = doc.output;

    const critiqueApproved = critiqueVerdict !== "revise";
    const status = critiqueApproved ? "done" : "needs-review";
    s.runElapsedMs = Date.now() - s.runStartedAt;
    s.running = false;
    s.lastStatus = status;
    h.ui.updateWidget();

    const outcome = critiqueApproved
        ? "SPEC COMPLETE — implementation spec saved to specs/"
        : `NEEDS REVIEW — the critic did not approve the plan after ${maxCritiqueLoops} attempt(s). The spec was generated from the last plan revision; review the critique before using it.`;

    const report = buildSpecReport({
        request,
        outcome,
        totals: {
            runElapsedMs: s.runElapsedMs,
            totalToolCalls: s.totalToolCalls,
            totalTokens: s.totalTokens,
            totalDroppedLines: s.totalDroppedLines,
        },
        scoutP,
        planP,
        critiqueP,
        docP,
        scoutFindings,
        plan: plan.output,
        critique: critique.output,
        doc: doc.output,
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
});

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

    if (s.dispatchesThisTurn >= h.config.maxDispatchesPerTurn)
        return textResult(
            `Dispatch limit reached (${h.config.maxDispatchesPerTurn} per turn). Summarize what has been done and stop — do not dispatch more agents this turn.`,
        );

    // Only refresh agents from disk on a fresh user request. During a burst
    // of dispatches within the same turn the agent definitions don't change,
    // so re-reading from disk is wasted I/O.
    if (s.freshDispatchSession) s.agents = h.setup.loadAgents(ctx.cwd);
    const def = s.agents.get(agent.toLowerCase());
    if (!def) {
        const available = Array.from(s.agents.values())
            .map((d) => d.name)
            .join(", ");
        return textResult(
            `Agent "${agent}" not found. Available agents: ${available}`,
        );
    }

    if (onUpdate) onUpdate(textResult(`Dispatching to ${def.name}...`));

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
    // - If it's RUNNING, create a new phase (parallel dispatch)
    // - If it's PENDING/DONE/ERROR, reuse and reset it (sequential re-dispatch)
    const existingRunning = s.phases.find(
        (p) => p.agent === agentKey && p.status === "running",
    );
    const existingPhase = s.phases.find((p) => p.agent === agentKey);

    let phase: PhaseState;
    if (existingRunning) {
        // Another instance is already running - create new phase for parallel dispatch
        phase = mkPhase(displayName(def.name), agentKey, dispatchId);
        s.phases.push(phase);
    } else if (existingPhase) {
        // Reuse existing phase (reset it for sequential re-dispatch)
        const fresh = mkPhase(displayName(def.name), agentKey, dispatchId);
        Object.assign(existingPhase, fresh);
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
    const emptyOutput =
        res.output.trim().length < h.config.minDispatchOutputChars &&
        phase.toolCount === 0;
    const ok = res.exitCode === 0 && !emptyOutput;

    phase.status = ok ? "done" : "error";
    phase.elapsed = Date.now() - start;
    s.dispatchElapsedMs = Date.now() - s.dispatchStartedAt;
    h.ui.updateWidget();

    const errMsg = !ok
        ? emptyOutput
            ? ": returned no usable output"
            : `: ${res.output
                  .split("\n")
                  .filter((l) => l.trim())
                  .slice(-2)
                  .join(" ")
                  .slice(0, 120)}`
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
    for (const n of names) {
        const def = s.agents.get(n.toLowerCase());
        if (def) resolved.push(def.name.toLowerCase());
        else unknown.push(n);
    }

    if (resolved.length === 0) {
        const available = Array.from(s.agents.values())
            .map((d) => d.name)
            .join(", ");
        return textResult(
            `No valid agents in selection. Available agents: ${available}`,
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
    s.phases = resolved.map(
        (key) => byAgent.get(key) ?? mkPhase(displayName(key), key),
    );
    h.setup.setupSessions(ctx.cwd, false);
    h.ui.updateWidget();

    const order = resolved.map((k) => displayName(k)).join(" → ");
    const warn = unknown.length
        ? ` (ignored unknown: ${unknown.join(", ")})`
        : "";
    return {
        content: [
            {
                type: "text",
                text: `Selected ${resolved.length} agent${resolved.length === 1 ? "" : "s"} for the work: ${order}.${warn} The dashboard now shows them queued — dispatch them in order.`,
            },
        ],
        details: { selected: resolved, order, unknown },
    };
}
