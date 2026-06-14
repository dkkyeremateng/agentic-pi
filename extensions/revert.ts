/**
 * Revert — restore the workspace to the checkpoint taken before the last workflow
 * run. agent-workflow.ts snapshots the repo (HEAD + a `git stash create` of any
 * uncommitted work) to `.agent/checkpoints/latest.json` before each run; this
 * command reads that file and undoes the run, backing up the current state to a
 * stash first. Untracked files the run created are left in place (too destructive
 * to remove automatically).
 *
 * Split out of agent-workflow.ts: the checkpoint is persisted to disk, so /revert
 * needs none of the orchestrator's in-memory state — it stands entirely on its own.
 *
 * Usage: pi -e extensions/revert.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
    type Checkpoint,
    describeCheckpoint,
    revertCommands,
} from "../utils/workflow/checkpoint";
import { agentWorkflowLoaded } from "../utils/workflow/workflow-core";

// Where agent-workflow.ts writes the pre-run snapshot.
const checkpointPath = (cwd: string) =>
    join(cwd, ".agent", "checkpoints", "latest.json");

// Run a git command in `cwd`, returning trimmed stdout (throws on failure).
const git =
    (cwd: string) =>
    (args: string[]): string =>
        execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();

export default function (pi: ExtensionAPI) {
    // Companion to agent-workflow: /revert only makes sense for a workflow run, so
    // it registers only when agent-workflow.ts is also loaded.
    if (!agentWorkflowLoaded()) return;

    pi.registerCommand("revert", {
        description:
            "Revert the workspace to the checkpoint taken before the last workflow run (current state is backed up to a git stash first)",
        handler: async (_args: string, ctx: any) => {
            let cp: Checkpoint | null = null;
            try {
                cp = JSON.parse(
                    readFileSync(checkpointPath(ctx.cwd), "utf8"),
                ) as Checkpoint;
            } catch {
                cp = null;
            }
            if (!cp) {
                ctx.ui.notify(
                    "No checkpoint found — run a workflow first.",
                    "info",
                );
                return;
            }
            const run = git(ctx.cwd);
            const choice = await ctx.ui.select(
                `Revert workspace to ${describeCheckpoint(cp)}? Current state is backed up to a stash first.`,
                ["Revert", "Cancel"],
            );
            if (choice !== "Revert") {
                ctx.ui.notify("Revert cancelled.", "info");
                return;
            }
            let backup = "";
            try {
                backup = run(["stash", "create"]);
            } catch {}
            try {
                for (const cmd of revertCommands(cp)) run(cmd);
                ctx.ui.notify(
                    `Reverted to ${describeCheckpoint(cp)}.` +
                        (backup
                            ? ` Previous state backed up — restore with: git stash apply ${backup.slice(0, 12)}`
                            : "") +
                        " Any untracked files the run created were left in place.",
                    "info",
                );
            } catch (e: any) {
                ctx.ui.notify(
                    `Revert failed: ${e?.message || e}.` +
                        (backup
                            ? ` Your state is safe (backup ${backup.slice(0, 12)}).`
                            : ""),
                    "error",
                );
            }
        },
    });
}
