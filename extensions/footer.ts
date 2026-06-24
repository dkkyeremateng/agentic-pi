/**
 * Footer — the pi status bar. A dim `~/path: branch ✔` line (cwd + git branch +
 * clean/dirty mark) above `◆ <model> [· agent-workflow <status>]   $<cost> · [bar]
 * <ctx%>/<window>`. Two modes:
 *
 *  • With agent-workflow.ts loaded: the `· agent-workflow <status>` segment shows
 *    the live orchestration state (running phases, cost, model), published to
 *    globalThis by agent-workflow.ts (WORKFLOW_FOOTER_GLOBAL).
 *
 *  • Standalone (no agent-workflow): that status segment is dropped; cost is this
 *    session's own running total (summed from message_end), and the model/context
 *    are the session's own. Also applies this folder's theme/title defaults.
 *    (Merged in from the former extensions/minimal.ts, now with pwd/branch/cost.)
 *
 * Both paths render through the shared, unit-tested renderWorkflowFooter.
 *
 * Usage: pi -e extensions/footer.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "child_process";
import { applyExtensionDefaults } from "../utils/shared/themeMap";
import {
    agentWorkflowLoaded,
    renderWorkflowFooter,
    stickyContextUsage,
    WORKFLOW_FOOTER_GLOBAL,
    type WorkflowFooterState,
} from "../utils/workflow/workflow-core";

// Render OTHER extensions' status lines (set via ctx.ui.setStatus) — most notably
// the context pruner's "prune: N pending" / "summarizing…" / stats line. pi's
// built-in footer renders these from footerData.getExtensionStatuses(), but our
// setFooter override REPLACES that footer, so without re-rendering them here they'd
// be invisible (the pruner's queued/loaded toasts still show; its summarize feedback
// would not). Skip "agent-workflow" — our own status line already represents it.
function extensionStatusLine(footerData: any, theme: any, width: number): string {
    const m: ReadonlyMap<string, string> | undefined =
        footerData?.getExtensionStatuses?.();
    if (!m || m.size === 0) return "";
    const parts = Array.from(m.entries())
        .filter(([k]) => k !== "agent-workflow")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => String(v).replace(/[\r\n\t]+/g, " ").trim())
        .filter(Boolean);
    if (parts.length === 0) return "";
    return truncateToWidth(
        theme.fg("dim", " " + parts.join("   ")),
        width,
        theme.fg("dim", "…"),
    );
}

export default function (pi: ExtensionAPI) {
    const workflow = agentWorkflowLoaded();

    // Standalone mode tracks the session's own spend (workflow mode reads cost from
    // the orchestrator's published state instead).
    let sessionCostUsd = 0;
    // Standalone-mode prompt-cache accounting for the footer's hit rate (CH).
    let sessionCacheRead = 0;
    let sessionInput = 0;
    // Last context usage with a real percent/tokens. pi reports tokens/percent as
    // null when idle between turns (right after a job finishes, or post-compaction
    // before the next response); without this the footer would collapse the bar to
    // 0.0% on every idle frame. Sticky: keep showing the last known value until a
    // real reading replaces it.
    let lastUsage: any;
    if (!workflow)
        pi.on("message_end", async (event: any) => {
            const u = event?.message?.usage;
            if (event?.message?.role !== "assistant" || !u) return;
            if (typeof u.cost?.total === "number" && u.cost.total > 0)
                sessionCostUsd += u.cost.total;
            sessionCacheRead += u.cacheRead ?? 0;
            sessionInput += u.input ?? 0;
        });

    pi.on("session_start", async (_event, ctx: any) => {
        // TUI/RPC only — no footer chrome in print/json modes.
        if (!ctx.hasUI) return;
        lastUsage = undefined; // fresh context for a new/resumed/forked session
        // Standalone footer also owns this folder's theme/title defaults.
        if (!workflow) applyExtensionDefaults(import.meta.url, ctx);

        // The footer's TUI handle, captured when the component is built. Lets the
        // async git check below request a repaint so its result actually lands on
        // screen — an idle session has nothing else to trigger a re-render.
        let tui: any = null;

        // Was the context pruner mid-flush on the previous render? pi-context-prune
        // only toasts when batches QUEUE, not when they flush — so we watch its
        // status line leave the in-progress state ("pending"/"summarizing…") and
        // emit a one-time completion toast ourselves.
        let pruneBusy = false;

        // Cached working-tree cleanliness for the branch mark (✔ clean / ✘ dirty).
        // Recomputed off the render path — at most once per TTL, asynchronously — so
        // the footer never spawns git per frame. null = unknown / not a git repo.
        // On a real change we requestRender() so the mark appears without waiting
        // for some other event to repaint.
        let gitDirty: boolean | null = null;
        let gitDirtyCheckedAt = 0;
        const GIT_DIRTY_TTL_MS = 1500;
        const refreshGitDirty = (cwd: string) => {
            const now = Date.now();
            if (now - gitDirtyCheckedAt < GIT_DIRTY_TTL_MS) return;
            gitDirtyCheckedAt = now;
            execFile(
                "git",
                ["status", "--porcelain"],
                { cwd },
                (err, stdout) => {
                    const next = err ? null : stdout.trim().length > 0;
                    if (next === gitDirty) return;
                    gitDirty = next;
                    tui?.requestRender?.();
                },
            );
        };

        ctx.ui.setFooter?.((tuiArg: any, theme: any, footerData: any) => {
            tui = tuiArg;
            return {
                dispose: () => {},
                invalidate() {},
                render(width: number): string[] {
                    const cwd = ctx.cwd ?? process.cwd();
                    // Refresh the cached clean/dirty flag (throttled, async) so the
                    // branch mark stays current without blocking the render.
                    refreshGitDirty(cwd);
                    // Toast once when a pruner flush completes: its status leaves the
                    // in-progress state ("pending"/"summarizing…") back to a stats
                    // line. Deferred off the render path so notify() isn't a render
                    // side effect. (No-op when the pruner / its status line is off.)
                    const prune =
                        footerData?.getExtensionStatuses?.()?.get("context-prune") ??
                        "";
                    const busy = /pending|summari[sz]/i.test(prune);
                    if (pruneBusy && !busy && prune) {
                        const tail = prune.includes("│")
                            ? " " + prune.slice(prune.indexOf("│"))
                            : "";
                        queueMicrotask(() =>
                            ctx.ui?.notify?.(`pruner: flushed${tail}`, "info"),
                        );
                    }
                    pruneBusy = busy;
                    // Live orchestration state, published by agent-workflow.ts
                    // (workflow mode only). Absent in standalone mode — the status
                    // segment is then dropped (empty selfName) and we use the
                    // session's own model/cost.
                    const wf: WorkflowFooterState | undefined = workflow
                        ? (globalThis as any)[WORKFLOW_FOOTER_GLOBAL]?.()
                        : undefined;
                    const lines = renderWorkflowFooter({
                        width,
                        theme,
                        // Empty in standalone mode ⇒ no `· agent-workflow <status>`.
                        selfName: workflow ? "agent-workflow" : "",
                        // Primary (orchestrator) model — tracked live by the
                        // workflow so it follows /model changes; falls back to this
                        // session's model.
                        model: wf?.model ?? ctx.model?.id ?? "no-model",
                        // pwd + git branch on a dim line above the status. pi caches
                        // the branch (with a git watcher) on footerData; gitDirty
                        // drives ✔/✘.
                        cwd,
                        gitBranch: footerData?.getGitBranch?.() ?? null,
                        gitDirty,
                        running: wf?.running ?? false,
                        lastStatus: wf?.lastStatus ?? "idle",
                        iteration: wf?.iteration ?? 1,
                        maxLoopsRef: wf?.maxLoopsRef ?? 0,
                        dispatchMode: wf?.dispatchMode ?? false,
                        phases: wf?.phases ?? [],
                        dispatchElapsedMs: wf?.dispatchElapsedMs ?? 0,
                        runElapsedMs: wf?.runElapsedMs ?? 0,
                        primaryCostUsd: wf?.primaryCostUsd ?? sessionCostUsd,
                        cacheHitPct:
                            wf?.cacheHitPct ??
                            (sessionCacheRead + sessionInput > 0
                                ? (sessionCacheRead /
                                      (sessionCacheRead + sessionInput)) *
                                  100
                                : undefined),
                        // Sticky context usage: when the live read is unknown
                        // (idle between turns / right after a job), keep the last
                        // reading that had a real percent/tokens instead of
                        // collapsing the bar to 0.0%.
                        contextUsage: () => {
                            const get =
                                wf?.contextUsage ??
                                (() => ctx.getContextUsage?.());
                            lastUsage = stickyContextUsage(lastUsage, get());
                            return lastUsage;
                        },
                        visibleWidth,
                        truncateToWidth,
                    });
                    // Append other extensions' status lines (e.g. the pruner's),
                    // which our footer override would otherwise hide.
                    const ext = extensionStatusLine(footerData, theme, width);
                    if (ext) lines.push(ext);
                    return lines;
                },
            };
        });
    });
}
