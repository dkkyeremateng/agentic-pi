// ABOUTME: The inline floor's turn budget, carried ACROSS implementer instances
// within one run.
//
// #125 counted turns per session, and run-mtg4oipc-4e984 showed why that is the
// wrong unit. The run had THREE implementer sessions -- 55, 71 and 99 turns --
// because the validator rejected twice and each rejection spawns a fresh
// implementer through `fixTask`. Every one of them started its count at zero, so
// 225 inline turns went by and only the third ever crossed 60. The breaker fired
// correctly, seven seconds after that crossing, and by then the run had already
// spent $15.45 on implementers.
//
// The count therefore has to outlive the process. It lives in a file beside the
// progress ledger because that is the only thing all the implementer instances of
// a run share: they are separate processes, spawned independently, with no
// channel between them. The orchestrator clears it when it seeds a fresh ledger,
// which is exactly once per new run and never on resume -- a resumed run should
// keep the budget it already spent.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FILE = "inline-turns";

const path = (cwd: string): string => join(cwd, ".agent", FILE);

/**
 * Inline turns already spent by EARLIER implementer instances of this run.
 *
 * Best-effort in both directions: a missing, empty or corrupt file reads as 0.
 * Reading it wrongly high would hand work to a worker that did not need one;
 * reading it wrongly low only restores the pre-#125 behaviour. Zero is the safe
 * failure, so anything unparseable becomes zero rather than throwing.
 */
export function readInlineTurns(cwd: string): number {
    try {
        const n = Number((readFileSync(path(cwd), "utf8") || "").trim());
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
        return 0;
    }
}

/** Record the run's spent turns. Never throws: losing the count degrades the
 *  breaker to per-session, which is where it was before, and is not worth
 *  failing a run over. */
export function writeInlineTurns(cwd: string, turns: number): void {
    try {
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        writeFileSync(path(cwd), String(Math.max(0, Math.floor(turns))));
    } catch {
        /* the budget is an optimisation, not a correctness requirement */
    }
}

/** Start a new run's budget at zero. Called where the progress ledger is seeded,
 *  so it happens once per new run and never on a resume. */
export function resetInlineTurns(cwd: string): void {
    try {
        unlinkSync(path(cwd));
    } catch {
        /* already absent */
    }
}
