import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    flexPattern,
    findFlexMatch,
    repairEdits,
    diagnoseMismatch,
    formatRepair,
    decideEdit,
    explainReason,
    MAX_OLD_TEXT_CHARS,
} from "./edit-repair";

// The line that started this: column-aligned help text, whose padding the model
// flattens to a single space every time.
const GO = [
    "func printUsage(stdout io.Writer) {",
    '\tfmt.Fprintln(stdout, "Usage: greet [flags]")',
    '\tfmt.Fprintln(stdout, " -n, --name string name to greet")',
    '\tfmt.Fprintln(stdout, " --version         print the version and exit")',
    '\tfmt.Fprintln(stdout, " --help            show this help")',
    "}",
].join("\n");

describe("findFlexMatch", () => {
    it("recovers the file's bytes when mid-line padding was flattened", () => {
        const sent = '\tfmt.Fprintln(stdout, " --version print the version and exit")';
        const got = findFlexMatch(GO, sent);
        assert.equal(
            got,
            '\tfmt.Fprintln(stdout, " --version         print the version and exit")',
        );
    });

    it("returns null when oldText already matches", () => {
        // Repairing an exact match could only move the edit somewhere else.
        const exact = '\tfmt.Fprintln(stdout, "Usage: greet [flags]")';
        assert.equal(findFlexMatch(GO, exact), null);
    });

    it("returns null when the widened pattern matches more than once", () => {
        // pi requires oldText to be unique, so an ambiguous repair would trade a
        // rejected edit for one that lands in the wrong place.
        const body = "a = f(1,  2)\nb = f(1,   2)\n";
        assert.equal(findFlexMatch(body, "f(1, 2)"), null);
    });

    it("returns null when the text is simply not there", () => {
        assert.equal(findFlexMatch(GO, "func nothingLikeThis() {"), null);
    });

    it("never invents whitespace the model did not send", () => {
        // oldText has no run where the file does: widening only ever stretches a
        // run the model already wrote, so this must not match.
        assert.equal(findFlexMatch("total = a + b", "total = a+b"), null);
    });

    it("gives up on an oldText too large to be a targeted edit", () => {
        const huge = "x y".repeat(MAX_OLD_TEXT_CHARS);
        assert.equal(flexPattern(huge), null);
    });
});

describe("flexPattern never widens indentation", () => {
    // The dangerous case. newText is not rewritten, so repairing a one-space
    // oldText to the file's four would apply the edit and then replace those
    // four with one -- silently reindenting, and breaking Python or YAML.
    // Replayed over the sink, 201 of 219 such edits carried the flattened indent
    // in newText too.
    it("leaves a run at the start of a line alone", () => {
        const body = "def f():\n    return 1\n";
        const sent = "def f():\n return 1";
        assert.equal(findFlexMatch(body, sent), null);
    });

    it("leaves a leading run alone", () => {
        const body = "\t\tvalue = 1\n";
        assert.equal(findFlexMatch(body, "\tvalue = 1"), null);
    });

    it("leaves a trailing run alone", () => {
        const body = "value = 1   \n";
        assert.equal(findFlexMatch(body, "value = 1 "), null);
    });

    it("still widens a mid-line run on an indented line", () => {
        // The indentation itself is untouched; only the padding inside the line
        // is widened, so the replacement cannot shift the line left or right.
        const body = "    name    = 'x'\n";
        assert.equal(findFlexMatch(body, "    name = 'x'"), "    name    = 'x'");
    });

    it("does not let a widened run swallow a line break", () => {
        const body = "a = 1\nb = 2\n";
        assert.equal(findFlexMatch(body, "a = 1 b = 2"), null);
    });
});

describe("repairEdits", () => {
    it("repairs what it can and leaves the rest untouched", () => {
        const edits = [
            {
                oldText: '\tfmt.Fprintln(stdout, " --version print the version and exit")',
                newText: "REPLACED",
            },
            { oldText: '\tfmt.Fprintln(stdout, "Usage: greet [flags]")', newText: "KEPT" },
        ];
        const { edits: out, repairs } = repairEdits(GO, edits);
        assert.equal(repairs.length, 1);
        assert.equal(repairs[0].index, 0);
        assert.match(out[0].oldText, /--version {9}print/);
        assert.equal(out[1].oldText, edits[1].oldText, "the exact match is untouched");
    });

    it("never touches newText", () => {
        const edits = [
            {
                oldText: '\tfmt.Fprintln(stdout, " --version print the version and exit")',
                newText: "  whatever   the model     intended  ",
            },
        ];
        const { edits: out } = repairEdits(GO, edits);
        assert.equal(out[0].newText, edits[0].newText);
    });

    it("preserves any other fields on the edit", () => {
        const edits = [
            {
                oldText: '\tfmt.Fprintln(stdout, " --version print the version and exit")',
                newText: "x",
                someFutureFlag: true,
            },
        ];
        const { edits: out } = repairEdits(GO, edits);
        assert.equal((out[0] as any).someFutureFlag, true);
    });

    it("survives malformed input rather than throwing", () => {
        assert.deepEqual(repairEdits(GO, undefined as any).repairs, []);
        assert.deepEqual(repairEdits(GO, [null as any]).repairs, []);
        assert.deepEqual(repairEdits(GO, [{ newText: "x" } as any]).repairs, []);
    });
});

describe("diagnoseMismatch", () => {
    it("finds the file's text when only indentation differs", () => {
        // Not repairable -- but knowing the answer is exactly what the model
        // needs, and what pi's "must match exactly" does not tell it.
        const body = "def f():\n    return 1\n";
        assert.equal(diagnoseMismatch(body, "def f():\n return 1"), "def f():\n    return 1");
    });

    it("says nothing when the text is genuinely absent", () => {
        // Stale or invented oldText: speculating here would be worse than pi's
        // own error.
        assert.equal(diagnoseMismatch(GO, "func somethingElse() {"), null);
    });

    it("says nothing when oldText already matches", () => {
        assert.equal(diagnoseMismatch(GO, "func printUsage(stdout io.Writer) {"), null);
    });

    it("says nothing when more than one span would fit", () => {
        const body = "f(1,  2)\nf(1,   2)\n";
        assert.equal(diagnoseMismatch(body, "f(1, 2)"), null);
    });
});

describe("formatRepair", () => {
    it("escapes whitespace so a run is visible as a run", () => {
        const line = formatRepair("main.go", { index: 0, from: "a b", to: "a    b" });
        assert.match(line, /main\.go edits\[0\]/);
        assert.match(line, /"a b" -> "a {4}b"/);
    });

    it("truncates a long span rather than filling the log with a file", () => {
        const line = formatRepair("x.ts", {
            index: 1,
            from: "y".repeat(500),
            to: "z".repeat(500),
        });
        assert.ok(line.length < 300, line.length.toString());
        assert.match(line, /\.\.\./);
    });
});

// ── the decision the hook acts on ──────────────────────────────────────────
// decideEdit is the whole policy; extensions/edit-repair.ts is a shim that reads
// the file and applies it. The shim cannot be unit tested (importing it pulls in
// pi's runtime, which only resolves inside pi), so the policy lives here where
// it can be.

describe("decideEdit", () => {
    const repairable = {
        oldText: '\tfmt.Fprintln(stdout, " --version print the version and exit")',
        newText: "REPLACED",
    };
    const exact = {
        oldText: '\tfmt.Fprintln(stdout, "Usage: greet [flags]")',
        newText: "x",
    };

    it("passes an edit that already matches", () => {
        assert.equal(decideEdit(GO, [exact]).kind, "pass");
    });

    it("repairs a flattened mid-line run", () => {
        const d = decideEdit(GO, [repairable]);
        assert.equal(d.kind, "repair");
        if (d.kind !== "repair") return;
        assert.equal(d.repairs.length, 1);
        assert.match(d.edits[0].oldText, /--version {9}print/);
        assert.equal(d.edits[0].newText, "REPLACED", "newText untouched");
    });

    it("explains an indentation mismatch instead of repairing it", () => {
        const body = "def f():\n    return 1\n";
        const d = decideEdit(body, [
            { oldText: "def f():\n return 1", newText: "def f():\n return 2" },
        ]);
        assert.equal(d.kind, "explain");
        if (d.kind !== "explain") return;
        assert.equal(d.index, 0);
        assert.equal(d.actual, "def f():\n    return 1");
    });

    it("explains before repairing, because a call fails as a unit", () => {
        // Repairing edits[1] would be wasted work: edits[0] cannot land, so the
        // call was always going to be rejected. The useful answer is why.
        const body = GO + "\ndef f():\n    return 1\n";
        const d = decideEdit(body, [
            { oldText: "def f():\n return 1", newText: "y" },
            repairable,
        ]);
        assert.equal(d.kind, "explain");
        if (d.kind !== "explain") return;
        assert.equal(d.index, 0);
    });

    it("passes when the mismatch is not about whitespace", () => {
        // Stale or invented text. Speculating would be worse than pi's own error.
        assert.equal(decideEdit(GO, [{ oldText: "func gone() {", newText: "x" }]).kind, "pass");
    });

    it("passes on shapes it does not understand", () => {
        assert.equal(decideEdit(GO, [] as any).kind, "pass");
        assert.equal(decideEdit(GO, undefined as any).kind, "pass");
        assert.equal(decideEdit(GO, [{ newText: "x" } as any]).kind, "pass");
    });
});

describe("explainReason", () => {
    it("quotes the file's bytes and forbids the retry that wastes the turn", () => {
        // 153 of the sink's 408 rejections re-sent an oldText that had already
        // been rejected, and one run answered four rejections with five python3
        // heredocs hunting a character that was never there.
        const r = explainReason("main.go", 2, "  aligned    text");
        assert.match(r, /edits\[2\]\.oldText is not in main\.go/);
        assert.ok(r.includes("  aligned    text"), "the real bytes are quoted");
        assert.match(r, /Do NOT re-send/);
        assert.match(r, /invisible characters/);
    });
});
