import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    blockedCommands,
    ghArgsReadOnly,
    gitArgsReadOnly,
} from "./readonly-policy";

describe("ghArgsReadOnly", () => {
    it("allows the documented read-only commands", () => {
        for (const args of [
            ["pr", "view", "55"],
            ["pr", "diff", "55", "--repo", "o/r"],
            ["pr", "checks", "55"],
            ["run", "view", "1", "--log-failed"],
            ["run", "list"],
            ["issue", "list"],
            ["repo", "view", "o/r"],
            ["search", "code", "foo", "--repo", "o/r"],
            ["auth", "status"],
            ["--version"],
            [],
        ]) {
            assert.equal(ghArgsReadOnly(args), true, args.join(" "));
        }
    });

    it("denies mutating commands (default-deny)", () => {
        for (const args of [
            ["pr", "create"],
            ["pr", "merge", "55"],
            ["pr", "comment", "5", "--body", "x"],
            ["pr", "review", "5", "--approve"],
            ["issue", "close", "3"],
            ["issue", "create", "--title", "x"],
            ["release", "create", "v1"],
            ["repo", "delete", "o/r"],
            ["run", "rerun", "1"],
            ["secret", "set", "X"],
            ["workflow", "run", "ci.yml"],
            ["unknowncmd"],
        ]) {
            assert.equal(ghArgsReadOnly(args), false, args.join(" "));
        }
    });

    it("treats gh api as read-only only for GET", () => {
        assert.equal(
            ghArgsReadOnly(["api", "repos/o/r/pulls/55", "--jq", ".title"]),
            true,
        );
        assert.equal(
            ghArgsReadOnly(["api", "repos/o/r/issues", "-f", "title=x"]),
            false,
        );
        assert.equal(
            ghArgsReadOnly(["api", "repos/o/r/pulls/1/merge", "-X", "PUT"]),
            false,
        );
        assert.equal(
            ghArgsReadOnly(["api", "graphql", "-f", "query={viewer{login}}"]),
            true,
        );
        assert.equal(
            ghArgsReadOnly(["api", "graphql", "-f", "query=mutation{...}"]),
            false,
        );
    });
});

describe("gitArgsReadOnly", () => {
    it("allows inspection commands the review agents rely on", () => {
        for (const args of [
            ["diff", "abc123..HEAD"],
            ["log", "--oneline", "-20"],
            ["show", "HEAD"],
            ["status"],
            ["rev-parse", "HEAD"],
            ["blame", "app.js"],
            ["ls-files"],
            ["remote", "-v"],
            ["remote", "show", "origin"],
            ["config", "--get", "user.name"],
            ["config", "user.email"],
            ["stash", "list"],
            ["branch", "-a"],
            ["branch", "--contains", "abc123"], // read flag w/ positional
            ["branch", "--merged"],
            ["tag", "-l", "v*"],
            ["tag", "--contains", "abc123"],
            ["-C", "/repo", "log", "--oneline"], // global -C <path> then read
            ["--no-pager", "diff"],
            ["--version"],
            [],
        ]) {
            assert.equal(gitArgsReadOnly(args), true, args.join(" "));
        }
    });

    it("denies mutating commands", () => {
        for (const args of [
            ["push"],
            ["push", "origin", "main"],
            ["commit", "-m", "x"],
            ["merge", "feature"],
            ["rebase", "-i", "HEAD~2"],
            ["reset", "--hard", "HEAD~1"],
            ["checkout", "-b", "fix"],
            ["switch", "main"],
            ["restore", "app.js"],
            ["clean", "-fd"],
            ["pull"],
            ["fetch", "origin"],
            ["rm", "f.txt"],
            ["remote", "add", "origin", "url"],
            ["remote", "set-url", "origin", "url"],
            ["config", "user.email", "x@y.z"],
            ["config", "--unset", "user.name"],
            ["stash"],
            ["stash", "pop"],
            ["branch", "-d", "old"],
            ["branch", "-D", "old"],
            ["branch", "-m", "old", "new"],
            ["branch", "--set-upstream-to=origin/x"],
            ["tag", "-d", "v1"],
            ["tag", "-a", "v1", "-m", "release"],
            ["tag", "-f", "v1"],
            ["-C", "/repo", "push"], // global flag then a mutator
        ]) {
            assert.equal(gitArgsReadOnly(args), false, args.join(" "));
        }
    });

    it("leaves a bare-positional branch/tag create alone (documented gap)", () => {
        assert.equal(gitArgsReadOnly(["branch", "newbranch"]), true);
        assert.equal(gitArgsReadOnly(["tag", "v1.2.3"]), true);
    });
});

describe("blockedCommands", () => {
    it("returns [] for non-target or read-only commands", () => {
        assert.deepEqual(blockedCommands("ls -la && cat x"), []);
        assert.deepEqual(
            blockedCommands("git diff abc..HEAD | gh pr view 1 --repo o/r"),
            [],
        );
    });

    it("flags mutating gh and git anywhere in the command", () => {
        assert.deepEqual(blockedCommands("git push origin main"), [
            "git push origin main",
        ]);
        assert.deepEqual(blockedCommands("gh pr merge 5"), ["gh pr merge 5"]);
        assert.deepEqual(
            blockedCommands("echo b | gh pr comment 5 --body-file -"),
            ["gh pr comment 5 --body-file -"],
        );
        assert.deepEqual(blockedCommands("GH_TOKEN=x git commit -m wip"), [
            "git commit -m wip",
        ]);
    });

    it("flags only the mutating ones in a mixed chain", () => {
        assert.deepEqual(
            blockedCommands("git diff && gh pr view 5 && git push"),
            ["git push"],
        );
    });
});
