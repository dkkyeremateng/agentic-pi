// ABOUTME: Stops any agent from bringing a git repository into existence, or
// repointing one at a new remote. Blocks `git init`, `gh repo create`, and
// `git remote add` on the `bash` tool.
//
// Loaded for the WRITE-CAPABLE bash agents (implementer, shipper) — the ones that
// legitimately mutate git and therefore load no other guard. Read-only agents are
// already covered by readonly-guard, whose policy treats all three as mutating.
//
// Why a guard and not just a prompt: agents/shipper.md used to say "if a git repo
// does not exist yet (new app), run `git init`" — a single stale line was all it
// took to make repo creation routine. Where a project's history begins is the
// user's decision, and an unasked-for repo is awkward to undo once commits land on
// it. The prompts state the rule; this makes it hold when a prompt drifts.
//
// LIMITATION: same as every bash guard here — shell is not reliably parseable, so
// this catches direct invocations, not every possible indirection.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
    blockedRepoCreation,
    blockedRootSearch,
} from "../utils/guards/readonly-policy";

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event)) return undefined;
        const input = event.input as { command?: string; cmd?: string };
        const cmd = input.command ?? input.cmd ?? "";
        if (blockedRootSearch(cmd).length > 0) {
            return {
                block: true,
                reason:
                    "Blocked: `find /` searches every mounted volume and every " +
                    "permission-denied branch, and takes minutes to return " +
                    "nothing useful. Scope the search: use the `find`/`grep` " +
                    "tools (confined to the working directory), or give `find` a " +
                    "real starting directory. If the file is genuinely outside " +
                    "the project, name the package or install path directly.",
            };
        }
        const bad = blockedRepoCreation(cmd);
        if (bad.length === 0) return undefined;
        return {
            block: true,
            reason:
                `Blocked: ${bad.join("; ")}. No agent creates a repository or adds a ` +
                "remote — where a project's history begins, and where it pushes, is " +
                "the user's decision, not a side effect of this run. If there is no " +
                "repo, report that plainly and give the user the exact commands to " +
                "run; the absence of a repo is a fact to report, never a gap to fill.",
        };
    });
}
