// ABOUTME: Makes a `grep` whose parentheses do not balance run the search the
// agent meant, instead of dying in ripgrep's parser.
//
// pi wraps a grep pattern in a non-capturing group before ripgrep sees it, so an
// unbalanced paren becomes a hard parse error AND the error quotes a pattern the
// agent never wrote:
//
//     pattern sent: func (.*Stop
//     rg reported:  (?:func (.*Stop)   error: unclosed group
//
// 13 grep calls in the obs sink died exactly this way, all on two shapes: a Go
// receiver (`func (.*Stop`) and a call site (`Publish(`). Each cost a turn —
// ~3.2 cents whatever it contains — plus however long it took the agent to work
// out that the `(?:` in the error was not its own.
//
// This escapes ONLY the parens that have no partner, and only when the pattern
// does not compile as sent and does compile afterwards. A deliberate group is
// never touched; see utils/tools/grep-guard.ts for the full refusal list.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { balanceGroups, formatBalance } from "../utils/tools/grep-guard";

// Rewriting a model's tool arguments should never happen invisibly: if this hook
// ever makes a wrong call, the log is how it gets caught. It shares the edit
// hook's file so there is one place to look when a tool argument changed under
// an agent. Opt out with PI_GREP_GUARD_LOG=0.
const LOG_PATH = join(homedir(), ".pi", "agent", "edit-repair.log");

function audit(line: string): void {
    if (process.env.PI_GREP_GUARD_LOG === "0") return;
    try {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch {
        // Auditing must never break a search.
    }
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("grep", event)) return undefined;
        if (process.env.PI_GREP_GUARD === "0") return undefined;

        const input = event.input as { pattern?: unknown; literal?: unknown };
        const pattern = input.pattern;
        if (typeof pattern !== "string") return undefined;
        // A literal search treats the paren as a character already, so there is
        // nothing to balance and escaping would add a backslash to the needle.
        if (input.literal === true) return undefined;

        const fixed = balanceGroups(pattern);
        if (fixed === null) return undefined;

        // pi's hook contract says to change arguments by mutating `event.input`
        // in place, so the search proceeds with the balanced pattern.
        input.pattern = fixed;
        audit(`BALANCE ${formatBalance(pattern, fixed)}`);
        return undefined;
    });
}
