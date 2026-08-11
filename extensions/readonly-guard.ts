// ABOUTME: Keeps a read-only agent read-only. Registers a blocking `tool_call` hook
// on `bash` that rejects mutating `gh` invocations (PR/issue create/merge/close/
// comment/review, releases, repo edits, write `gh api` calls, …) AND mutating `git`
// invocations (push/commit/merge/rebase/reset/checkout/remote-add/config-write/…).
//
// The spawn loads this into sub-agents that have `bash` but no `write`/`edit` tool
// — the read-only agents (scout, reviewer, validator) that must query GitHub and
// inspect the repo but never change state — AND into write-capable agents that opt
// in with `read-only-bash: true` in frontmatter (planner and refiner write only
// .agent/plan.md, the roadmapper only roadmap.md, so their bash must stay
// read-only). It blocks mutating git/gh
// shell commands, not the write/edit tools, so the plan write still works. Its mere
// presence IS the policy; agents that legitimately mutate (the implementer, the
// shipper/PR-opener) don't load it. See workflow-core.subagentExtArgs.
//
// Policy lives in utils/guards/readonly-policy: gh uses a default-deny allowlist; git uses a
// denylist (read-only agents lean on git reads, so only known mutators are blocked).
// LIMITATION: bash isn't reliably parseable, so this catches direct `gh`/`git`
// invocations, not every shell trick (and not local branch/tag ops) — the agent
// prompts remain the backstop, exactly as for cwd-guard.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { blockedCommands } from "../utils/guards/readonly-policy";

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event)) return undefined;
        const input = event.input as { command?: string; cmd?: string };
        const cmd = input.command ?? input.cmd ?? "";
        const bad = blockedCommands(cmd);
        if (bad.length === 0) return undefined;
        return {
            block: true,
            reason:
                "Blocked: this agent is read-only — it may run only read/query `gh` " +
                "and `git` commands (e.g. gh pr view/diff/checks, git diff/log/show/" +
                `status). Refusing the mutating command(s): ${bad.join("; ")}. If a ` +
                "change is needed, report it for a write-capable agent (the shipper) " +
                "or the user to perform.",
        };
    });
}
