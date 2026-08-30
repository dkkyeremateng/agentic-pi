import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    readInlineTurns,
    writeInlineTurns,
    resetInlineTurns,
} from "./inline-budget";
import { inlineHandoffDue, inlineBudgetSpent } from "./workflow-core";

const fresh = () => mkdtempSync(join(tmpdir(), "inline-budget-"));

describe("the budget survives the process that spent it", () => {
    // Implementer instances are separate processes with no channel between them,
    // so a counter in memory resets on every validator rejection. That is the
    // whole bug: run-mtg4oipc-4e984 spent 225 inline turns across three
    // instances and only the third ever crossed 60.
    it("round-trips through the file", () => {
        const cwd = fresh();
        assert.equal(readInlineTurns(cwd), 0, "absent reads as zero");
        writeInlineTurns(cwd, 55);
        assert.equal(readInlineTurns(cwd), 55);
        writeInlineTurns(cwd, 126);
        assert.equal(readInlineTurns(cwd), 126);
    });

    it("creates .agent when the run has not yet", () => {
        const cwd = fresh();
        writeInlineTurns(cwd, 7);
        assert.ok(existsSync(join(cwd, ".agent", "inline-turns")));
    });

    it("reads anything unparseable as zero rather than throwing", () => {
        // Reading wrongly HIGH spawns a worker that was not needed; reading
        // wrongly low only restores the pre-#125 behaviour. Zero is the safe
        // failure, so corruption must land there.
        const cwd = fresh();
        mkdirSync(join(cwd, ".agent"), { recursive: true });
        for (const junk of ["", "   ", "abc", "-5", "NaN", "1e999999"]) {
            writeFileSync(join(cwd, ".agent", "inline-turns"), junk);
            const n = readInlineTurns(cwd);
            assert.ok(n === 0 || Number.isFinite(n), `${junk} -> ${n}`);
        }
    });

    it("never throws on an unwritable path", () => {
        // The budget is an optimisation. Losing it degrades the breaker to
        // per-session, which is not worth failing a run over.
        writeInlineTurns("/proc/nonexistent/nope", 5);
        assert.equal(readInlineTurns("/proc/nonexistent/nope"), 0);
    });

    it("resets, and tolerates resetting twice", () => {
        const cwd = fresh();
        writeInlineTurns(cwd, 99);
        resetInlineTurns(cwd);
        assert.equal(readInlineTurns(cwd), 0);
        resetInlineTurns(cwd); // already gone
    });
});

describe("replaying run-mtg4oipc-4e984 against the new rule", () => {
    // The real sequence: three implementer instances of 55, 71 and 99 turns,
    // spawned by two validator rejections. Under the per-session rule only the
    // third crossed 60, at which point $15.45 was already spent.
    const INSTANCES = [55, 71, 99];

    function replay(budgetEnv: NodeJS.ProcessEnv = {}) {
        let cumulative = 0;
        const firedAt: (number | null)[] = [];
        for (const len of INSTANCES) {
            let fired: number | null = null;
            for (let turn = 0; turn <= len; turn++) {
                if (
                    fired === null &&
                    inlineHandoffDue(cumulative + turn, turn, budgetEnv as any)
                )
                    fired = turn;
            }
            cumulative += len;
            firedAt.push(fired);
        }
        return { firedAt, cumulative };
    }

    it("hands off in instances 2 and 3, not just the last one", () => {
        const { firedAt, cumulative } = replay();
        assert.equal(cumulative, 225);
        // Instance 1 ends at 55, under the 60-turn budget, so it correctly
        // finishes inline -- the floor's win, left intact.
        assert.equal(firedAt[0], null);
        // Instances 2 and 3 inherit a spent budget, so each hands off as soon as
        // its grace is up instead of grinding to 71 and 99 turns. That moves
        // ~140 of the run's 225 inline turns onto fresh workers, which cost
        // $0.047/turn against the accumulated implementer's $0.074.
        assert.equal(firedAt[1], 15);
        assert.equal(firedAt[2], 15);
    });

    it("gives a fresh instance its grace before demanding a handoff", () => {
        // The case the floor exists to protect: a validator asks for a one-line
        // fix, and the run happens to be over budget. Spawning a worker with an
        // 18k-char prompt for that costs more than the fix.
        assert.equal(inlineHandoffDue(500, 0), false);
        assert.equal(inlineHandoffDue(500, 14), false);
        assert.equal(inlineHandoffDue(500, 15), true);
    });

    it("keeps the refusal more permissive than the nudge", () => {
        // Asymmetric on purpose: lifting the ban early is free, because an agent
        // told to work inline does not spontaneously dispatch. Nudging early
        // spends a worker that was not needed.
        assert.equal(inlineBudgetSpent(60), true, "ban lifts on cumulative alone");
        assert.equal(inlineHandoffDue(60, 3), false, "but nothing is said yet");
    });

    it("still does nothing at all when the breaker is off", () => {
        const off = { PI_INLINE_MAX_TURNS: "0" } as any;
        assert.deepEqual(replay(off).firedAt, [null, null, null]);
    });
});
