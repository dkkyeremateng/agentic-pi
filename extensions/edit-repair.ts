// ABOUTME: Makes the `edit` tool survive the whitespace the model cannot see.
// Registers a `tool_call` hook that, before an edit runs, either repairs an
// `oldText` whose mid-line padding was flattened, or rejects it with the file's
// actual bytes quoted so the next attempt lands.
//
// Measured over the obs sink (2026-06-11 -> 2026-08-27, 234 runs): 991 `edit`
// calls, 408 rejected — a 41% failure rate spread across phase-implementer
// (44.6%), the implementer (32.4%) and the orchestrator's own session (34.8%).
// That last one is why this is an extension and not more agent-prompt guidance:
// a third of the failures happen in pi's main session, where our agent
// definitions do not apply at all.
//
// Two behaviours, and the split between them is the whole safety argument:
//
//   REPAIR   `oldText` differs from the file only in MID-LINE padding. Rewrite
//            it to the file's bytes and let the edit through. Cannot reindent
//            anything, because indentation is never widened. 44 of the sink's
//            rejections.
//   EXPLAIN  `oldText` differs only in whitespace, but repairing would mean
//            touching indentation. Block with the file's actual text quoted.
//            219 of the sink's rejections, and in 201 of those the model's
//            `newText` carried the same flattened indent -- so an auto-repair
//            would have applied the edit and silently reindented the file.
//
// Anything else is left entirely alone: pi's own matcher and error message run
// unchanged. The hook never invents text, never edits `newText`, and never acts
// on a file it could not read.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { homedir } from "node:os";
import {
    decideEdit,
    guidanceFor,
    formatRepair,
    type EditPair,
} from "../utils/edit/edit-repair";

// Every repair is recorded. Rewriting a model's tool arguments is not something
// that should happen invisibly: if this hook ever makes a wrong call, the log is
// how it gets caught. Opt out with PI_EDIT_REPAIR_LOG=0.
const LOG_PATH = join(homedir(), ".pi", "agent", "edit-repair.log");

function audit(line: string): void {
    if (process.env.PI_EDIT_REPAIR_LOG === "0") return;
    try {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch {
        // Auditing must never break an edit.
    }
}

export default function (pi: ExtensionAPI) {
    let cwd = process.cwd();
    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx?.cwd || process.cwd();
    });

    // Guidance computed at tool_call time, waiting for its tool_result. Keyed by
    // toolCallId and deleted on use. Bounded so a result that never arrives (an
    // aborted turn) cannot grow it without limit.
    const pending = new Map<string, string>();
    const remember = (id: string, text: string) => {
        if (pending.size > 64) pending.clear();
        pending.set(id, text);
    };

    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("edit", event)) return undefined;
        // Disabled outright with PI_EDIT_REPAIR=0, so a run can rule this out as
        // a suspect without unloading the extension.
        if (process.env.PI_EDIT_REPAIR === "0") return undefined;

        const input = event.input as { path?: string; edits?: unknown };
        const path = input.path;
        if (typeof path !== "string" || !path) return undefined;
        // pi >= 0.83 already parses `edits` sent as a JSON string, so a
        // non-array here is a shape this hook does not understand. Leave it.
        if (!Array.isArray(input.edits) || input.edits.length === 0)
            return undefined;

        let body: string;
        try {
            body = readFileSync(isAbsolute(path) ? path : join(cwd, path), "utf8");
        } catch {
            // Unreadable, missing, or binary: pi will report it far better than
            // a guess from here.
            return undefined;
        }

        const decision = decideEdit(body, input.edits as EditPair[]);

        if (decision.kind === "repair") {
            // Mutating `event.input` in place is how pi's hook contract says to
            // change arguments ("To modify arguments, mutate `event.input` in
            // place instead"), so the edit proceeds with the corrected oldText.
            input.edits = decision.edits;
            for (const r of decision.repairs) audit(`REPAIR ${formatRepair(path, r)}`);
            return undefined;
        }

        const guidance = guidanceFor(path, decision);
        if (guidance) {
            audit(`${decision.kind.toUpperCase()} ${path} (advisory)`);
            remember(event.toolCallId, guidance);
        }
        // Never block -- see the note at the top of this file.
        return undefined;
    });

    pi.on("tool_result", (event) => {
        // isToolCallEventType narrows tool_call events only; a result event
        // carries the same toolName, so compare it directly.
        if (event.toolName !== "edit") return undefined;
        const guidance = pending.get(event.toolCallId);
        if (!guidance) return undefined;
        pending.delete(event.toolCallId);
        // Only speak up about a call that actually failed. If pi applied the
        // edit despite our reading of the file, our diagnosis was wrong and
        // saying it anyway would be worse than saying nothing.
        if (!event.isError) return undefined;
        return {
            content: [
                ...(event.content ?? []),
                { type: "text" as const, text: `\n\n${guidance}` },
            ],
        };
    });
}
