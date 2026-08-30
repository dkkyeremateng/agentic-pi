import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    auditDiff,
    diffAuditBlock,
    isTestFile,
    markRuns,
    runDelta,
} from "./diff-audit";

// The diff that shipped the regression this module exists for
// (run-mteaylzh-wlcwt): a `--style` row inserted correctly, the two rows beside
// it silently de-aligned, and the test expectation rewritten to agree with the
// broken output. Note the UNEQUAL - and + counts -- two removals, three
// additions. The first version of this module paired lines positionally and
// required equal counts, so it found nothing here.
const REAL = `diff --git a/cmd/greet/main.go b/cmd/greet/main.go
--- a/cmd/greet/main.go
+++ b/cmd/greet/main.go
@@ -85,7 +103,8 @@ func printUsage(stdout io.Writer) {
 	fmt.Fprintln(stdout, " -n, --name string name to greet")
-	fmt.Fprintln(stdout, " --version         print the version and exit")
-	fmt.Fprintln(stdout, " --help            show this help")
+	fmt.Fprintln(stdout, " --style string    greeting style (hello, farewell)")
+	fmt.Fprintln(stdout, " --version print the version and exit")
+	fmt.Fprintln(stdout, " --help show this help")
 }
diff --git a/cmd/greet/main_test.go b/cmd/greet/main_test.go
--- a/cmd/greet/main_test.go
+++ b/cmd/greet/main_test.go
@@ -228,7 +231,8 @@ func TestRun(t *testing.T) {
 			want: "Usage: greet [flags]\\n" +
-				" --version         print the version and exit\\n" +
-				" --help            show this help\\n",
+				" --style string    greeting style (hello, farewell)\\n" +
+				" --version print the version and exit\\n" +
+				" --help show this help\\n",
 		},
`;

describe("auditDiff on the diff that actually shipped", () => {
    const found = auditDiff(REAL);

    it("catches the de-aligned source lines", () => {
        const ws = found.filter((f) => f.kind === "whitespace-only-change");
        assert.equal(ws.length, 2, JSON.stringify(found, null, 1));
        assert.ok(ws.every((f) => f.file === "cmd/greet/main.go"));
        assert.match(ws[0].detail, /--version/);
    });

    it("catches the rewritten test expectations", () => {
        const re = found.filter((f) => f.kind === "assertion-rewritten");
        assert.equal(re.length, 2);
        assert.ok(re.every((f) => f.file === "cmd/greet/main_test.go"));
    });

    it("survives the unequal -/+ counts that defeated the first version", () => {
        // Two removals, three additions, in both files.
        assert.equal(found.length, 4);
    });
});

describe("auditDiff stays quiet on ordinary work", () => {
    it("says nothing about a pure insertion", () => {
        const d = `--- a/x.go\n+++ b/x.go\n@@\n context\n+	newLine()\n context\n`;
        assert.deepEqual(auditDiff(d), []);
    });

    it("says nothing about a real code change", () => {
        // Different text, not merely different spacing: ordinary editing.
        const d = `--- a/x.go\n+++ b/x.go\n@@\n-	return oldThing()\n+	return newThing()\n`;
        assert.deepEqual(auditDiff(d), []);
    });

    it("says nothing about a test that gained a case", () => {
        const d = `--- a/x_test.go\n+++ b/x_test.go\n@@\n+	{name: "brand new case", want: "x"},\n`;
        assert.deepEqual(auditDiff(d), []);
    });

    it("says nothing about an empty or malformed diff", () => {
        assert.deepEqual(auditDiff(""), []);
        assert.deepEqual(auditDiff("not a diff at all"), []);
    });
});

describe("isTestFile", () => {
    it("recognises the common conventions", () => {
        for (const p of [
            "cmd/greet/main_test.go",
            "src/foo.test.ts",
            "src/foo.spec.js",
            "tests/test_thing.py",
            "app/__tests__/x.tsx",
        ])
            assert.equal(isTestFile(p), true, p);
    });

    it("does not mistake source for tests", () => {
        for (const p of ["cmd/greet/main.go", "src/latest.ts", "protest/x.go"])
            assert.equal(isTestFile(p), false, p);
    });
});

describe("diffAuditBlock", () => {
    it("asks the reviewer a question rather than issuing a verdict", () => {
        // The audit cannot tell an intended behaviour change from a covered-up
        // regression. Stating a verdict it cannot support would teach the
        // reviewer to wave the block through.
        const block = diffAuditBlock(auditDiff(REAL));
        assert.match(block, /answer these explicitly/i);
        assert.match(block, /REWRITTEN, not added/);
        assert.match(block, /changed ONLY in whitespace width/);
        assert.match(block, /cmd\/greet\/main\.go/);
        assert.ok(!/\bVERDICT\b|\bFAIL\b/.test(block), "no verdict of its own");
    });

    it("is empty when there is nothing to report, so a clean run reads clean", () => {
        assert.equal(diffAuditBlock([]), "");
    });
});

describe("whitespace differences are rendered as counts, not as whitespace", () => {
    // The regression this closes. On run-mtgevo3w-j2mrj the audit found the
    // flattened --version/--help rows and reported them correctly, and BOTH gates
    // still passed the diff:
    //
    //   reviewer:  "their text and leading alignment were preserved"
    //   validator: "the existing --version expectation remains exactly ..."
    //
    // They were answering the finding, not skipping it. They just could not see
    // the difference, because the difference is a run of spaces — the one
    // comparison a model cannot make, and the reason this module exists at all.

    it("renders a run of two or more as a count", () => {
        assert.equal(markRuns(" --version         print"), " --version[9sp]print");
        assert.equal(markRuns("\t\tfoo"), "[2tab]foo");
        // " \t x" is space, tab, space -> one run of 2 spaces and a tab.
        assert.equal(markRuns(" \t x"), "[2sp+1tab]x");
    });

    it("leaves single spaces alone, so the marked run stands out", () => {
        // Marking every space turned the line into "[1sp]" noise and buried the
        // one run that mattered.
        assert.equal(markRuns("a b c"), "a b c");
        assert.equal(markRuns("a b  c"), "a b[2sp]c");
    });

    it("states the width change and which token it precedes", () => {
        assert.equal(
            runDelta(" --version         print the version", " --version print the version"),
            '9 -> 1 before "print"',
        );
        assert.equal(runDelta("a  b", "a  b"), "", "nothing changed");
        assert.equal(runDelta("a b", "totally different"), "", "not a run difference");
    });

    it("puts both into the finding, so the claim is checkable", () => {
        const diff = [
            "+++ b/cmd/greet/main.go",
            '-\tfmt.Fprintln(stdout, " --version         print the version and exit")',
            '+\tfmt.Fprintln(stdout, " --version print the version and exit")',
        ].join("\n");
        const [f] = auditDiff(diff);
        assert.equal(f.kind, "whitespace-only-change");
        assert.match(f.detail, /\[9sp\]/);
        assert.match(f.detail, /run width 9 -> 1 before "print"/);
    });

    it("tells the reader a narrowing is accidental by default", () => {
        // "Confirm each was intended" was too weak: two gates confirmed it was.
        const diff = [
            "+++ b/x.go",
            '-a  b',
            '+a b',
        ].join("\n");
        const block = diffAuditBlock(auditDiff(diff));
        assert.match(block, /Treat a narrowing as ACCIDENTAL/);
        assert.match(block, /concluded the alignment was "preserved"/);
    });
});
