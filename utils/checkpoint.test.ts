import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isGitRepo,
    createCheckpoint,
    revertCommands,
    describeCheckpoint,
    type Checkpoint,
} from "./checkpoint";

// A fake GitRunner driven by a map of "joined args" -> output (or a thrower).
function fakeRunner(
    map: Record<string, string | (() => string)>,
): (args: string[]) => string {
    return (args: string[]) => {
        const key = args.join(" ");
        const v = map[key];
        if (v === undefined) throw new Error(`unexpected git ${key}`);
        return typeof v === "function" ? v() : v;
    };
}

describe("isGitRepo", () => {
    it("true when inside a work tree", () => {
        assert.equal(
            isGitRepo(fakeRunner({ "rev-parse --is-inside-work-tree": "true" })),
            true,
        );
    });
    it("false when the command throws or returns non-true", () => {
        assert.equal(
            isGitRepo(
                fakeRunner({
                    "rev-parse --is-inside-work-tree": () => {
                        throw new Error("not a repo");
                    },
                }),
            ),
            false,
        );
        assert.equal(
            isGitRepo(fakeRunner({ "rev-parse --is-inside-work-tree": "false" })),
            false,
        );
    });
});

describe("createCheckpoint", () => {
    it("returns null when not a git repo", () => {
        const cp = createCheckpoint(
            fakeRunner({ "rev-parse --is-inside-work-tree": "false" }),
            "req",
        );
        assert.equal(cp, null);
    });

    it("captures head, branch, snapshot, and metadata", () => {
        const cp = createCheckpoint(
            fakeRunner({
                "rev-parse --is-inside-work-tree": "true",
                "rev-parse HEAD": "abc123",
                "rev-parse --abbrev-ref HEAD": "main",
                "stash create": "stash99",
            }),
            "fix the bug",
            1000,
        );
        assert.deepEqual(cp, {
            head: "abc123",
            branch: "main",
            snapshot: "stash99",
            takenAt: 1000,
            request: "fix the bug",
        });
    });

    it("tolerates a repo with no commits and a clean tree (empty strings)", () => {
        const cp = createCheckpoint(
            fakeRunner({
                "rev-parse --is-inside-work-tree": "true",
                "rev-parse HEAD": () => {
                    throw new Error("no commits");
                },
                "rev-parse --abbrev-ref HEAD": "main",
                "stash create": "", // clean tree -> empty
            }),
            "req",
            5,
        );
        assert.equal(cp?.head, "");
        assert.equal(cp?.snapshot, "");
        assert.equal(cp?.branch, "main");
    });
});

describe("revertCommands", () => {
    const base: Checkpoint = {
        head: "abc",
        branch: "main",
        snapshot: "stash1",
        takenAt: 0,
        request: "",
    };
    it("resets to head then applies the snapshot", () => {
        assert.deepEqual(revertCommands(base), [
            ["reset", "--hard", "abc"],
            ["stash", "apply", "stash1"],
        ]);
    });
    it("omits reset when there was no head", () => {
        assert.deepEqual(revertCommands({ ...base, head: "" }), [
            ["stash", "apply", "stash1"],
        ]);
    });
    it("omits stash apply when the tree was clean", () => {
        assert.deepEqual(revertCommands({ ...base, snapshot: "" }), [
            ["reset", "--hard", "abc"],
        ]);
    });
});

describe("describeCheckpoint", () => {
    it("includes branch, short sha, dirty marker, and request", () => {
        const s = describeCheckpoint({
            head: "abcdef1234567890",
            branch: "feature/x",
            snapshot: "stash1",
            takenAt: 0,
            request: "add CSV export",
        });
        assert.match(s, /feature\/x/);
        assert.match(s, /abcdef12/);
        assert.match(s, /uncommitted changes/);
        assert.match(s, /add CSV export/);
    });
    it("shows (no commits) when head is empty and no dirty marker when clean", () => {
        const s = describeCheckpoint({
            head: "",
            branch: "main",
            snapshot: "",
            takenAt: 0,
            request: "",
        });
        assert.match(s, /\(no commits\)/);
        assert.doesNotMatch(s, /uncommitted changes/);
    });
});
