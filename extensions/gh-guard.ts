// ABOUTME: Confines an agent's GitHub access to READ-ONLY `gh` commands. Registers a
// blocking `tool_call` hook on `bash` that rejects mutating `gh` invocations (PR/issue
// create/merge/close/comment/review, releases, repo edits, write `gh api` calls, …).
//
// The spawn loads this ONLY into sub-agents that have `bash` but no `write`/`edit`
// tool — the read-only agents (scout, reviewer, validator) that must query GitHub
// but never change remote state. Its mere presence IS the policy; agents that may
// write (e.g. shipper, the designated PR-opener) don't load it. See
// workflow-core.subagentExtArgs.
//
// Default-deny over a small read-only allowlist (see utils/gh-policy) since
// enumerating every mutating subcommand is brittle. LIMITATION: this is gh-only — it
// does NOT police `git push`/`git commit` (bash isn't reliably parseable); the agent
// prompts remain the backstop for those, exactly as for cwd-guard.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { blockedGhCommands } from "../utils/gh-policy";

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event)) return undefined;
        const input = event.input as { command?: string; cmd?: string };
        const cmd = input.command ?? input.cmd ?? "";
        const bad = blockedGhCommands(cmd);
        if (bad.length === 0) return undefined;
        return {
            block: true,
            reason:
                "Blocked: this agent is read-only on GitHub — it may run only " +
                "read/query `gh` commands (e.g. pr view/diff/checks/list, run " +
                "view/list, issue view/list, repo view, search, and GET-only `gh " +
                `api\`). Refusing the mutating command(s): ${bad.join("; ")}. If ` +
                "GitHub needs to change, report it for the shipper (or the user) to do.",
        };
    });
}
