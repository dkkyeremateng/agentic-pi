// ABOUTME: Shared stateful orchestration engine for agent-pipeline and agent-team.
// ABOUTME: Encapsulates spawnAgentWithModel, runPhase, runWorkflow, and runSpecWorkflow
// ABOUTME: with all improvements: populated RunArtifacts, token tracking, failPhase helper,
// ABOUTME: PhaseMap access, progress estimation, graceful degradation, and retry logging.
// ABOUTME: Each extension creates an instance with its own config (modelFor, widget name, etc.)
//
// Lives in .pi/utils/ so pi does not auto-load it — imported, not discovered.

import { spawn } from "child_process";
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
    contextBundle,
    type RunArtifacts,
    type AgentDef,
    type PhaseState,
    type TokenUsage,
    type PhaseMap,
    buildPhaseMap,
    failPhase,
    displayName,
    validatePlan,
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

    mkPhase(label: string, agent: string): PhaseState {
        return {
            label,
            agent,
            status: "pending",
            elapsed: 0,
            note: "",
            log: "",
            droppedLines: 0,
            toolCount: 0,
            contextPct: 0,
            attempt: 0,
            modelFallback: false,
        };
    }

    freshPhases(): PhaseState[] {
        const lead = this.includeScout
            ? [this.mkPhase("Scout", "scout")]
            : [];
        if (this.isSpecMode) {
            return [
                ...lead,
                this.mkPhase("Plan", "planner"),
                this.mkPhase("Critique", "critic"),
                this.mkPhase("Document", "documenter"),
            ];
        }
        return [
            ...lead,
            this.mkPhase("Plan", "planner"),
            this.mkPhase("Critique", "critic"),
            this.mkPhase("Implement", "implementer"),
            this.mkPhase("Test", "tester"),
            this.mkPhase("Validate", "validator"),
            this.mkPhase("Document", "documenter"),
            this.mkPhase("Ship", "validator"),
        ];
    }

    setupSessions(cwd: string, wipe: boolean) {
        this.sessionDir = setupSessionsCore(cwd, wipe);
    }

    setActiveTeamMembers(members: string[]) {
        this.activeTeamMembers = members;
        this.includeScout = members.some(
            (m) => m.toLowerCase() === "scout",
        );
    }

    // ── Spawn ────────────────────────────────────

    spawnAgentWithModel(
        agentDef: AgentDef,
        task: string,
        phase: PhaseState,
        cwd: string,
        model: string,
    ): Promise<SpawnResult> {
        const key = agentDef.name.toLowerCase().replace(/\s+/g, "-");
        const sessionFile = join(
            this.sessionDir,
            this.config.sharedSession
                ? "pipeline-shared.json"
                : `${key}.json`,
        );
        const hasSession = existsSync(sessionFile);

        const args = [
            "--mode",
            "json",
            "-p",
            "--no-extensions",
            "--tools",
            agentDef.tools,
            "--append-system-prompt",
            agentDef.systemPrompt,
            "--session",
            sessionFile,
        ];
        if (model) args.push("--model", model);
        if (hasSession) args.push("-c");
        args.push(task);

        // Record the model this run is actually using so the card reflects it.
        phase.activeModel = model || undefined;

        const answer: string[] = [];
        let activity = "";
        let stderrTail = "";
        let timedOut = false;
        let capturedTokens: TokenUsage | undefined;
        const start = Date.now();

        return new Promise((resolve) => {
            const proc = spawn("pi", args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, PI_SUBAGENT: "1" },
                cwd,
            });
            this.currentProc = proc;

            const watchdog =
                this.config.agentTimeoutMs > 0
                    ? setTimeout(() => {
                          timedOut = true;
                          try {
                              proc.kill("SIGTERM");
                          } catch {}
                      }, this.config.agentTimeoutMs)
                    : null;

            let lastPaint = 0;
            const paint = (force = false) => {
                const now = Date.now();
                if (!force && now - lastPaint < 120) return;
                lastPaint = now;
                this.config.updateWidget();
            };
            const pushActivity = (s: string) => {
                activity += s;
                if (activity.length > LOG_CAP_CHARS)
                    activity = activity.slice(-LOG_CAP_CHARS);
                phase.log = activity;
                phase.note =
                    activity
                        .split("\n")
                        .filter((l: string) => l.trim())
                        .pop() || "";
            };
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

            const timer = setInterval(() => {
                phase.elapsed = Date.now() - start;
                this.config.updateWidget();
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
                        if (event.type === "message_update") {
                            const ev = event.assistantMessageEvent;
                            if (ev?.type === "text_delta") {
                                answer.push(ev.delta || "");
                                pushActivity(ev.delta || "");
                                paint();
                            } else if (ev?.type === "thinking_delta") {
                                pushActivity(ev.delta || "");
                                paint();
                            }
                        } else if (event.type === "tool_execution_start") {
                            phase.toolCount++;
                            this.totalToolCalls++;
                            pushActivity(
                                `\n→ ${event.toolName} ${compactArgs(event.args)}\n`,
                            );
                            paint(true);
                        } else if (event.type === "tool_execution_end") {
                            pushActivity(`✓ ${event.toolName}\n`);
                            paint(true);
                        } else if (
                            event.type === "message_end" ||
                            event.type === "agent_end"
                        ) {
                            const msg =
                                event.type === "message_end"
                                    ? event.message
                                    : (event.messages || []).find(
                                          (m: any) => m.role === "assistant",
                                      );
                            if (msg?.usage?.input) {
                                const ctxWindow =
                                    msg.usage.contextWindow ||
                                    msg.usage.max_tokens ||
                                    200_000;
                                phase.contextPct = Math.min(
                                    100,
                                    Math.round(
                                        (msg.usage.input / ctxWindow) * 100,
                                    ),
                                );
                                // Track token usage for the report (#5)
                                capturedTokens = {
                                    input: msg.usage.input || 0,
                                    output: msg.usage.output || 0,
                                    contextWindow: ctxWindow,
                                };
                                paint();
                            }
                        }
                    } catch {
                        phase.droppedLines++;
                        this.totalDroppedLines++;
                    }
                }
            });
            proc.stderr!.setEncoding("utf-8");
            proc.stderr!.on("data", (chunk: string) => {
                stderrTail += chunk;
                if (stderrTail.length > STDERR_TAIL_CAP)
                    stderrTail = stderrTail.slice(-STDERR_TAIL_CAP);
            });

            proc.on("close", (code) => {
                this.currentProc = null;
                if (buffer.trim()) {
                    try {
                        const event = JSON.parse(buffer);
                        if (
                            event.type === "message_update" &&
                            event.assistantMessageEvent?.type === "text_delta"
                        ) {
                            answer.push(
                                event.assistantMessageEvent.delta || "",
                            );
                        }
                    } catch {
                        phase.droppedLines++;
                        this.totalDroppedLines++;
                    }
                }
                clearInterval(timer);
                if (watchdog) clearTimeout(watchdog);
                phase.elapsed = Date.now() - start;
                let output = answer.join("");
                if (timedOut) {
                    output +=
                        (output ? "\n\n" : "") +
                        `[timed out after ${Math.round(this.config.agentTimeoutMs / 60_000)}m — killed by PI_WORKFLOW_AGENT_TIMEOUT]`;
                }
                if ((code ?? 1) !== 0 && stderrTail.trim()) {
                    output +=
                        (output ? "\n\n" : "") +
                        `[stderr]\n${stderrTail.trim()}`;
                }
                phase.note =
                    output
                        .split("\n")
                        .filter((l) => l.trim())
                        .pop() || phase.note;
                resolve({
                    output,
                    exitCode: timedOut ? 1 : (code ?? 1),
                    tokens: capturedTokens,
                });
            });

            proc.on("error", (err: any) => {
                this.currentProc = null;
                clearInterval(timer);
                if (watchdog) clearTimeout(watchdog);
                resolve({
                    output: `Error spawning agent: ${err.message}`,
                    exitCode: 1,
                });
            });
        });
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
            sm?.provider && sm?.id
                ? `${sm.provider}/${sm.id}`
                : sm?.id || "";
        const fallbackModel =
            sessionModel && sessionModel !== primaryModel
                ? sessionModel
                : "";

        const result = await this.spawnAgentWithModel(
            agentDef,
            task,
            phase,
            cwd,
            primaryModel,
        );

        // Accumulate tokens (#5)
        if (result.tokens) {
            this.totalTokens.input += result.tokens.input;
            this.totalTokens.output += result.tokens.output;
        }

        if (result.exitCode !== 0 && isModelFailure(result.output)) {
            const agentName = displayName(agentDef.name);
            if (!fallbackModel) {
                this.config.notify?.(
                    `${agentName}: model "${primaryModel}" failed to load or run, and no fallback is available.`,
                    "error",
                );
                return result;
            }

            phase.note = `⚠ ${primaryModel} failed → ${fallbackModel}`;
            phase.modelFallback = true;
            phase.toolCount = 0;
            phase.contextPct = 0;
            phase.droppedLines = 0;
            phase.log += `\n⚠ Model ${primaryModel} failed — retrying with ${fallbackModel}\n`;
            this.config.notify?.(
                `${agentName}: model "${primaryModel}" failed — falling back to ${fallbackModel}.`,
                "warning",
            );
            this.config.updateWidget();

            const retry = await this.spawnAgentWithModel(
                agentDef,
                task,
                phase,
                cwd,
                fallbackModel,
            );
            if (retry.tokens) {
                this.totalTokens.input += retry.tokens.input;
                this.totalTokens.output += retry.tokens.output;
            }
            if (retry.exitCode !== 0 && isModelFailure(retry.output)) {
                this.config.notify?.(
                    `${agentName}: the fallback model (${fallbackModel}) also failed.`,
                    "error",
                );
            } else if (retry.exitCode === 0) {
                this.config.notify?.(
                    `${agentName}: recovered on ${fallbackModel}.`,
                    "success",
                );
            }
            return retry;
        }
        return result;
    }

    // ── Run a phase ──────────────────────────────

    async runPhase(
        agents: Map<string, AgentDef>,
        phase: PhaseState,
        task: string,
        cwd: string,
    ): Promise<{ output: string; ok: boolean }> {
        const def = agents.get(phase.agent);
        if (!def) {
            phase.status = "error";
            this.config.updateWidget();
            return {
                output: `Agent "${phase.agent}" not found.`,
                ok: false,
            };
        }

        phase.attempt++;
        phase.status = "running";
        phase.log = "";
        phase.note = "";
        phase.toolCount = 0;
        phase.contextPct = 0;
        phase.droppedLines = 0;
        this.config.updateWidget();

        const res = await this.runAgent(def, task, phase, cwd);
        const elapsed = phase.elapsed;
        const statusWord =
            res.exitCode === 0 && res.output.trim().length > 0
                ? "done"
                : "error";
        const attemptNote =
            phase.attempt > 1 ? ` (attempt ${phase.attempt})` : "";

        phase.status = statusWord as PhaseState["status"];
        this.phaseLogs.push({
            label: `${phase.label}${attemptNote} [${secs(elapsed)}]`,
            log: phase.log,
        });
        this.config.updateWidget();

        return { output: res.output, ok: statusWord === "done" };
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
        const shared = (task: string) => {
            if (!this.config.sharedContext) return task;
            const bundle = contextBundle(runArtifacts);
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
                shared(criticTask(request, plan.output)),
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
            shared(implementTask(request, plan.output)),
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
                shared(testTask(request, plan.output, impl.output)),
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
                shared(validateTask(request, plan.output, test.output)),
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
                    fixTask(
                        request,
                        plan.output,
                        val.output,
                        impl.output,
                    ),
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
                shared(shipTask(request, test.output, doc.output)),
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
                      `- **Scout** (${secs(scoutP.elapsed)}) — ${digest(scoutFindings)}${scoutP.droppedLines > 0 ? ` [${scoutP.droppedLines} dropped]` : ""}`,
                  ]
                : []),
            `- **Planner** (${secs(planP.elapsed)}) — ${digest(plan.output)}${planP.droppedLines > 0 ? ` [${planP.droppedLines} dropped]` : ""}`,
            `- **Critic** (${secs(critiqueP.elapsed)}) — ${digest(critique.output)}${critiqueP.droppedLines > 0 ? ` [${critiqueP.droppedLines} dropped]` : ""}`,
            `- **Implementer** (${secs(implP.elapsed)}) — ${digest(impl.output)}${implP.droppedLines > 0 ? ` [${implP.droppedLines} dropped]` : ""}`,
            `- **Tester** (${secs(testP.elapsed)}) — ${digest(test.output)}${testSignal(test.output)}${testP.droppedLines > 0 ? ` [${testP.droppedLines} dropped]` : ""}`,
            `- **Validator** (${secs(valP.elapsed)}) — verdict ${verdict.toUpperCase()}. ${digest(val.output)}${valP.droppedLines > 0 ? ` [${valP.droppedLines} dropped]` : ""}`,
            ...(passed
                ? [
                      `- **Documenter** (${secs(docP.elapsed)}) — ${digest(doc.output)}${docP.droppedLines > 0 ? ` [${docP.droppedLines} dropped]` : ""}`,
                      `- **Ship** (${secs(shipP.elapsed)}) — ${digest(ship.output)}${shipP.droppedLines > 0 ? ` [${shipP.droppedLines} dropped]` : ""}`,
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
        } catch {}

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
        const shared = (task: string) => {
            if (!this.config.sharedContext) return task;
            const bundle = contextBundle(runArtifacts);
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
                shared(specCriticTask(request, plan.output)),
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
            shared(specDocumentTask(request, plan.output)),
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
                      `- **Scout** (${secs(scoutP.elapsed)}) — ${digest(scoutFindings)}`,
                  ]
                : []),
            `- **Planner** (${secs(planP.elapsed)}) — ${digest(plan.output)}`,
            `- **Critic** (${secs(critiqueP.elapsed)}) — ${digest(critique.output)}`,
            `- **Documenter** (${secs(docP.elapsed)}) — ${digest(doc.output)}`,
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
        } catch {}

        return { status, report };
    }
}
