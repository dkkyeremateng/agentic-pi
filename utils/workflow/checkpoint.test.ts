import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isGitRepo,
    createCheckpoint,
    revertCommands,
    describeCheckpoint,
    slugifyBranch,
    isDefaultBranch,
    isAgentBranch,
    defaultBranchName,
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
                "stash store -m pre-run checkpoint stash99": "",
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

    it("stores the snapshot so git gc cannot prune the dangling stash commit", () => {
        // `stash create` alone leaves an unreferenced commit: once it is pruned,
        // /revert's `stash apply <sha>` throws and the pre-run work is unrecoverable.
        const calls: string[][] = [];
        const run = (args: string[]): string => {
            calls.push(args);
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return "abc123";
            if (key === "rev-parse --abbrev-ref HEAD") return "main";
            if (key === "stash create") return "stash99";
            if (args[0] === "stash" && args[1] === "store") return "";
            throw new Error(`unexpected git ${key}`);
        };
        const cp = createCheckpoint(run, "req", 1);
        assert.equal(cp?.snapshot, "stash99");
        assert.deepEqual(
            calls.filter((c) => c[1] === "store"),
            [["stash", "store", "-m", "pre-run checkpoint", "stash99"]],
        );
    });

    it("does not store anything when the tree was clean", () => {
        const calls: string[][] = [];
        const run = (args: string[]): string => {
            calls.push(args);
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return "abc123";
            if (key === "rev-parse --abbrev-ref HEAD") return "main";
            if (key === "stash create") return "";
            throw new Error(`unexpected git ${key}`);
        };
        assert.equal(createCheckpoint(run, "req", 1)?.snapshot, "");
        assert.equal(calls.some((c) => c[1] === "store"), false);
    });

    it("survives a git that cannot store the stash (best-effort)", () => {
        const cp = createCheckpoint(
            fakeRunner({
                "rev-parse --is-inside-work-tree": "true",
                "rev-parse HEAD": "abc123",
                "rev-parse --abbrev-ref HEAD": "main",
                "stash create": "stash99",
                "stash store -m pre-run checkpoint stash99": () => {
                    throw new Error("store failed");
                },
            }),
            "req",
            1,
        );
        assert.equal(cp?.snapshot, "stash99");
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
    it("switches back to the checkpoint branch, resets to head, then applies the snapshot", () => {
        // The switch MUST come first: the run may have moved to agent/<slug>, and
        // resetting there would force-rewrite that branch (and any PR from it) to
        // the checkpoint branch's old tip.
        assert.deepEqual(revertCommands(base), [
            ["switch", "--force", "main"],
            ["reset", "--hard", "abc"],
            ["stash", "apply", "stash1"],
        ]);
    });
    it("forces the switch, because the caller's backup leaves the tree dirty", () => {
        // extensions/revert.ts backs up with `stash create` + `stash store`, which
        // (unlike `stash push`) does NOT clean the working tree. A plain `switch`
        // would abort with "local changes would be overwritten" and take the whole
        // revert with it — and those changes are what the next `reset --hard`
        // discards anyway.
        assert.deepEqual(revertCommands(base)[0], ["switch", "--force", "main"]);
    });
    it("omits reset when there was no head", () => {
        assert.deepEqual(revertCommands({ ...base, head: "" }), [
            ["switch", "--force", "main"],
            ["stash", "apply", "stash1"],
        ]);
    });
    it("omits stash apply when the tree was clean", () => {
        assert.deepEqual(revertCommands({ ...base, snapshot: "" }), [
            ["switch", "--force", "main"],
            ["reset", "--hard", "abc"],
        ]);
    });
    it("omits the switch when the checkpoint was detached or has no branch", () => {
        // `rev-parse --abbrev-ref HEAD` reports the literal "HEAD" when detached.
        assert.deepEqual(revertCommands({ ...base, branch: "HEAD" }), [
            ["reset", "--hard", "abc"],
            ["stash", "apply", "stash1"],
        ]);
        assert.deepEqual(revertCommands({ ...base, branch: "" }), [
            ["reset", "--hard", "abc"],
            ["stash", "apply", "stash1"],
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

describe("isAgentBranch", () => {
    it("matches branches this workflow creates", () => {
        assert.equal(isAgentBranch("agent/fix-thing-abc1234"), true);
        assert.equal(isAgentBranch("feat/user-thing"), false);
        assert.equal(isAgentBranch("main"), false);
    });
});

describe("defaultBranchName", () => {
    it("prefers origin/HEAD", () => {
        const run = fakeRunner({
            "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk",
        });
        assert.equal(defaultBranchName(run), "trunk");
    });
    it("falls back to main when it exists", () => {
        const run = fakeRunner({
            "symbolic-ref --short refs/remotes/origin/HEAD": () => {
                throw new Error("no remote");
            },
            "rev-parse --verify --quiet main": "abc123",
        });
        assert.equal(defaultBranchName(run), "main");
    });
    it("falls back to master when main is absent", () => {
        const run = fakeRunner({
            "symbolic-ref --short refs/remotes/origin/HEAD": () => {
                throw new Error("no remote");
            },
            "rev-parse --verify --quiet main": () => {
                throw new Error("no main");
            },
            "rev-parse --verify --quiet master": "def456",
        });
        assert.equal(defaultBranchName(run), "master");
    });
    it("returns empty string when nothing matches", () => {
        const run = fakeRunner({
            "symbolic-ref --short refs/remotes/origin/HEAD": () => {
                throw new Error("no remote");
            },
            "rev-parse --verify --quiet main": () => {
                throw new Error("x");
            },
            "rev-parse --verify --quiet master": () => {
                throw new Error("x");
            },
        });
        assert.equal(defaultBranchName(run), "");
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

    it("reuses the user's own non-default branch (doesn't yank them onto main)", () => {
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

    it("leaves a prior agent branch and branches fresh from the default", () => {
        let branch = "agent/old-aaaaaaa";
        const heads: Record<string, string> = {
            "agent/old-aaaaaaa": "aaaaaaa0000",
            main: "bbbbbbb1111",
        };
        const created: string[] = [];
        const run = (args: string[]): string => {
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return heads[branch];
            if (key === "rev-parse --abbrev-ref HEAD") return branch;
            if (key === "symbolic-ref --short refs/remotes/origin/HEAD")
                return "origin/main";
            if (args[0] === "switch" && args[1] === "-c") {
                branch = args[2];
                heads[branch] = heads["main"]; // fresh branch sits on main's tip
                created.push(args[2]);
                return "";
            }
            if (args[0] === "switch") {
                branch = args[1];
                return "";
            }
            throw new Error(`unexpected git ${key}`);
        };
        const wb = ensureWorkBranch(run, "new feature");
        // Base is main's tip, NOT the old branch's — the new work starts clean.
        assert.deepEqual(wb, {
            branch: "agent/new-feature-bbbbbbb",
            base: "bbbbbbb1111",
            created: true,
        });
        assert.equal(branch, "agent/new-feature-bbbbbbb"); // ended on the fresh branch
    });

    it("branches off a DETACHED HEAD instead of committing while detached", () => {
        // `rev-parse --abbrev-ref HEAD` returns the literal "HEAD" when detached; it
        // is not a branch, so the run must cut agent/<slug>-<sha> from the detached
        // sha rather than pile commits onto a HEAD that orphans them at checkout.
        const switched: string[][] = [];
        const run = (args: string[]): string => {
            const key = args.join(" ");
            if (key === "rev-parse --is-inside-work-tree") return "true";
            if (key === "rev-parse HEAD") return "cafebabe1234";
            if (key === "rev-parse --abbrev-ref HEAD") return "HEAD";
            if (args[0] === "switch") {
                switched.push(args);
                return "";
            }
            throw new Error(`unexpected git ${key}`);
        };
        const wb = ensureWorkBranch(run, "detached work");
        assert.deepEqual(wb, {
            branch: "agent/detached-work-cafebab",
            base: "cafebabe1234",
            created: true,
        });
        assert.deepEqual(switched, [["switch", "-c", "agent/detached-work-cafebab"]]);
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
