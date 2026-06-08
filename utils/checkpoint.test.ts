import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isGitRepo,
    createCheckpoint,
    revertCommands,
    describeCheckpoint,
    slugifyBranch,
    isDefaultBranch,
    ensureWorkBranch,
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

describe("slugifyBranch", () => {
    it("lowercases, dashes non-alphanumerics, trims and caps", () => {
        assert.equal(slugifyBranch("Fix the Login Bug!"), "fix-the-login-bug");
        assert.equal(slugifyBranch("  Add API  v2 "), "add-api-v2");
    });
    it("falls back to 'run' when nothing usable remains", () => {
        assert.equal(slugifyBranch("!!!"), "run");
        assert.equal(slugifyBranch(""), "run");
    });
    it("caps length and does not leave a trailing dash", () => {
        const s = slugifyBranch("a".repeat(60) + " " + "b".repeat(60));
        assert.ok(s.length <= 40);
        assert.doesNotMatch(s, /-$/);
    });
});

describe("isDefaultBranch", () => {
    it("treats main and master as default without consulting the remote", () => {
        const run = fakeRunner({}); // no remote lookup needed
        assert.equal(isDefaultBranch(run, "main"), true);
        assert.equal(isDefaultBranch(run, "master"), true);
    });
    it("uses origin/HEAD when the branch isn't main/master", () => {
        const run = fakeRunner({
            "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk",
        });
        assert.equal(isDefaultBranch(run, "trunk"), true);
        assert.equal(isDefaultBranch(run, "feature"), false);
    });
    it("returns false when there is no remote HEAD", () => {
        const run = fakeRunner({
            "symbolic-ref --short refs/remotes/origin/HEAD": () => {
                throw new Error("no remote");
            },
        });
        assert.equal(isDefaultBranch(run, "dev"), false);
    });
});

describe("ensureWorkBranch", () => {
    it("creates agent/<slug>-<sha> when on the default branch", () => {
        const switched: string[][] = [];
        const run = (args: string[]): string => {
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return "abcdef1234567890";
            if (key === "rev-parse --abbrev-ref HEAD") return "main";
            if (args[0] === "switch") {
                switched.push(args);
                return "";
            }
            throw new Error(`unexpected git ${key}`);
        };
        const wb = ensureWorkBranch(run, "Fix the login bug");
        assert.deepEqual(wb, {
            branch: "agent/fix-the-login-bug-abcdef1",
            base: "abcdef1234567890",
            created: true,
        });
        assert.deepEqual(switched, [
            ["switch", "-c", "agent/fix-the-login-bug-abcdef1"],
        ]);
    });

    it("reuses the current branch when already off the default", () => {
        const run = fakeRunner({
            "rev-parse --is-inside-work-tree": "true",
            "rev-parse HEAD": "deadbeefcafe",
            "rev-parse --abbrev-ref HEAD": "feat/existing",
        });
        const wb = ensureWorkBranch(run, "anything");
        assert.deepEqual(wb, {
            branch: "feat/existing",
            base: "deadbeefcafe",
            created: false,
        });
    });

    it("returns null when not a git repo", () => {
        const run = fakeRunner({
            "rev-parse --is-inside-work-tree": () => {
                throw new Error("not a repo");
            },
        });
        assert.equal(ensureWorkBranch(run, "x"), null);
    });

    it("returns null when the repo has no commits yet", () => {
        const run = fakeRunner({
            "rev-parse --is-inside-work-tree": "true",
            "rev-parse HEAD": () => {
                throw new Error("no HEAD");
            },
        });
        assert.equal(ensureWorkBranch(run, "x"), null);
    });

    it("switches onto an existing branch if create fails", () => {
        const calls: string[][] = [];
        const run = (args: string[]): string => {
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return "0123456789ab";
            if (key === "rev-parse --abbrev-ref HEAD") return "main";
            if (args[0] === "switch" && args[1] === "-c") {
                calls.push(args);
                throw new Error("branch exists");
            }
            if (args[0] === "switch") {
                calls.push(args);
                return "";
            }
            throw new Error(`unexpected git ${key}`);
        };
        const wb = ensureWorkBranch(run, "retry");
        assert.equal(wb?.created, true);
        assert.equal(wb?.branch, "agent/retry-0123456");
        assert.deepEqual(calls, [
            ["switch", "-c", "agent/retry-0123456"],
            ["switch", "agent/retry-0123456"],
        ]);
    });

    it("returns null when it cannot leave the default branch (both switches fail)", () => {
        const run = (args: string[]): string => {
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return "feedface0000";
            if (key === "rev-parse --abbrev-ref HEAD") return "main";
            if (args[0] === "switch") throw new Error("switch blocked");
            throw new Error(`unexpected git ${key}`);
        };
        // Must be null (not the default branch) so no Base is recorded and the
        // implementer skips commits — work never lands on main.
        assert.equal(ensureWorkBranch(run, "blocked"), null);
    });
});
