import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    detectVerdict,
    detectCritique,
    detectShip,
    digest,
    testSignal,
    outcomeLine,
    isModelFailure,
    isTransientError,
    isTrivialPing,
    gitPreflightNote,
} from "./workflow-utils";

// Run with: npx tsx --test workflow-utils.test.ts

describe("detectVerdict", () => {
    it("detects PASS from the explicit marker", () => {
        assert.equal(detectVerdict("VERDICT: PASS"), "pass");
    });

    it("detects FAIL from the explicit marker", () => {
        assert.equal(detectVerdict("VERDICT: FAIL"), "fail");
    });

    it("detects PAUSED from the explicit marker", () => {
        assert.equal(detectVerdict("VERDICT: PAUSED"), "paused");
    });

    it("is case-insensitive for the marker", () => {
        assert.equal(detectVerdict("verdict: pass"), "pass");
        assert.equal(detectVerdict("Verdict: Fail"), "fail");
        assert.equal(detectVerdict("VERDICT: paused"), "paused");
    });

    it("finds the marker anywhere in the output", () => {
        assert.equal(
            detectVerdict(
                "some preamble\nmore text\nVERDICT: PASS\nextra detail",
            ),
            "pass",
        );
    });

    it("prefers the marker over a fallback match", () => {
        assert.equal(
            detectVerdict(
                "This approach might fail to address the issue\nVERDICT: PASS",
            ),
            "pass",
        );
    });

    it("restricts fallback to the first 20 lines — ignores keywords beyond", () => {
        const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
        lines[24] = "fail";
        assert.equal(detectVerdict(lines.join("\n")), "unknown");
    });

    it("matches fallback pass within the first 20 lines", () => {
        const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
        lines[5] = "pass";
        assert.equal(detectVerdict(lines.join("\n")), "pass");
    });

    it("matches fallback fail within the first 20 lines", () => {
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
        lines[3] = "this will fail";
        assert.equal(detectVerdict(lines.join("\n")), "fail");
    });

    it("returns unknown when no signal at all", () => {
        assert.equal(
            detectVerdict("just some random text with no keywords"),
            "unknown",
        );
    });

    it("returns unknown for empty output", () => {
        assert.equal(detectVerdict(""), "unknown");
    });

    it("ignores reasoning text when the marker is still found", () => {
        const output = [
            "Looking at the test results, this approach might fail to address",
            "the edge case. However, the implementation is actually correct.",
            "VERDICT: PASS",
        ].join("\n");
        assert.equal(detectVerdict(output), "pass");
    });

    it("takes the LAST marker — a deliberation verdict doesn't override the final one", () => {
        const output = [
            "If the tests didn't pass I would emit VERDICT: FAIL here.",
            "But they all pass, so the final call is:",
            "VERDICT: PASS",
        ].join("\n");
        assert.equal(detectVerdict(output), "pass");
    });

    it("detects paused from fallback", () => {
        assert.equal(
            detectVerdict("The workflow is paused due to missing config"),
            "paused",
        );
    });

    it("ignores paused keyword beyond line 20", () => {
        const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
        lines[22] = "paused";
        assert.equal(detectVerdict(lines.join("\n")), "unknown");
    });

    it("pass on the exact 20th line still matches", () => {
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
        lines[19] = "pass";
        assert.equal(detectVerdict(lines.join("\n")), "pass");
    });

    it("pass on the 21st line does not match", () => {
        const lines = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`);
        lines[20] = "pass";
        assert.equal(detectVerdict(lines.join("\n")), "unknown");
    });
});

describe("detectShip", () => {
    it("detects SHIPPED from the explicit marker", () => {
        assert.equal(detectShip("SHIP: SHIPPED"), "shipped");
    });

    it("detects PAUSED from the explicit marker", () => {
        assert.equal(detectShip("SHIP: PAUSED"), "paused");
    });

    it("is case-insensitive", () => {
        assert.equal(detectShip("ship: shipped"), "shipped");
        assert.equal(detectShip("Ship: Paused"), "paused");
    });

    it("detects paused from 'no remote' fallback in first 20 lines", () => {
        assert.equal(
            detectShip("There is no GitHub remote configured"),
            "paused",
        );
    });

    it("detects paused from 'paused' keyword in first 20 lines", () => {
        assert.equal(detectShip("Work paused — no remote found"), "paused");
    });

    it("defaults to shipped when no signal", () => {
        assert.equal(detectShip("PR created successfully"), "shipped");
    });

    it("ignores 'paused' keyword beyond line 20", () => {
        const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
        lines[22] = "paused";
        assert.equal(detectShip(lines.join("\n")), "shipped");
    });

    it("ignores 'no remote' beyond line 20", () => {
        const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
        lines[21] = "no GitHub remote";
        assert.equal(detectShip(lines.join("\n")), "shipped");
    });

    it("takes the LAST marker (the final outcome wins over an earlier mention)", () => {
        const output = ["SHIP: PAUSED would mean no remote.", "SHIP: SHIPPED"].join("\n");
        assert.equal(detectShip(output), "shipped");
    });
});

describe("detectCritique", () => {
    it("detects each explicit marker", () => {
        assert.equal(detectCritique("REVISE BEFORE MERGE"), "revise");
        assert.equal(detectCritique("REVISE BEFORE IMPLEMENTING"), "revise");
        assert.equal(detectCritique("APPROVED WITH RESERVATIONS"), "approved-with-reservations");
        assert.equal(detectCritique("APPROVED"), "approved");
    });

    it("does not mistake 'APPROVED WITH RESERVATIONS' for a bare approval", () => {
        assert.equal(detectCritique("Verdict: APPROVED WITH RESERVATIONS — see notes"), "approved-with-reservations");
    });

    it("takes the LAST marker — a deliberation verdict doesn't override the final one", () => {
        const output = [
            "My first instinct was APPROVED, but on a closer look at the migration:",
            "REVISE BEFORE MERGE",
        ].join("\n");
        assert.equal(detectCritique(output), "revise");
    });

    it("returns unknown when neither a marker nor a standalone verdict line is present", () => {
        assert.equal(detectCritique("the code looks fine to me overall"), "unknown");
    });

    it("does not read the word 'approved' buried in prose as an approval", () => {
        // The bare-substring match used to make every one of these an approval,
        // defeating the review gate.
        assert.notEqual(detectCritique("this is not approved"), "approved");
        assert.notEqual(detectCritique("this remains unapproved"), "approved");
        assert.notEqual(detectCritique("this cannot be approved as written"), "approved");
        assert.equal(detectCritique("this remains unapproved"), "unknown");
    });

    it("keeps an explicit REVISE verdict when later prose mentions approval", () => {
        // "last marker wins" + a substring match let trailing prose reopen the gate.
        const output = [
            "## Verdict",
            "REVISE BEFORE MERGE",
            "",
            "The migration drops a column without a backfill.",
            "Once that is fixed it can be approved later.",
        ].join("\n");
        assert.equal(detectCritique(output), "revise");
    });

    it("still accepts a decorated or labelled verdict line", () => {
        assert.equal(detectCritique("## Verdict\n**APPROVED**\n\nLooks good."), "approved");
        assert.equal(detectCritique("Verdict: APPROVED — nice work"), "approved");
        assert.equal(
            detectCritique("**APPROVED WITH RESERVATIONS**\n\nMinor notes below."),
            "approved-with-reservations",
        );
    });

    it("finds a verdict past the 20-line fallback window (marker scan is whole-output)", () => {
        const output = ["## Review", ...Array(30).fill("some finding"), "APPROVED"].join("\n");
        assert.equal(detectCritique(output), "approved");
    });
});

describe("digest", () => {
    it("extracts the first substantive paragraph", () => {
        assert.equal(
            digest("Hello world\nSecond line"),
            "Hello world Second line",
        );
    });

    it("skips leading blank lines", () => {
        assert.equal(digest("\n\nActual content"), "Actual content");
    });

    it("skips markdown headings at the start", () => {
        assert.equal(digest("# Heading\nReal text"), "Real text");
    });

    it("skips horizontal rules at the start", () => {
        assert.equal(digest("---\n---\nActual content"), "Actual content");
    });

    it("stops at the first blank line after content starts", () => {
        assert.equal(
            digest("First paragraph\n\nSecond paragraph"),
            "First paragraph",
        );
    });

    it("truncates to maxLen with ellipsis", () => {
        const long = "a".repeat(300);
        const result = digest(long, 50);
        assert.equal(result.length, 50);
        assert.ok(result.endsWith("…"));
    });

    it("returns '[no output]' for empty input", () => {
        assert.equal(digest(""), "[no output]");
    });

    it("collapses multiple whitespace into single spaces", () => {
        assert.equal(digest("hello   world"), "hello world");
    });
});

describe("testSignal", () => {
    it("extracts passed count", () => {
        assert.equal(
            testSignal("12 tests passed, 0 failed"),
            " (12 passed, 0 failed)",
        );
    });

    it("extracts failed count only", () => {
        assert.equal(testSignal("2 failures"), " (2 failed)");
    });

    it("extracts passed count only", () => {
        assert.equal(testSignal("5 tests passing"), " (5 passed)");
    });

    it("returns empty string when no counts found", () => {
        assert.equal(testSignal("all good"), "");
    });
});

describe("outcomeLine", () => {
    it("returns shipped message", () => {
        assert.ok(outcomeLine("shipped", 1).includes("SHIPPED"));
    });

    it("returns paused message", () => {
        assert.ok(outcomeLine("paused-no-remote", 1).includes("PAUSED"));
    });

    it("returns failed message with attempt count", () => {
        assert.ok(
            outcomeLine("failed-after-retries", 3).includes("3 attempt(s)"),
        );
    });

    it("returns needs-review message", () => {
        assert.ok(outcomeLine("needs-review", 1).includes("NEEDS REVIEW"));
    });

    it("uppercases unknown statuses", () => {
        assert.equal(outcomeLine("mystery", 1), "MYSTERY");
    });
});

describe("isModelFailure", () => {
    it("detects 'Model not found' error", () => {
        assert.equal(
            isModelFailure('Error: Model "gpt-5-turbo" not found'),
            true,
        );
    });

    it("detects 'unknown model' error", () => {
        assert.equal(isModelFailure("unknown model: claude-opus-99"), true);
    });

    it("detects 'provider is not supported' error", () => {
        assert.equal(
            isModelFailure('provider "openai" is not supported'),
            true,
        );
    });

    it("detects 'failed to load model' error", () => {
        assert.equal(isModelFailure("failed to load model xyz"), true);
    });

    it("detects 'api key invalid for model' error", () => {
        assert.equal(isModelFailure("api key invalid for model abc"), true);
    });

    it("detects '--list-models' suggestion", () => {
        assert.equal(
            isModelFailure(
                "Try running with --list-models to see available models",
            ),
            true,
        );
    });

    it("returns false for tool errors", () => {
        assert.equal(
            isModelFailure("Tool read_file failed: permission denied"),
            false,
        );
    });

    it("returns false for timeout errors", () => {
        assert.equal(
            isModelFailure(
                "[timed out after 5m — killed by PI_WORKFLOW_AGENT_TIMEOUT]",
            ),
            false,
        );
    });

    it("returns false for empty output", () => {
        assert.equal(isModelFailure(""), false);
    });

    it("returns false for agent reasoning mentioning 'model'", () => {
        assert.equal(
            isModelFailure("The model suggested using a different approach"),
            false,
        );
    });

    it("returns false for normal passing output", () => {
        assert.equal(isModelFailure("All tests passed successfully"), false);
    });

    it("returns false for normal output about acceptance criteria", () => {
        assert.equal(
            isModelFailure(
                "This implementation does not pass the acceptance criteria",
            ),
            false,
        );
    });

    it("does NOT treat 502 as a model failure (it is transient)", () => {
        // 502 Bad Gateway is a transient upstream hiccup, not a bad model — it must
        // fall to the same-model retry path, not the fallback-to-another-model path.
        assert.equal(isModelFailure("[agent error] 502 Request failed"), false);
        assert.equal(
            isModelFailure("[agent error] 502 Request rejected by upstream model."),
            false,
        );
        assert.equal(isModelFailure("Request failed with status 502"), false);
    });

    it("detects 404 request failed error", () => {
        assert.equal(
            isModelFailure("[agent error] 404 Request failed (not found)"),
            true,
        );
    });

    it("detects 400 bad request error", () => {
        assert.equal(
            isModelFailure("[agent error] 400 Bad request - invalid model"),
            true,
        );
    });

    it("returns false for domain prose about a data model", () => {
        // The proximity heuristics must not misroute a LOGICAL failure (bad output)
        // into a fallback-model retry just because "model" sits near "invalid".
        assert.equal(isModelFailure("The data model is invalid: orders has no customer id."), false);
        assert.equal(isModelFailure("The pricing model does not exist in the schema yet."), false);
    });

    it("still detects a model error stated on an error line", () => {
        assert.equal(
            isModelFailure("[agent error] the requested model is unavailable right now"),
            true,
        );
    });
});

describe("isTransientError", () => {
    it("detects the reported 'Stream ended without finish_reason'", () => {
        assert.equal(
            isTransientError("[agent error] Stream ended without finish_reason"),
            true,
        );
    });

    it("detects dropped connections and socket errors", () => {
        assert.equal(isTransientError("read ECONNRESET"), true);
        assert.equal(isTransientError("socket hang up"), true);
        assert.equal(isTransientError("fetch failed"), true);
        assert.equal(isTransientError("premature close"), true);
    });

    it("detects temporary server / rate-limit / gateway responses", () => {
        assert.equal(isTransientError("[agent error] 429 Too Many Requests"), true);
        assert.equal(isTransientError("503 Service Unavailable"), true);
        assert.equal(isTransientError("Overloaded, please try again later"), true);
        // 502 Bad Gateway is the case that broke the todo_app_full run.
        assert.equal(
            isTransientError("[agent error] 502 Request rejected by upstream model."),
            true,
        );
        assert.equal(isTransientError("Request failed with status 502"), true);
    });

    it("does NOT treat our watchdog timeout as transient", () => {
        assert.equal(
            isTransientError(
                "[timed out after 5m — killed by PI_WORKFLOW_AGENT_TIMEOUT]",
            ),
            false,
        );
    });

    it("does NOT treat model-config or logical failures as transient", () => {
        assert.equal(isTransientError('Error: Model "x" not found'), false);
        assert.equal(isTransientError("Tool read failed: permission denied"), false);
        assert.equal(isTransientError("All tests passed"), false);
        assert.equal(isTransientError(""), false);
    });
});

describe("isTrivialPing", () => {
    for (const s of [
        "ping",
        "Ping",
        "ping!",
        "ping all agents",
        "ping agents",
        "ping everyone",
        "ping all",
        "hi",
        "hello",
        "hey",
        "test",
        "status",
        "health check",
        "healthcheck",
        "you there?",
        "are you up",
        "are you alive",
    ]) {
        it(`treats ${JSON.stringify(s)} as a ping`, () => {
            assert.equal(isTrivialPing(s), true);
        });
    }

    for (const s of [
        "ping the database for latency",
        "implement a ping endpoint",
        "review WAL-2977 and generate queries",
        "test the checkout flow end to end",
        "",
        "   ",
    ]) {
        it(`treats ${JSON.stringify(s)} as real work`, () => {
            assert.equal(isTrivialPing(s), false);
        });
    }
});

describe("gitPreflightNote", () => {
    it("says nothing when the cwd is a git repo", () => {
        assert.equal(gitPreflightNote(true, true), "");
        assert.equal(gitPreflightNote(true, false), "");
    });

    it("names the build-specific losses for a roster that implements", () => {
        const note = gitPreflightNote(false, true);
        assert.match(note, /Not a git repository/);
        assert.match(note, /per-phase commits/);
        assert.match(note, /open a PR/);
        assert.match(note, /git init/);
    });

    it("omits commit\/PR losses for a plan-only roster", () => {
        const note = gitPreflightNote(false, false);
        assert.match(note, /Not a git repository/);
        assert.match(note, /revert has no checkpoint/);
        assert.doesNotMatch(note, /open a PR/);
        assert.doesNotMatch(note, /per-phase commits/);
    });
});
