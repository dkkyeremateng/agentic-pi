import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ancestorsWithin,
    capDiff,
    extOf,
    findUp,
    firstLine,
    GO_EXTS,
    JS_EXTS,
    PY_EXTS,
    resolveTool,
    stripAnsi,
    toLines,
    unique,
} from "./qa-tools";

describe("extOf", () => {
    it("returns the lowercased extension with its dot", () => {
        assert.equal(extOf("src/App.TSX"), ".tsx");
        assert.equal(extOf("main.go"), ".go");
        assert.equal(extOf("a/b.c/d.py"), ".py");
    });

    it("returns empty for a name with no dot", () => {
        assert.equal(extOf("Makefile"), "");
        assert.equal(extOf("bin/tool"), "");
    });

    it("classifies the languages the extension dispatches on", () => {
        assert.ok(JS_EXTS.has(extOf("x.mjs")));
        assert.ok(GO_EXTS.has(extOf("x.go")));
        assert.ok(PY_EXTS.has(extOf("x.pyi")));
        assert.ok(!JS_EXTS.has(extOf("README.md")));
    });
});

describe("unique", () => {
    it("drops duplicates and keeps first-seen order", () => {
        assert.deepEqual(unique(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
        assert.deepEqual(unique([]), []);
    });
});

describe("toLines / firstLine", () => {
    it("trims, drops blanks, and handles CRLF", () => {
        assert.deepEqual(toLines("  a  \r\n\r\n b \n"), ["a", "b"]);
    });

    it("treats null and undefined as empty rather than stringifying them", () => {
        assert.deepEqual(toLines(undefined), []);
        assert.deepEqual(toLines(null), []);
        assert.equal(firstLine(undefined), "");
    });

    it("firstLine skips leading blank lines", () => {
        assert.equal(firstLine("\n\n  real error  \nmore"), "real error");
    });
});

describe("stripAnsi", () => {
    it("removes SGR colour codes", () => {
        assert.equal(stripAnsi("\x1b[31merror\x1b[0m: bad"), "error: bad");
        assert.equal(stripAnsi("\x1b[1;33mwarn\x1b[0m"), "warn");
    });

    it("leaves bracketed text that is not an escape sequence alone", () => {
        // No ESC byte, so this is ordinary output (e.g. a log prefix) and must survive.
        assert.equal(stripAnsi("[0m] steps done"), "[0m] steps done");
        assert.equal(stripAnsi("array[0]"), "array[0]");
    });
});

describe("ancestorsWithin", () => {
    it("walks from the start dir up to and including the repo root", () => {
        assert.deepEqual(ancestorsWithin("/r/a/b", "/r"), ["/r/a/b", "/r/a", "/r"]);
        assert.deepEqual(ancestorsWithin("/r", "/r"), ["/r"]);
    });

    it("stops at the filesystem root when startDir is not under repoPath", () => {
        // Bounded rather than looping forever -- the pair can be mismatched when a
        // changed file lives outside the repo git reported.
        const dirs = ancestorsWithin("/other/x", "/r");
        assert.deepEqual(dirs, ["/other/x", "/other", "/"]);
    });
});

describe("findUp", () => {
    it("returns the NEAREST matching ancestor", () => {
        const hits = new Set(["/r", "/r/a"]);
        assert.equal(findUp("/r/a/b", "/r", (d) => hits.has(d)), "/r/a");
    });

    it("returns undefined when nothing matches", () => {
        assert.equal(findUp("/r/a/b", "/r", () => false), undefined);
    });
});

describe("resolveTool", () => {
    const candidates = ["node_modules/.bin/eslint", ".venv/bin/eslint"];

    it("prefers the nearest project-local install", () => {
        const present = new Set([
            "/r/node_modules/.bin/eslint",
            "/r/pkg/node_modules/.bin/eslint",
        ]);
        assert.equal(
            resolveTool("/r/pkg/src", "/r", candidates, "eslint", (p) => present.has(p)),
            "/r/pkg/node_modules/.bin/eslint",
        );
    });

    it("prefers the first listed candidate within a directory", () => {
        const present = new Set(["/r/node_modules/.bin/eslint", "/r/.venv/bin/eslint"]);
        assert.equal(
            resolveTool("/r", "/r", candidates, "eslint", (p) => present.has(p)),
            "/r/node_modules/.bin/eslint",
        );
    });

    it("falls back to the bare name for PATH resolution", () => {
        assert.equal(resolveTool("/r/a", "/r", candidates, "eslint", () => false), "eslint");
    });
});

describe("capDiff", () => {
    it("passes a short diff through untouched", () => {
        assert.equal(capDiff("a\nb\n", 100), "a\nb\n");
    });

    it("coerces null to an empty string", () => {
        assert.equal(capDiff(null, 100), "");
    });

    it("truncates on a line boundary and reports the omitted count", () => {
        const diff = "line one\nline two\nline three\n";
        const out = capDiff(diff, 12); // lands mid "line two"
        assert.ok(out.startsWith("line one\n"), out);
        assert.ok(!out.includes("line three"), out);
        assert.match(out, /diff truncated — \d+ more chars omitted/);
        // The count must describe what was actually dropped, not the raw cut point.
        const omitted = Number(/— (\d+) more/.exec(out)![1]);
        assert.equal(omitted, diff.length - "line one".length);
    });

    it("still truncates when the cap falls inside the very first line", () => {
        const out = capDiff("a-very-long-single-line-with-no-newline", 10);
        assert.ok(out.startsWith("a-very-lon"), out);
        assert.match(out, /diff truncated/);
    });
});
