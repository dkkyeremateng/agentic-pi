import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAuditLog, formatCoverage } from "./edit-coverage";

// Real lines, copied from the audit log the hook produced.
const LOG = [
    `2026-08-30T12:00:56.483Z DECISION {"path":"m.go","bodyLen":101,"kind":"pass","states":["applies"],"repaired":[]}`,
    `2026-08-30T12:01:07.822Z DECISION {"path":"m.go","bodyLen":101,"kind":"repair","states":["repairable"],"repaired":[0]}`,
    `2026-08-30T12:02:00.000Z DECISION {"path":"x.go","bodyLen":50,"kind":"partial","states":["applies","missing"],"repaired":[]}`,
    `2026-08-30T12:03:00.000Z DECISION {"path":"y.go","bodyLen":10,"kind":"satisfied","states":["satisfied"],"repaired":[]}`,
    // the human-readable lines the log also carries, which must be ignored
    `2026-08-30T12:04:00.000Z REPAIR m.go edits[0] "a b" -> "a    b"`,
].join("\n");

describe("parseAuditLog", () => {
    it("counts calls and per-edit fates from the hook's own record", () => {
        // The point of this module: numerator AND denominator come from what the
        // hook saw, not from replaying oldText against the agent's last read.
        // Those diverge, and the offline reconstruction credited repairs that
        // could not have happened.
        const r = parseAuditLog(LOG);
        assert.equal(r.calls, 4);
        assert.equal(r.clean, 1);
        assert.equal(r.repairedCalls, 1);
        assert.equal(r.repairedEdits, 1);
        assert.equal(r.partial, 1);
        assert.equal(r.satisfied, 1);
        assert.deepEqual(r.states, {
            applies: 2,
            repairable: 1,
            missing: 1,
            satisfied: 1,
        });
    });

    it("ignores the human-readable lines beside the records", () => {
        // A REPAIR line describes the same event as its DECISION record; counting
        // both would double it.
        assert.equal(parseAuditLog(LOG).calls, 4);
    });

    it("filters by timestamp prefix, so one run can be read in isolation", () => {
        const r = parseAuditLog(LOG, "2026-08-30T12:02");
        assert.equal(r.calls, 2);
        assert.equal(r.clean, 0);
    });

    it("survives a torn final line and junk", () => {
        // A run in flight leaves a partial write. A reporting tool that throws
        // there is useless exactly when it is wanted.
        assert.equal(parseAuditLog(LOG + '\n2026-08-30T12:05:00Z DECISION {"pa').calls, 4);
        assert.equal(parseAuditLog("").calls, 0);
        assert.equal(parseAuditLog("nothing here").calls, 0);
    });
});

describe("formatCoverage", () => {
    it("reports percentages of EDITS, since a call is all-or-nothing", () => {
        const out = formatCoverage(parseAuditLog(LOG));
        assert.match(out, /edit calls seen by the hook: 4 {2}\(5 individual edits\)/);
        assert.match(out, /would land/);
        assert.match(out, /miss for reasons this hook cannot fix/);
    });

    it("says something sane about an empty log", () => {
        const out = formatCoverage(parseAuditLog(""));
        assert.match(out, /edit calls seen by the hook: 0/);
        assert.ok(!out.includes("NaN"), out);
    });
});
