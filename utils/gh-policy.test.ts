import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockedGhCommands, ghArgsReadOnly } from "./gh-policy";

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
        // GraphQL reads use -f query=... and stay read-only; mutations don't.
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

describe("blockedGhCommands", () => {
    it("returns [] for non-gh or read-only commands", () => {
        assert.deepEqual(blockedGhCommands("git push origin main"), []);
        assert.deepEqual(blockedGhCommands("ls -la && cat x"), []);
        assert.deepEqual(
            blockedGhCommands("gh pr view 5 --repo o/r | jq .title"),
            [],
        );
    });

    it("flags a mutating gh anywhere in the command", () => {
        assert.deepEqual(blockedGhCommands("gh pr merge 5"), ["gh pr merge 5"]);
        // piped-into gh
        assert.deepEqual(
            blockedGhCommands("echo body | gh pr comment 5 --body-file -"),
            ["gh pr comment 5 --body-file -"],
        );
        // env-prefixed
        assert.deepEqual(blockedGhCommands("GH_TOKEN=x gh issue close 3"), [
            "gh issue close 3",
        ]);
        // inside a subshell
        assert.deepEqual(blockedGhCommands("X=$(gh pr create --fill)"), [
            "gh pr create --fill",
        ]);
    });

    it("only flags the mutating one when read + write are chained", () => {
        assert.deepEqual(
            blockedGhCommands("gh pr view 5 && gh pr merge 5"),
            ["gh pr merge 5"],
        );
    });
});
