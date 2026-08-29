// ABOUTME: Flags the diff shapes a passing test suite cannot catch, so the
// reviewer and validator are made to account for them explicitly.
//
// Why this is code and not more prompt guidance. On run-mteaylzh-wlcwt the
// implementer added a `--style` help row correctly, then collapsed the padding on
// the two rows beside it -- undoing commit 7d919c9, whose subject is literally
// "greet --help output is misaligned since the -n shorthand was added". When
// `TestRun/help_flag` failed, it edited the EXPECTATION to match its own broken
// output:
//
//     -  " --version         print the version and exit\n" +
//     +  " --version print the version and exit\n" +
//
// After that the suite was green, so the reviewer, validator, documenter and
// shipper all passed it and the regression shipped. No amount of "check for
// regressions" in a prompt helps here: by the time those agents look, the
// evidence agrees with the code. The signal only exists in the DIFF, and it is
// mechanical -- an existing assertion was rewritten rather than a new one added.
//
// So this does not judge. It points, and the pointing is attached to the
// reviewer's and validator's tasks where it cannot be skipped silently.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiffFinding {
    file: string;
    kind: "assertion-rewritten" | "whitespace-only-change";
    detail: string;
}

const TEST_FILE =
    /(^|\/)(test_[^/]+|[^/]+[._](test|spec)\.[a-z]+|[^/]+_test\.[a-z]+)$/i;

/** True for a path that holds tests, by the naming conventions in common use. */
export function isTestFile(path: string): boolean {
    return TEST_FILE.test(path) || /(^|\/)(tests?|spec|__tests__)\//i.test(path);
}

// A line that is mostly a string literal — the shape an expectation takes. Used
// to separate "the expected output changed" from ordinary code edits in a test
// file, which are none of this module's business.
const looksLikeLiteral = (s: string): boolean => {
    const body = s.replace(/^[+-]/, "").trim();
    return /["'`]/.test(body) && body.replace(/[^"'`]/g, "").length >= 2;
};

const collapseRuns = (s: string): string => s.replace(/[ \t]+/g, " ");

/**
 * Findings from a unified diff. Two shapes, both invisible to a green suite:
 *
 * - **assertion-rewritten** — a test file where an existing string literal was
 *   REPLACED, not added. Legitimate when behaviour intentionally changed, which
 *   is exactly why this reports rather than blocks: the reviewer has the plan and
 *   can say whether the new expectation was the point or a way around a failure.
 * - **whitespace-only-change** — a line whose only difference is the width of its
 *   whitespace runs. Nearly always accidental, because models flatten runs they
 *   cannot see; it is how the alignment above was lost, and a formatter-clean,
 *   test-green diff hides it completely.
 */
export function auditDiff(diff: string): DiffFinding[] {
    const out: DiffFinding[] = [];
    if (!diff) return out;
    let file = "";
    let removed: string[] = [];
    let added: string[] = [];

    const flush = () => {
        if (!file || !removed.length || !added.length) {
            removed = [];
            added = [];
            return;
        }
        // Match a removed line to an added one by their WHITESPACE-COLLAPSED
        // form, rather than by position. Positional pairing needs equal - and +
        // counts, and the regression this module exists for did not have them:
        // two rows were rewritten while a third was inserted beside them, so a
        // count-based matcher saw an ordinary insertion and reported nothing.
        // (Confirmed by running the first version of this file against the real
        // diff from run-mteaylzh-wlcwt: zero findings.)
        const takenAdded = new Set<number>();
        for (const rem of removed) {
            const a = rem.slice(1);
            const key = collapseRuns(a);
            const j = added.findIndex(
                (add, idx) =>
                    !takenAdded.has(idx) &&
                    add.slice(1) !== a &&
                    collapseRuns(add.slice(1)) === key,
            );
            if (j === -1) continue;
            takenAdded.add(j);
            const b = added[j].slice(1);
            // Same text, different whitespace widths. In a test file's string
            // literal that is an expectation rewritten to agree with flattened
            // output; anywhere else it is alignment silently lost.
            out.push({
                file,
                kind:
                    isTestFile(file) && looksLikeLiteral(rem)
                        ? "assertion-rewritten"
                        : "whitespace-only-change",
                detail: `${a.trim().slice(0, 60)}  ->  ${b.trim().slice(0, 60)}`,
            });
        }
        removed = [];
        added = [];
    };

    for (const raw of diff.split(/\r?\n/)) {
        if (raw.startsWith("+++ ")) {
            flush();
            file = raw.slice(4).replace(/^b\//, "").trim();
            continue;
        }
        if (raw.startsWith("--- ") || raw.startsWith("diff --git")) {
            flush();
            continue;
        }
        if (raw.startsWith("@@")) {
            flush();
            continue;
        }
        if (raw.startsWith("-")) removed.push(raw);
        else if (raw.startsWith("+")) added.push(raw);
        else flush(); // a context line ends the run of changes
    }
    flush();
    return out;
}

/**
 * The block appended to the reviewer's and validator's task, or "" when the diff
 * is clean. Phrased as questions they must answer, not as a verdict: the audit
 * cannot tell an intended behaviour change from a covered-up regression, and
 * pretending otherwise would train them to wave it through.
 */
export function diffAuditBlock(findings: DiffFinding[]): string {
    if (!findings.length) return "";
    const byKind = (k: DiffFinding["kind"]) => findings.filter((f) => f.kind === k);
    const lines: string[] = [
        "",
        "## Diff audit — answer these explicitly, they are invisible to a green suite",
        "",
    ];
    const rewritten = byKind("assertion-rewritten");
    if (rewritten.length) {
        lines.push(
            `**${rewritten.length} existing test expectation(s) were REWRITTEN, not added.** For each one, say whether the new expectation is what the plan asked for, or whether the test was changed to match output that regressed. A suite that passes because its expectations were edited to agree with the code proves nothing.`,
        );
        for (const f of rewritten.slice(0, 8))
            lines.push(`- \`${f.file}\`: ${f.detail}`);
        lines.push("");
    }
    const ws = byKind("whitespace-only-change");
    if (ws.length) {
        lines.push(
            `**${ws.length} line(s) changed ONLY in whitespace width.** Confirm each was intended. Models flatten runs of spaces they cannot see, so this is how column alignment gets silently undone — and gofmt, prettier and a green suite will all still be happy.`,
        );
        for (const f of ws.slice(0, 8)) lines.push(`- \`${f.file}\`: ${f.detail}`);
        lines.push("");
    }
    return lines.join("\n");
}

/**
 * The audit block for this run's changes, or "" when there is nothing to say.
 *
 * The run's diff is everything since the `Base:` sha the orchestrator recorded in
 * `.agent/progress.md` -- the same anchor the shipper squashes to. `git diff
 * <base>` compares that commit to the WORKING TREE, so it covers the
 * implementer's per-phase commits and any uncommitted edits alike.
 *
 * Best-effort throughout: no ledger, no base, no git, or a diff too large to be
 * worth scanning all return "" rather than failing a run. This is an extra pair
 * of eyes, never a gate of its own.
 */
export function runDiffAudit(cwd: string, maxBytes = 2_000_000): string {
    let base = "";
    try {
        const ledger = readFileSync(join(cwd, ".agent", "progress.md"), "utf8");
        base = (/^Base:\s*([0-9a-f]{7,40})\s*$/m.exec(ledger) || [])[1] || "";
    } catch {
        return "";
    }
    if (!base) return "";
    let diff = "";
    try {
        diff = execFileSync("git", ["diff", base, "--"], {
            cwd,
            encoding: "utf8",
            maxBuffer: maxBytes,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return "";
    }
    return diffAuditBlock(auditDiff(diff));
}
