// ABOUTME: Canonical reference implementation of the workflow orchestration engine.
// ABOUTME: Encapsulates spawnAgentWithModel, runPhase, runWorkflow, and runSpecWorkflow
// ABOUTME: with all improvements: populated RunArtifacts, token tracking, failPhase helper,
// ABOUTME: PhaseMap access, progress estimation, graceful degradation, and retry logging.
//
// STATUS: This class is the canonical, tested implementation. Both agent-pipeline.ts
// and agent-team.ts currently carry their own inline copies of runWorkflow/runSpecWorkflow
// because their widget renderers reference module-level state directly. Adopting this
// class fully requires either (a) refactoring widget renderers to read from a runtime
// instance, or (b) adding a sync bridge that copies state between the runtime and module
// variables before/after each workflow call. Either approach is a ~500-line refactor that
// should be done with widget-renderer test coverage in place.
//
// The shared spawnAgentWithModel in workflow-core.ts IS already used by both extensions
// and this class — the spawn extraction is complete.
//
// Lives in .pi/utils/ so pi does not auto-load it — imported, not discovered.

import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
    type Verdict,
    type CritiqueVerdict,
    detectVerdict,
    detectShip,
    detectCritique,
    isModelFailure,
    secs,
    digest,
    testSignal,
    outcomeLine,
} from "./workflow-utils";
import {
    REQUIRED_AGENTS,
    DEFAULT_MAX_LOOPS,
    LOG_CAP_CHARS,
    STDERR_TAIL_CAP,
    setupSessions as setupSessionsCore,
    contextBundleForPhase,
    type RunArtifacts,
    type AgentDef,
    type PhaseState,
    type TokenUsage,
    type PhaseMap,
    buildPhaseMap,
    failPhase,
    tokenNote,
    displayName,
    validatePlan,
    mkPhase as mkPhaseCore,
    freshPhases as freshPhasesCore,
    runPhaseCore,
    runAgentWithFallback,
    spawnAgentWithModel as coreSpawnAgent,
    type SpawnConfig as CoreSpawnConfig,
    type SpawnResult as CoreSpawnResult,
    scoutTask,
    planTask,
    implementTask,
    fixTask,
    testTask,
    documentTask,
    validateTask,
    shipTask,
    criticTask,
    revisePlanTask,
    specPlanTask,
    specReviseTask,
    specCriticTask,
    specDocumentTask,
} from "./workflow-core";

// ── Config ───────────────────────────────────────

export interface RuntimeConfig {
    /** Extension identity: "agent-pipeline" or "agent-team" */
    selfName: string;
    /** Resolve the model string for a given agent key */
    modelFor: (agentKey: string) => string;
    /** Whether to use a single shared session file for all agents */
    sharedSession: boolean;
    /** Whether to prepend the curated context bundle to later phases */
    sharedContext: boolean;
    /** Per-agent watchdog timeout in ms (0 = no timeout) */
    agentTimeoutMs: number;
    /** Callback to refresh the widget after state changes */
    updateWidget: () => void;
    /** Callback to send a notification to the user */
    notify?: (msg: string, level: string) => void;
    /** Current widget context (for model info, notifications, etc.) */
    getWidgetCtx: () => any;
}

// ── Types ────────────────────────────────────────

export interface SpawnResult {
    output: string;
    exitCode: number;
    tokens?: TokenUsage;
}

export interface WorkflowResult {
    status: string;
    report: string;
}

// ── Runtime ──────────────────────────────────────

export class WorkflowRuntime {
    // Shared state — read by both the engine and the extension's widget renderer.
    phases: PhaseState[] = [];
    phaseLogs: { label: string; log: string }[] = [];
    totalDroppedLines = 0;
    totalToolCalls = 0;
    totalTokens: { input: number; output: number } = { input: 0, output: 0 };
    runStartedAt = 0;
    runElapsedMs = 0;
    iteration = 0;
    maxLoopsRef = DEFAULT_MAX_LOOPS;
    lastStatus = "idle";
    running = false;
    currentProc: any = null;
    sessionDir = "";
    includeScout = false;
    isSpecMode = false;

    private activeTeamMembers: string[] = [];

    constructor(private config: RuntimeConfig) {}

    // ── Helpers ──────────────────────────────────

    // Delegate to shared core implementations (extracted to eliminate ~60 lines
    // of pure duplication across extensions and runtime).
    mkPhase(label: string, agent: string): PhaseState {
        return mkPhaseCore(label, agent);
    }

    freshPhases(): PhaseState[] {
        return freshPhasesCore(this.includeScout, this.isSpecMode);
    }

    setupSessions(cwd: string, wipe: boolean) {
        this.sessionDir = setupSessionsCore(cwd, wipe);
    }

    setActiveTeamMembers(members: string[]) {
        this.activeTeamMembers = members;
        this.includeScout = members.some((m) => m.toLowerCase() === "scout");
    }

    // ── Spawn ────────────────────────────────────

    spawnAgentWithModel(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
        model: string,
    ): Promise<SpawnResult> {
        const cfg: CoreSpawnConfig = {
            sessionDir: this.sessionDir,
            sharedSession: this.config.sharedSession,
            agentTimeoutMs: this.config.agentTimeoutMs,
            updateWidget: () => this.config.updateWidget(),
            setCurrentProc: (p: any) => {
                this.currentProc = p;
            },
        };
        const prevToolCount = phase.toolCount;
        const prevDroppedLines = phase.droppedLines;
        return coreSpawnAgent(agentDef, task, phase, cwd, model, cfg).then(
            (result) => {
                // Accumulate module-level counters from the shared spawn.
                this.totalToolCalls += phase.toolCount - prevToolCount;
                this.totalDroppedLines += phase.droppedLines - prevDroppedLines;
                if (result.tokens) {
                    this.totalTokens.input += result.tokens.input;
                    this.totalTokens.output += result.tokens.output;
                    phase.tokens = result.tokens;
                }
                return result;
            },
        );
    }

    // ── Run a single agent (with fallback) ───────

    async runAgent(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
    ): Promise<SpawnResult> {
        const agentKey = agentDef.name.toLowerCase();
        const primaryModel = this.config.modelFor(agentKey);

        // Fallback: the session model (if different from primary). The extension
        // provides this via getWidgetCtx().
        const ctx = this.config.getWidgetCtx();
        const sm = ctx?.model;
        const sessionModel =
            sm?.provider && sm?.id ? `${sm.provider}/${sm.id}` : sm?.id || "";
        const fallbackModel =
            sessionModel && sessionModel !== primaryModel ? sessionModel : "";

        // Delegate to shared core (eliminates ~50 lines of near-identical
        // fallback logic with notification API drift).
        return runAgentWithFallback(
            agentDef,
            task,
            phase,
            cwd,
            primaryModel,
            fallbackModel,
            (def, t, p, c, m) => this.spawnAgentWithModel(def, t, p, c, m),
            {
                updateWidget: () => this.config.updateWidget(),
                notify: (msg, level) => this.config.notify?.(msg, level),
            },
        );
    }

    // ── Run a phase ──────────────────────────────

    async runPhase(
        agents: Map<string, AgentDef>,
        phase: PhaseState,
        task: string,
        cwd: string,
    ): Promise<{ output: string; ok: boolean }> {
        // Delegate to shared core (eliminates behavioral drift across 3 copies).
        return runPhaseCore(
            agents,
            phase,
            task,
            cwd,
            (def, t, p, c) => this.runAgent(def, t, p, c),
            {
                updateWidget: () => this.config.updateWidget(),
                notify: (msg, level) => this.config.notify?.(msg, level),
                phaseLogs: this.phaseLogs,
            },
        );
    }

    // ── Full workflow ────────────────────────────

    async runWorkflow(
        agents: Map<string, AgentDef>,
        request: string,
        maxLoops: number,
        cwd: string,
    ): Promise<WorkflowResult> {
        this.isSpecMode = false;
        this.setupSessions(cwd, true);
        this.phases = this.freshPhases();
        this.phaseLogs = [];
        this.totalDroppedLines = 0;
        this.totalToolCalls = 0;
        this.totalTokens = { input: 0, output: 0 };
        this.runStartedAt = Date.now();
        this.runElapsedMs = 0;
        this.iteration = 0;
        this.maxLoopsRef = maxLoops;
        this.lastStatus = "running";
        this.running = true;
        this.config.updateWidget();

        const missing = REQUIRED_AGENTS.filter((a) => !agents.has(a));
        if (missing.length) {
            this.running = false;
            this.lastStatus = "error";
            return {
                status: "error",
                report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
            };
        }

        // Shared curated context (#2)
        const runArtifacts: RunArtifacts = {};
        const shared = (task: string, phaseAgent: string) => {
            if (!this.config.sharedContext) return task;
            const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
            return bundle ? `${bundle}\n\n---\n\n${task}` : task;
        };

        // Type-safe phase access (#11)
        const pm = buildPhaseMap(this.phases);
        const scoutP = pm.scout ?? null;
        const planP = pm.planner;
        const critiqueP = pm.critic;
        const implP = pm.implementer;
        const testP = pm.tester;
        const valP = pm.validator;
        const docP = pm.documenter;
        const shipP = pm.ship;

        // ── Scout (optional) ─────────────────────
        let scoutFindings = "";
        if (scoutP) {
            const scoutRes = await this.runPhase(
                agents,
                scoutP,
                scoutTask(request),
                cwd,
            );
            if (!scoutRes.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Scouting", scoutRes.output);
            }
            scoutFindings = scoutRes.output;
            runArtifacts.recon = scoutFindings; // #2
        }

        // ── Plan ─────────────────────────────────
        let plan = await this.runPhase(
            agents,
            planP,
            planTask(request, scoutFindings),
            cwd,
        );
        if (!plan.ok) {
            this.running = false;
            this.lastStatus = "error";
            return failPhase("Planning", plan.output);
        }
        runArtifacts.plan = plan.output; // #2

        const planCheck = validatePlan(plan.output);
        if (!planCheck.ok) {
            this.running = false;
            this.lastStatus = "error";
            return {
                status: "error",
                report: `Plan is missing required structure. The planner's output lacks:\n- ${planCheck.missing.join("\n- ")}\n\nThe implementer cannot act reliably on this plan. Re-run with a more specific request, or check that the planner agent definition is complete.`,
            };
        }

        // ── Critique loop ────────────────────────
        let critique = { output: "", ok: true };
        let critiqueVerdict: CritiqueVerdict = "unknown";

        for (let loop = 1; loop <= maxLoops; loop++) {
            // Progress: show phase X/Y (#8)
            this.iteration = loop;
            critiqueP.status = "pending";
            this.config.updateWidget();
            critique = await this.runPhase(
                agents,
                critiqueP,
                shared(criticTask(request, plan.output), "critic"),
                cwd,
            );
            if (!critique.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Critique", critique.output);
            }

            critiqueVerdict = detectCritique(critique.output);
            if (critiqueVerdict !== "revise") break;

            if (loop === maxLoops) break;
            planP.status = "pending";
            planP.note = "";
            this.config.updateWidget();
            plan = await this.runPhase(
                agents,
                planP,
                revisePlanTask(request, plan.output, critique.output),
                cwd,
            );
            if (!plan.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Plan revision", plan.output);
            }
            runArtifacts.plan = plan.output; // update on revision (#2, #6)
        }

        runArtifacts.critique = critique.output; // #2

        // ── Implement ────────────────────────────
        let impl = await this.runPhase(
            agents,
            implP,
            shared(implementTask(request, plan.output), "implementer"),
            cwd,
        );
        if (!impl.ok) {
            this.running = false;
            this.lastStatus = "error";
            return failPhase("Implementation", impl.output);
        }
        runArtifacts.implSummary = impl.output; // #2

        let test = { output: "", ok: false };
        let val = { output: "", ok: false };
        let doc = { output: "", ok: false };
        let ship = { output: "", ok: false };
        let verdict: Verdict = "unknown";

        // ── Correctness loop ─────────────────────
        for (let loop = 1; loop <= maxLoops; loop++) {
            this.iteration = loop;

            testP.status = "pending";
            valP.status = "pending";
            this.config.updateWidget();
            test = await this.runPhase(
                agents,
                testP,
                shared(testTask(request, plan.output, impl.output), "tester"),
                cwd,
            );
            if (!test.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Testing", test.output);
            }
            runArtifacts.testReport = test.output; // #2

            val = await this.runPhase(
                agents,
                valP,
                shared(
                    validateTask(request, plan.output, test.output),
                    "validator",
                ),
                cwd,
            );
            if (!val.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Validation", val.output);
            }

            verdict = detectVerdict(val.output);
            if (verdict !== "fail") break;

            if (loop === maxLoops) break;
            implP.status = "pending";
            implP.note = "";
            this.config.updateWidget();
            impl = await this.runPhase(
                agents,
                implP,
                shared(
                    fixTask(request, plan.output, val.output, impl.output),
                    "implementer",
                ),
                cwd,
            );
            if (!impl.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Re-implementation", impl.output);
            }
            // Retry logging (#6): update implSummary with attempt number
            runArtifacts.implSummary = `[attempt ${implP.attempt}] ${impl.output}`;
        }

        // ── Document + Ship (graceful degradation #7) ──
        let status: string;
        if (verdict === "pass") {
            doc = await this.runPhase(
                agents,
                docP,
                shared(
                    documentTask(
                        request,
                        plan.output,
                        impl.output,
                        test.output,
                    ),
                    "documenter",
                ),
                cwd,
            );
            if (!doc.ok) {
                // Graceful degradation: doc failure doesn't kill a passing build (#7)
                this.config.notify?.(
                    "Documenter failed — code changes are valid but docs were not updated. Proceeding to ship.",
                    "warning",
                );
                doc = {
                    output: "[Documenter failed — see activity logs]",
                    ok: false,
                };
            } else {
                runArtifacts.docReport = doc.output; // #2
            }

            ship = await this.runPhase(
                agents,
                shipP,
                shared(shipTask(request, test.output, doc.output), "ship"),
                cwd,
            );
            if (!ship.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Shipping", ship.output);
            }

            status =
                detectShip(ship.output) === "paused"
                    ? "paused-no-remote"
                    : "shipped";
        } else {
            status =
                verdict === "fail" ? "failed-after-retries" : "needs-review";
        }

        this.runElapsedMs = Date.now() - this.runStartedAt;
        this.running = false;
        this.lastStatus = status;
        this.config.updateWidget();

        const passes = this.iteration;
        const passed = verdict === "pass";
        const prUrl =
            (ship.output.match(/https?:\/\/\S*\/pull\/\d+/) || [])[0] || "";

        // Token summary (#5)
        const tokenLine =
            this.totalTokens.input > 0 || this.totalTokens.output > 0
                ? ` · ${(this.totalTokens.input + this.totalTokens.output).toLocaleString()} tokens (${this.totalTokens.input.toLocaleString()} in / ${this.totalTokens.output.toLocaleString()} out)`
                : "";

        const report = [
            `# Workflow Report`,
            ``,
            `**Request:** ${request}`,
            `**Outcome:** ${outcomeLine(status, passes)}`,
            `**Result:** ${status} · verdict ${verdict.toUpperCase()} · ${passes} attempt(s) of ${maxLoops}`,
            `**Totals:** ${secs(this.runElapsedMs)} wall-clock · ${this.totalToolCalls} tool call(s)${tokenLine}`,
            ...(prUrl ? [`**Pull request:** ${prUrl}`] : []),
            ...(this.totalDroppedLines > 0
                ? [
                      ``,
                      `> **Diagnostic:** ${this.totalDroppedLines} malformed JSON line(s) were dropped from agent output streams during this run. This may indicate a pi subprocess protocol issue. Full agent logs are appended below.`,
                  ]
                : []),
            ``,
            `## Summary of work`,
            ``,
            ...(scoutP
                ? [
                      `- **Scout** (${secs(scoutP.elapsed)}${tokenNote(scoutP)}) — ${digest(scoutFindings)}${scoutP.droppedLines > 0 ? ` [${scoutP.droppedLines} dropped]` : ""}`,
                  ]
                : []),
            `- **Planner** (${secs(planP.elapsed)}${tokenNote(planP)}) — ${digest(plan.output)}${planP.droppedLines > 0 ? ` [${planP.droppedLines} dropped]` : ""}`,
            `- **Critic** (${secs(critiqueP.elapsed)}${tokenNote(critiqueP)}) — ${digest(critique.output)}${critiqueP.droppedLines > 0 ? ` [${critiqueP.droppedLines} dropped]` : ""}`,
            `- **Implementer** (${secs(implP.elapsed)}${tokenNote(implP)}) — ${digest(impl.output)}${implP.droppedLines > 0 ? ` [${implP.droppedLines} dropped]` : ""}`,
            `- **Tester** (${secs(testP.elapsed)}${tokenNote(testP)}) — ${digest(test.output)}${testSignal(test.output)}${testP.droppedLines > 0 ? ` [${testP.droppedLines} dropped]` : ""}`,
            `- **Validator** (${secs(valP.elapsed)}${tokenNote(valP)}) — verdict ${verdict.toUpperCase()}. ${digest(val.output)}${valP.droppedLines > 0 ? ` [${valP.droppedLines} dropped]` : ""}`,
            ...(passed
                ? [
                      `- **Documenter** (${secs(docP.elapsed)}${tokenNote(docP)}) — ${digest(doc.output)}${docP.droppedLines > 0 ? ` [${docP.droppedLines} dropped]` : ""}`,
                      `- **Ship** (${secs(shipP.elapsed)}${tokenNote(shipP)}) — ${digest(ship.output)}${shipP.droppedLines > 0 ? ` [${shipP.droppedLines} dropped]` : ""}`,
                  ]
                : [
                      `- **Documenter / Ship** — skipped (change did not pass validation)`,
                  ]),
            ``,
            `## Details`,
            ``,
            ...(scoutP ? [`### Reconnaissance`, ``, scoutFindings, ``] : []),
            `### Plan`,
            ``,
            plan.output,
            ``,
            `### Critique`,
            ``,
            critique.output,
            ``,
            `### Implementation`,
            ``,
            impl.output,
            ``,
            `### Test Report`,
            ``,
            test.output,
            ``,
            `### Validation`,
            ``,
            val.output,
            ``,
            ...(passed
                ? [
                      `### Documentation`,
                      ``,
                      doc.output,
                      ``,
                      `### Ship`,
                      ``,
                      ship.output,
                      ``,
                  ]
                : []),
        ].join("\n");

        const reportPath = join(cwd, "workflow-report.md");
        try {
            writeFileSync(reportPath, report, "utf-8");
        } catch (e: any) {
            this.config.notify?.(
                `Could not write workflow-report.md: ${e.message}`,
                "warning",
            );
        }

        return { status, report };
    }

    // ── Spec workflow ────────────────────────────

    async runSpecWorkflow(
        agents: Map<string, AgentDef>,
        request: string,
        cwd: string,
    ): Promise<WorkflowResult> {
        this.isSpecMode = true;
        this.setupSessions(cwd, true);
        this.phases = this.freshPhases();
        this.phaseLogs = [];
        this.totalDroppedLines = 0;
        this.totalToolCalls = 0;
        this.totalTokens = { input: 0, output: 0 };
        this.runStartedAt = Date.now();
        this.runElapsedMs = 0;
        this.iteration = 1;
        this.maxLoopsRef = 1;
        this.lastStatus = "running";
        this.running = true;
        this.config.updateWidget();

        const missing = REQUIRED_AGENTS.filter((a) => !agents.has(a));
        if (missing.length) {
            this.running = false;
            this.lastStatus = "error";
            return {
                status: "error",
                report: `Missing agent definitions: ${missing.join(", ")}. Expected them in .pi/agents/.`,
            };
        }

        // Shared curated context (#2)
        const runArtifacts: RunArtifacts = {};
        const shared = (task: string, phaseAgent: string) => {
            if (!this.config.sharedContext) return task;
            const bundle = contextBundleForPhase(phaseAgent, runArtifacts);
            return bundle ? `${bundle}\n\n---\n\n${task}` : task;
        };

        const pm = buildPhaseMap(this.phases); // #11
        const scoutP = pm.scout ?? null;
        const planP = pm.planner;
        const critiqueP = pm.critic;
        const docP = pm.documenter;

        let scoutFindings = "";
        if (scoutP) {
            const scoutRes = await this.runPhase(
                agents,
                scoutP,
                scoutTask(request),
                cwd,
            );
            if (!scoutRes.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Scouting", scoutRes.output);
            }
            scoutFindings = scoutRes.output;
            runArtifacts.recon = scoutFindings; // #2
        }

        const maxCritiqueLoops =
            this.maxLoopsRef > 0 ? this.maxLoopsRef : DEFAULT_MAX_LOOPS;
        let plan = await this.runPhase(
            agents,
            planP,
            specPlanTask(request, scoutFindings),
            cwd,
        );
        if (!plan.ok) {
            this.running = false;
            this.lastStatus = "error";
            return failPhase("Planning", plan.output);
        }
        runArtifacts.plan = plan.output; // #2

        let critique = { output: "", ok: true };
        let critiqueVerdict: CritiqueVerdict = "unknown";

        for (let loop = 1; loop <= maxCritiqueLoops; loop++) {
            critiqueP.status = "pending";
            this.config.updateWidget();
            critique = await this.runPhase(
                agents,
                critiqueP,
                shared(specCriticTask(request, plan.output), "critic"),
                cwd,
            );
            if (!critique.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Critique", critique.output);
            }

            critiqueVerdict = detectCritique(critique.output);
            if (critiqueVerdict !== "revise") break;

            if (loop === maxCritiqueLoops) break;
            planP.status = "pending";
            planP.note = "";
            this.config.updateWidget();
            plan = await this.runPhase(
                agents,
                planP,
                specReviseTask(request, plan.output, critique.output),
                cwd,
            );
            if (!plan.ok) {
                this.running = false;
                this.lastStatus = "error";
                return failPhase("Plan revision", plan.output);
            }
            runArtifacts.plan = plan.output; // #2, #6
        }

        runArtifacts.critique = critique.output; // #2

        const doc = await this.runPhase(
            agents,
            docP,
            shared(specDocumentTask(request, plan.output), "documenter"),
            cwd,
        );
        if (!doc.ok) {
            this.running = false;
            this.lastStatus = "error";
            return failPhase("Documentation", doc.output);
        }
        runArtifacts.docReport = doc.output; // #2

        const critiqueApproved = critiqueVerdict !== "revise";
        const status = critiqueApproved ? "done" : "needs-review";
        this.runElapsedMs = Date.now() - this.runStartedAt;
        this.running = false;
        this.lastStatus = status;
        this.config.updateWidget();

        const outcome = critiqueApproved
            ? "SPEC COMPLETE — implementation spec saved to specs/"
            : `NEEDS REVIEW — the critic did not approve the plan after ${maxCritiqueLoops} attempt(s). The spec was generated from the last plan revision; review the critique before using it.`;

        const tokenLine =
            this.totalTokens.input > 0 || this.totalTokens.output > 0
                ? ` · ${(this.totalTokens.input + this.totalTokens.output).toLocaleString()} tokens`
                : "";

        const report = [
            `# Spec Workflow Report`,
            ``,
            `**Request:** ${request}`,
            `**Outcome:** ${outcome}`,
            `**Totals:** ${secs(this.runElapsedMs)} wall-clock · ${this.totalToolCalls} tool call(s)${tokenLine}`,
            ...(this.totalDroppedLines > 0
                ? [
                      ``,
                      `> **Diagnostic:** ${this.totalDroppedLines} malformed JSON line(s) were dropped from agent output streams during this run.`,
                  ]
                : []),
            ``,
            `## Summary`,
            ``,
            ...(scoutP
                ? [
                      `- **Scout** (${secs(scoutP.elapsed)}${tokenNote(scoutP)}) — ${digest(scoutFindings)}`,
                  ]
                : []),
            `- **Planner** (${secs(planP.elapsed)}${tokenNote(planP)}) — ${digest(plan.output)}`,
            `- **Critic** (${secs(critiqueP.elapsed)}${tokenNote(critiqueP)}) — ${digest(critique.output)}`,
            `- **Documenter** (${secs(docP.elapsed)}${tokenNote(docP)}) — ${digest(doc.output)}`,
            ``,
            `## Details`,
            ``,
            ...(scoutP ? [`### Reconnaissance`, ``, scoutFindings, ``] : []),
            `### Plan`,
            ``,
            plan.output,
            ``,
            `### Critique`,
            ``,
            critique.output,
            ``,
            `### Implementation Spec`,
            ``,
            doc.output,
        ].join("\n");

        const reportPath = join(cwd, "workflow-report.md");
        try {
            writeFileSync(reportPath, report, "utf-8");
        } catch (e: any) {
            this.config.notify?.(
                `Could not write workflow-report.md: ${e.message}`,
                "warning",
            );
        }

        return { status, report };
    }
}
