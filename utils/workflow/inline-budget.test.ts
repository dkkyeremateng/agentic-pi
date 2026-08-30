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
import {
    inlineHandoffKind,
    inlineBudgetSpent,
    inlineSessionBudget,
    INLINE_SESSION_MAX_TURNS,
} from "./workflow-core";

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

describe("escalation on the instance that ignored the old notice", () => {
    // run-mtgd43jm-7555a instance #1: baseline 4 from a false start, then 127
    // turns in ONE session. It got the notice and ground on for ~70 more turns.
    // Under the split triggers it now gets the soft one first and the imperative
    // one four turns later, which is the escalation the single flag prevented.
    const at = (t: number) => inlineHandoffKind(4 + t, t);

    it("stays quiet while both counts are under budget", () => {
        assert.equal(at(15), null);
        assert.equal(at(55), null);
    });

    it("nudges when the RUN crosses, then commands when the SESSION does", () => {
        assert.equal(at(56), "run");
        assert.equal(at(60), "run", "60 is not a session problem — 66/70/71 all finished by then");
        assert.equal(at(89), "run");
        assert.equal(at(90), "session");
        assert.equal(at(127), "session");
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
                    inlineHandoffKind(cumulative + turn, turn, budgetEnv as any)
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
        assert.equal(inlineHandoffKind(500, 0), null);
        assert.equal(inlineHandoffKind(500, 14), null);
        assert.equal(inlineHandoffKind(500, 15), "run");
    });

    it("keeps the refusal more permissive than the nudge", () => {
        // Asymmetric on purpose: lifting the ban early is free, because an agent
        // told to work inline does not spontaneously dispatch. Nudging early
        // spends a worker that was not needed.
        assert.equal(inlineBudgetSpent(60), true, "ban lifts on cumulative alone");
        assert.equal(inlineHandoffKind(60, 3), null, "but nothing is said yet");
    });

    it("still does nothing at all when the breaker is off", () => {
        const off = { PI_INLINE_MAX_TURNS: "0" } as any;
        assert.deepEqual(replay(off).firedAt, [null, null, null]);
    });
});

describe("the session threshold, against every session actually observed", () => {
    // One number was doing two jobs. Every implementer session across six runs:
    //
    //     127, 99, 71, 70, 66, 59, 55, 30, 25, 18, 9
    //
    // Five crossed 60, and 66/70/71 all ENDED within ~11 turns of crossing — a
    // handoff there buys a spawn and a full prompt to save ten turns. Only 99 and
    // 127 ground on. 90 splits them with the widest margin the data offers:
    // nearest below is 71, nearest above is 99.
    //
    // [session length, baseline from earlier instances]
    const OBSERVED: [number, number, "session" | "run" | null][] = [
        [127, 4, "session"],
        [99, 0, "session"],
        [71, 0, "run"],
        [70, 0, "run"],
        [66, 0, "run"],
        [55, 0, null],
        [30, 55, "run"],
        [18, 110, "run"],
    ];

    const strongest = (len: number, base: number) => {
        let out: "session" | "run" | null = null;
        for (let t = 0; t <= len; t++) {
            const k = inlineHandoffKind(base + t, t);
            if (k === "session") return "session";
            if (k === "run") out = "run";
        }
        return out;
    };

    for (const [len, base, want] of OBSERVED)
        it(`a ${len}-turn session (after ${base}) ends at "${want}"`, () => {
            assert.equal(strongest(len, base), want);
        });

    it("commands a handoff ONLY for the two that ground on", () => {
        const commanded = OBSERVED.filter(([l, b]) => strongest(l, b) === "session");
        assert.deepEqual(commanded.map(([l]) => l), [127, 99]);
    });

    it("keeps the run budget at 60 while the session one is 90", () => {
        // They answer different questions. The run budget also lifts the dispatch
        // refusal, where firing early is free; the session one commands, where it
        // is not.
        assert.equal(INLINE_SESSION_MAX_TURNS, 90);
        assert.equal(inlineHandoffKind(60, 60), "run", "60 is no longer a session problem");
        assert.equal(inlineHandoffKind(90, 90), "session");
    });

    it("is overridable, and junk falls back rather than disabling it", () => {
        assert.equal(inlineSessionBudget({ PI_INLINE_MAX_SESSION_TURNS: "40" } as any), 40);
        assert.equal(inlineSessionBudget({ PI_INLINE_MAX_SESSION_TURNS: "x" } as any), 90);
        assert.equal(
            inlineHandoffKind(50, 45, { PI_INLINE_MAX_SESSION_TURNS: "40" } as any),
            "session",
        );
    });

    it("still switches off entirely with PI_INLINE_MAX_TURNS=0", () => {
        const off = { PI_INLINE_MAX_TURNS: "0" } as any;
        assert.equal(inlineHandoffKind(999, 999, off), null);
    });
});
