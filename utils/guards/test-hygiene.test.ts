import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A guard against one specific, twice-made mistake.
//
// #132: a test probed `/proc/nonexistent/nope` to assert an unwritable path did
// not throw. macOS has no `/proc`, so it failed fast locally and looked correct;
// CI runs ubuntu, where `/proc` is a live filesystem, and the step hung. Every
// workflow run in the repo sat `in_progress` for five hours with no log, because
// logs only appear once a job finishes.
//
// It was then written again, in the worktree tests, and hung CI a second time.
// The portable form is to root the path at a regular file: `<file>/anything` is
// ENOTDIR everywhere, instantly.
//
// The real backstop is `timeout-minutes` on the CI step, which turns a hang into
// a failure WITH a log. This exists because that change needs a token scope the
// repo does not currently have.

const ROOTS = ["utils", "obs", "extensions"];

function testFiles(dir: string, out: string[] = []): string[] {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e === "node_modules" || e === "ui" || e === "dist") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) testFiles(p, out);
        else if (e.endsWith(".test.ts")) out.push(p);
    }
    return out;
}

describe("tests never probe host-specific filesystem paths", () => {
    it("no test file reaches into /proc, /sys or /dev", () => {
        const offenders: string[] = [];
        for (const root of ROOTS)
            for (const file of testFiles(root)) {
                const src = readFileSync(file, "utf-8");
                for (const [i, line] of src.split("\n").entries()) {
                    // Only actual string literals — a comment explaining this rule
                    // (like the one above) must not trip it.
                    if (/^\s*(\/\/|\*)/.test(line)) continue;
                    if (/["'`]\/(proc|sys|dev)\//.test(line))
                        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
                }
            }
        assert.deepEqual(
            offenders,
            [],
            "Root an unwritable path at a regular file instead — `<file>/x` is " +
                "ENOTDIR on every OS. /proc exists on Linux (CI) but not macOS, " +
                "so this passes locally and hangs CI. It has done so twice.",
        );
    });
});
