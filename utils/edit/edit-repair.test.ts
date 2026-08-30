import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    repairCarriedWhitespace,
    flexPattern,
    findFlexMatch,
    repairEdits,
    diagnoseMismatch,
    formatRepair,
    decideEdit,
    explainReason,
    satisfiedReason,
    partialReason,
    classifyBatch,
    repairIndent,
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

    it("refuses to repair an edit into a no-op", () => {
        // The production failure this guard exists for (run-mte7ns9m-z8377): the
        // model is REALIGNING a padded column, so the whitespace this module
        // normalises away is the very change it is making. The file already holds
        // the aligned form, so repairing oldText makes oldText === newText and pi
        // answers "No changes made ... identical content" -- strictly worse than
        // the truthful "Could not find the exact text", which says the oldText is
        // stale because the change already landed.
        const body = 'fmt.Fprintln(w, " --style string    greeting style")\n';
        const edits = [
            {
                oldText: 'fmt.Fprintln(w, " --style string greeting style")',
                newText: 'fmt.Fprintln(w, " --style string    greeting style")',
            },
        ];
        const { edits: out, repairs } = repairEdits(body, edits);
        assert.equal(repairs.length, 0, "no repair");
        assert.equal(out[0].oldText, edits[0].oldText, "left exactly as sent");
    });

    it("still repairs when newText is a genuine change", () => {
        // The guard must be narrow: only a repair that lands ON newText is
        // refused. A real edit whose oldText merely has flattened padding still
        // gets fixed.
        const body = 'fmt.Fprintln(w, " --style string    greeting style")\n';
        const edits = [
            {
                oldText: 'fmt.Fprintln(w, " --style string greeting style")',
                newText: 'fmt.Fprintln(w, " --style string    SOMETHING ELSE")',
            },
        ];
        const { edits: out, repairs } = repairEdits(body, edits);
        assert.equal(repairs.length, 1);
        assert.match(out[0].oldText, /string {4}greeting/);
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

    it("REPAIRS an indentation mismatch, correcting newText too", () => {
        // This asserted "explain" until the run data showed why that was wrong.
        // #115 refused indentation repairs because rewriting oldText ALONE lets
        // newText's flattened indent reindent the file. Correcting both removes
        // the objection, and this is the largest category of failure: across
        // four runs, 80% of failed edits differed from the text the agent had
        // just read only in whitespace, mostly collapsed indentation.
        const body = "def f():\n    return 1\n";
        const d = decideEdit(body, [
            { oldText: "def f():\n return 1", newText: "def f():\n return 2" },
        ]);
        assert.equal(d.kind, "repair");
        if (d.kind !== "repair") return;
        assert.equal(d.edits[0].oldText, "def f():\n    return 1");
        // The safety property that makes this sound: newText carries the FILE's
        // indentation, not the model's flattened space. Without this the edit
        // would apply and silently dedent the block.
        assert.equal(d.edits[0].newText, "def f():\n    return 2");
    });

    it("gives an inserted line the indentation of its neighbours", () => {
        // Seen on real data: a Go import block sent with single-space indents,
        // adding one line. The new line must land with the file's tabs.
        const body = 'import (\n\t"bytes"\n\t"testing"\n)\n';
        const d = decideEdit(body, [
            {
                oldText: 'import (\n "bytes"\n "testing"\n)',
                newText: 'import (\n "bytes"\n "errors"\n "testing"\n)',
            },
        ]);
        assert.equal(d.kind, "repair");
        if (d.kind !== "repair") return;
        assert.equal(d.edits[0].newText, 'import (\n\t"bytes"\n\t"errors"\n\t"testing"\n)');
    });

    it("handles indentation AND interior alignment flattened together", () => {
        // The commonest real shape, and the one a trim()-based match missed:
        // nine of the ten edit misses in run-mtevhlm5-v6271 flattened both at
        // once. Matching on trim() alone leaves the interior padding intact, so
        // '"hello": A,' never matched '"hello":    A,'.
        const body = 'var m = map[string]f{\n\t"hello":    A,\n\t"farewell": B,\n}\n';
        const r = repairIndent(body, {
            oldText: 'var m = map[string]f{\n "hello": A,\n "farewell": B,\n}',
            newText: 'var m = map[string]f{\n "hello": A,\n "farewell": B,\n "wave": C,\n}',
        });
        assert.ok(r);
        assert.equal(r!.oldText, 'var m = map[string]f{\n\t"hello":    A,\n\t"farewell": B,\n}');
        // The load-bearing property: a line the model only mangled comes back
        // BYTE FOR BYTE, interior alignment included. Rebuilding it as indent +
        // trimmed text would keep the flattened padding and silently de-align
        // the file -- the regression #118's audit exists to catch.
        assert.ok(r!.newText.includes('\t"hello":    A,'), "alignment restored");
        // ...and a line the model genuinely added gets the file's indentation.
        assert.ok(r!.newText.includes('\t"wave": C,'), "new line indented");
    });

    it("refuses when the same line sits at two different indents", () => {
        // Ambiguous: we cannot know which one the model meant, so guessing
        // could reindent the wrong block.
        // The SAME trimmed line at two depths inside the matched run: there is
        // no single right answer, so it must decline rather than pick one.
        const body = "if a {\n\tx()\n\t\tx()\n}\n";
        assert.equal(
            repairIndent(body, {
                oldText: "if a {\n x()\n x()\n}",
                newText: "if a {\n y()\n y()\n}",
            }),
            null,
        );
    });

    it("refuses when more than indentation differs", () => {
        // Not an indentation problem; repairing would be speculation.
        const body = "def f():\n    return 1\n";
        assert.equal(repairIndent(body, { oldText: "def g():\n return 1", newText: "x" }), null);
    });

    it("routes a mixed BATCH to partial, which supersedes explain-first", () => {
        // Repairing edits[1] would be wasted work: edits[0] cannot land, so the
        // call was always going to be rejected. The useful answer is why.
        const body = GO + "\ndef f():\n    return 1\n";
        const d = decideEdit(body, [
            { oldText: "def f():\n return 1", newText: "y" },
            repairable,
        ]);
        // Was "explain" (name the first blocker). For a batch the partial
        // breakdown says everything explain did AND which siblings were fine,
        // which is the whole point of the batch path.
        // The indentation edit is now REPAIRABLE rather than missing, so the
        // batch is no longer doomed and needs no intervention.
        assert.notEqual(d.kind, "partial");
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

describe("decideEdit reports an already-applied change", () => {
    // The loop this exists to break (run-mte9oayl-nlqlm): the model's newText was
    // already in the file, #115 correctly refused to repair the edit into a
    // no-op, and EXPLAIN then told it to "copy these bytes" -- advice for a
    // problem it did not have. It answered three times, twice with a
    // byte-identical oldText, because reproducing the whitespace is exactly what
    // it cannot do.
    const body = '\t\t\t\t" --style string    greeting style (a, b)"\n';

    it("says satisfied when the target region already holds newText", () => {
        const d = decideEdit(body, [
            {
                oldText: '\t\t\t\t" --style string greeting style (a, b)"',
                newText: '\t\t\t\t" --style string    greeting style (a, b)"',
            },
        ]);
        assert.equal(d.kind, "satisfied");
        if (d.kind === "satisfied") assert.equal(d.index, 0);
    });

    it("still explains when newText is a genuine, different change", () => {
        // Narrowness check: only an edit whose newText the file ALREADY holds is
        // reported satisfied. A real pending change must not be waved through.
        const d = decideEdit(body, [
            {
                oldText: '\t\t\t\t" --style string greeting style (a, b)"',
                newText: '\t\t\t\t" --style string    SOMETHING NEW"',
            },
        ]);
        assert.notEqual(d.kind, "satisfied");
    });

    it("tells the agent to verify, not to reproduce another string", () => {
        const r = satisfiedReason("main_test.go", 0);
        assert.match(r, /ALREADY APPLIED/);
        assert.match(r, /Do NOT retry/);
        assert.match(r, /invisible characters/);
        assert.match(r, /run this phase's tests/);
        // The failure mode was handing back bytes to copy. It must not do that.
        assert.ok(!r.includes("Copy that exactly"), "no copy-these-bytes advice");
    });
});

describe("classifyBatch / partial", () => {
    // The strongest signal in the run data, and the one I spent five PRs missing:
    // pi applies a multi-edit call as a UNIT, so failure climbs with batch size
    // (1 edit 36%, 2 edits 56%, 3 edits 64%, 4+ 67%) and the agent then re-derives
    // the WHOLE batch, including the edits that were already correct.
    const body = 'func a() { println("alpha") }\nfunc c() { println("gamma") }\n';

    it("names which edits are fine and which are not", () => {
        const d = decideEdit(body, [
            { oldText: 'println("alpha")', newText: 'println("ALPHA")' },
            { oldText: 'println("nope")', newText: 'println("X")' },
            { oldText: 'println("gamma")', newText: 'println("GAMMA")' },
        ]);
        assert.equal(d.kind, "partial");
        if (d.kind !== "partial") return;
        assert.deepEqual(
            d.outcomes.map((o) => o.state),
            ["applies", "missing", "applies"],
        );
        const r = partialReason("x.go", d.outcomes);
        assert.match(r, /edits\[0, 2\] — FINE/);
        assert.match(r, /edits\[1\] — NOT FOUND/);
        assert.match(r, /SEPARATE single-edit calls/);
        // The wording must describe what pi DID (failed the call), not what the
        // hook used to do (block it) -- the hook no longer blocks anything.
        assert.ok(!/was not run|was stopped/.test(r), "no stale blocking language");
    });

    it("leaves a batch alone when every edit will apply", () => {
        // Intervening on a batch that would have worked would be pure cost.
        const d = decideEdit(body, [
            { oldText: 'println("alpha")', newText: 'println("ALPHA")' },
            { oldText: 'println("gamma")', newText: 'println("GAMMA")' },
        ]);
        assert.notEqual(d.kind, "partial");
    });

    it("flags an already-applied edit inside a batch, so it is dropped not redone", () => {
        // The satisfied case needs a FLATTENED run: widening stretches a run the
        // model wrote, it cannot delete spaces the file does not have.
        const aligned = 'func a() { println("alpha") }\nvar x = 1;    var y = 2;\n';
        const d = decideEdit(aligned, [
            { oldText: 'println("alpha")', newText: 'println("ALPHA")' },
            // oldText's single space widens to the file's four, which equals
            // newText -> the change is already in the file.
            { oldText: "var x = 1; var y = 2;", newText: "var x = 1;    var y = 2;" },
        ]);
        assert.equal(d.kind, "partial");
        if (d.kind !== "partial") return;
        assert.ok(d.outcomes.some((o) => o.state === "satisfied"));
        assert.match(partialReason("x.go", d.outcomes), /ALREADY APPLIED/);
    });

    it("does not change what a single-edit call does", () => {
        // Every earlier path stays exactly as it was; there is no batch to salvage.
        assert.equal(
            decideEdit(body, [{ oldText: 'println("alpha")', newText: "x" }]).kind,
            "pass",
        );
        assert.equal(
            decideEdit(body, [{ oldText: 'println("nope")', newText: "x" }]).kind,
            "pass",
        );
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

describe("repairCarriedWhitespace restores padding on a line carried through", () => {
    // The real file from run-mtfx17xn-wpdrq. The edit ADDS a --style row and
    // matches oldText exactly; the damage is that newText re-types the two rows
    // beside it with their padding collapsed.
    const BODY = [
        'func printUsage(stdout io.Writer) {',
        '\tfmt.Fprintln(stdout, "Flags:")',
        '\tfmt.Fprintln(stdout, " -n, --name string name to greet")',
        '\tfmt.Fprintln(stdout, " --version         print the version and exit")',
        '\tfmt.Fprintln(stdout, " --help            show this help")',
        '}',
    ].join("\n");
    const OLD = [
        '\tfmt.Fprintln(stdout, " --version         print the version and exit")',
        '\tfmt.Fprintln(stdout, " --help            show this help")',
    ].join("\n");

    it("puts back the padding the model flattened while inserting a line", () => {
        const NEW = [
            '\tfmt.Fprintln(stdout, " --style string    greeting style")',
            '\tfmt.Fprintln(stdout, " --version print the version and exit")',
            '\tfmt.Fprintln(stdout, " --help show this help")',
        ].join("\n");
        const got = repairCarriedWhitespace(BODY, { oldText: OLD, newText: NEW });
        assert.ok(got);
        assert.match(got!, / --version {9}print the version and exit/);
        assert.match(got!, / --help {12}show this help/);
        // The inserted line is the model's own and must survive untouched.
        assert.match(got!, / --style string {4}greeting style/);
    });

    it("does nothing when the model reproduced the padding correctly", () => {
        const NEW = OLD.replace(
            '\t\tfmt',
            '\t\tfmt',
        );
        assert.equal(repairCarriedWhitespace(BODY, { oldText: OLD, newText: NEW }), null);
    });

    it("never reverts a run the model WIDENED", () => {
        // Widening is what deliberate re-alignment looks like: a longer entry
        // arrives and the column moves. Reverting it would fight the edit.
        const NEW = [
            '\tfmt.Fprintln(stdout, " --version             print the version and exit")',
            '\tfmt.Fprintln(stdout, " --help                show this help")',
        ].join("\n");
        assert.equal(repairCarriedWhitespace(BODY, { oldText: OLD, newText: NEW }), null);
    });

    it("never touches a run re-aligned to some OTHER width", () => {
        // Narrowing to a new column is a real edit; only the collapse to exactly
        // one space is the signature of a model that cannot see the run.
        const NEW = [
            '\tfmt.Fprintln(stdout, " --version   print the version and exit")',
            '\tfmt.Fprintln(stdout, " --help      show this help")',
        ].join("\n");
        assert.equal(repairCarriedWhitespace(BODY, { oldText: OLD, newText: NEW }), null);
    });

    it("leaves a line whose CONTENT changed alone", () => {
        const NEW = [
            '\tfmt.Fprintln(stdout, " --version print the build and exit")',
            '\tfmt.Fprintln(stdout, " --help            show this help")',
        ].join("\n");
        // Same collapsed key? No — the words differ, so it is not carried
        // through and this module has no business rewriting it.
        assert.equal(repairCarriedWhitespace(BODY, { oldText: OLD, newText: NEW }), null);
    });

    it("only fires on an edit that already matches the file", () => {
        // A non-matching edit is repairIndent's job, and that path rebuilds
        // newText itself. Doing both would be two repairs racing on one string.
        const stale = OLD.replace("--version", "--vers");
        const NEW = '\tfmt.Fprintln(stdout, " --version print the version and exit")';
        assert.equal(repairCarriedWhitespace(BODY, { oldText: stale, newText: NEW }), null);
    });

    it("refuses when the carried line is ambiguous in oldText", () => {
        const dupBody = 'a\nx    y\nx  y\nb';
        const dupOld = 'x    y\nx  y';
        assert.equal(
            repairCarriedWhitespace(dupBody, { oldText: dupOld, newText: 'x y\nx y' }),
            null,
        );
    });

    it("restores a flattened tab indent", () => {
        const body = 'func f() {\n\t\treturn 1\n}';
        const got = repairCarriedWhitespace(body, {
            oldText: '\t\treturn 1',
            newText: ' return 1',
        });
        assert.equal(got, '\t\treturn 1');
    });

    it("survives junk without throwing", () => {
        assert.equal(repairCarriedWhitespace("", { oldText: "a", newText: "a" }), null);
        assert.equal(repairCarriedWhitespace("a", {} as any), null);
        assert.equal(
            repairCarriedWhitespace("a", { oldText: "a", newText: "" }),
            null,
        );
    });
});

describe("the audit log says WHICH side was repaired", () => {
    // Without the label a newText repair reads as an oldText one, and the entry
    // makes no sense checked against the file — which is how the log gets read.
    it("labels a newText repair as such", () => {
        const body = [
            ' --version         print the version and exit',
            ' --help            show this help',
        ].join("\n");
        const d = decideEdit(body, [
            {
                oldText: body,
                newText: [
                    ' --style string    pick a style',
                    ' --version print the version and exit',
                    ' --help            show this help',
                ].join("\n"),
            },
        ]);
        assert.equal(d.kind, "repair");
        if (d.kind !== "repair") return;
        assert.equal(d.repairs[0].field, "newText");
        assert.match(formatRepair("m.go", d.repairs[0]), /edits\[0\]\.newText/);
    });

    it("keeps the default label for an ordinary oldText repair", () => {
        const d = decideEdit('a\nfoo    bar\nb', [
            { oldText: "foo bar", newText: "foo baz" },
        ]);
        assert.equal(d.kind, "repair");
        if (d.kind !== "repair") return;
        assert.equal(d.repairs[0].field, undefined);
        assert.match(formatRepair("m.go", d.repairs[0]), /edits\[0\]\.oldText/);
    });
});

describe("padding inside a string literal: layout vs data", () => {
    // Both shapes are a literal with runs inside it, indistinguishable line for
    // line. What separates them is whether the padding lines a column up across
    // siblings. Replaying the sink surfaced one of each.

    it("REPAIRS a help row, where the padding forms a column", () => {
        // From run-mtfx17xn-wpdrq: adding --style flattened the row beside it.
        const body = [
            '\tfmt.Fprintln(stdout, " --version         print the version and exit")',
            '\tfmt.Fprintln(stdout, " --help            show this help")',
        ].join("\n");
        const got = repairCarriedWhitespace(body, {
            oldText: body,
            newText: [
                '\tfmt.Fprintln(stdout, " --style string    greeting style")',
                '\tfmt.Fprintln(stdout, " --version print the version and exit")',
                '\tfmt.Fprintln(stdout, " --help            show this help")',
            ].join("\n"),
        });
        assert.ok(got, "the column is real; this is alignment");
        assert.match(got!, / --version {9}print/);
    });

    it("REFUSES a table-driven test's stdin field, where it is data", () => {
        // Real, from the sink. `" Ada "` and `"  Ada  "` are DIFFERENT inputs;
        // rewriting one to the other changes what the case asserts while every
        // gate stays green — the exact silent damage this module exists to stop.
        const body = [
            '\t\t\tstdin:           "  Ada  \\n",',
            '\t\t\twantStdout:      "Hello, Ada!\\n",',
        ].join("\n");
        const got = repairCarriedWhitespace(body, {
            oldText: body,
            newText: [
                '\t\t\tstdin:           " Ada \\n",',
                '\t\t\twantStdout:      "Hello, Ada!\\n",',
            ].join("\n"),
        });
        assert.equal(got, null);
    });

    it("still repairs indentation, which is never inside a literal", () => {
        assert.equal(
            repairCarriedWhitespace('\t_, err = pool.Exec(ctx,', {
                oldText: '\t_, err = pool.Exec(ctx,',
                newText: ' _, err = pool.Exec(ctx,',
            }),
            '\t_, err = pool.Exec(ctx,',
        );
    });
});

describe("the carried-whitespace repair reaches the hook's decision", () => {
    // It must arrive as a `repair`, not a `pass`, or the extension never applies
    // it and the audit never records it.
    const BODY = 'x\n --version         print\n --help            show\ny';
    const edits = [
        {
            oldText: ' --version         print\n --help            show',
            newText: ' --style    pick\n --version print\n --help show',
        },
    ];

    it("turns a matching-but-flattening edit into a repair", () => {
        const d = decideEdit(BODY, edits);
        assert.equal(d.kind, "repair");
        if (d.kind !== "repair") return;
        assert.equal(d.repairs.length, 1);
        assert.match(d.edits[0].newText, / --version {9}print/);
        assert.match(d.edits[0].newText, / --style {4}pick/);
    });

    it("classifies the edit as applying, since it does", () => {
        // The repair changes what gets written, not whether the call lands.
        assert.deepEqual(classifyBatch(BODY, edits)[0], { index: 0, state: "applies" });
    });
});
