import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    blockedCommands,
    blockedFileWrites,
    blockedRepoCreation,
    ghArgsReadOnly,
    gitArgsReadOnly,
    blockedRootSearch,
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
            ["branch", "--sort", "committerdate"], // flag w/ next-token value
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
            ["branch", "newbranch"], // bare-positional create
            ["branch", "newbranch", "origin/main"], // create from start-point
            ["tag", "v1.2.3"], // lightweight tag create
            ["-C", "/repo", "push"], // global flag then a mutator
        ]) {
            assert.equal(gitArgsReadOnly(args), false, args.join(" "));
        }
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

    it("sees through exec-wrapper prefixes (env/command/nohup/timeout/nice)", () => {
        // `env` (with and without inline assignments) must not hide the mutation.
        assert.deepEqual(blockedCommands("env gh pr merge 5"), ["gh pr merge 5"]);
        assert.deepEqual(blockedCommands("env FOO=bar gh pr merge 5"), ["gh pr merge 5"]);
        assert.deepEqual(blockedCommands("env -i -u PATH gh pr merge 5"), ["gh pr merge 5"]);
        assert.deepEqual(blockedCommands("command git push"), ["git push"]);
        assert.deepEqual(blockedCommands("nohup gh pr merge 5"), ["gh pr merge 5"]);
        assert.deepEqual(blockedCommands("nice -n 10 git push"), ["git push"]);
        assert.deepEqual(blockedCommands("timeout 30 gh pr merge 5"), ["gh pr merge 5"]);
        assert.deepEqual(blockedCommands("timeout -k 5 30 git push"), ["git push"]);
        // a wrapped READ is still allowed (peeling never over-blocks)
        assert.deepEqual(blockedCommands("env FOO=b gh pr view 5"), []);
        assert.deepEqual(blockedCommands("nice git log"), []);
    });

    it("flags a glued `gh api -XPOST` write (not just the spaced form)", () => {
        assert.deepEqual(blockedCommands("gh api -XPOST /repos/o/r/merges"), [
            "gh api -XPOST /repos/o/r/merges",
        ]);
        assert.deepEqual(blockedCommands("gh api -X POST /repos/o/r/merges"), [
            "gh api -X POST /repos/o/r/merges",
        ]);
        assert.deepEqual(blockedCommands("gh api --method=DELETE /repos/o/r/x"), [
            "gh api --method=DELETE /repos/o/r/x",
        ]);
        // a plain GET stays allowed
        assert.deepEqual(blockedCommands("gh api /repos/o/r/pulls/5"), []);
    });
});

// ── shell file writes (the `sed -i` hole) ────────────────────────────────────

describe("blockedFileWrites", () => {
    for (const cmd of [
        "sed -i '' 's/a/b/' roadmap.md",
        "sed -i.bak s/a/b/ file.md",
        "perl -i -pe 's/a/b/' file.md",
        "echo hi > notes.md",
        "cat foo >> bar.md",
        "grep x plan.md | tee out.txt",
        "truncate -s 0 log.txt",
        "patch -p1 < fix.diff",
        "dd if=/dev/zero of=blob.bin",
        "cd /tmp && sed -i '' 's/x/y/' a.md",
        // a quoted target is still a redirection
        'echo x > "my notes.md"',
    ]) {
        it(`blocks ${JSON.stringify(cmd)}`, () => {
            assert.ok(blockedFileWrites(cmd).length > 0, cmd);
        });
    }

    it("reports a quoted target in full, not as a bare quote", () => {
        assert.deepEqual(blockedFileWrites('echo x > "my notes.md"'), [
            "> my notes.md (shell redirection to a file)",
        ]);
    });

    for (const cmd of [
        "grep -n 'Milestone' roadmap.md",
        "wc -w roadmap.md",
        "command -v encore && encore version 2>/dev/null || echo missing",
        "git log --oneline -10 2>/dev/null",
        "go test ./... 2>&1",
        "ls -la >/dev/null 2>&1",
        "sed 's/a/b/' file.md",
        "cat plan.md | tee /dev/null",
        "npm test -- --reporter=dot",
        "nl -ba plan.md | grep -E '^ *[0-9]+ #'",
        "",
        // A `>` inside a string is an argument, not a redirection. Every one of
        // these was refused as a write before the scan became quote-aware --
        // ordinary reading work, blocked by the guard meant to permit it.
        'grep -n "a > b" src/x.ts',
        "grep -rn 'if (n > 0)' src/",
        'node -e "console.log(1 > 0)"',
        'awk "{ if ($1 > 2) print }" data.txt',
        'git log --format="%h -> %s" -5',
        'echo "score > 5"',
    ]) {
        it(`allows ${JSON.stringify(cmd)}`, () => {
            assert.deepEqual(blockedFileWrites(cmd), [], cmd);
        });
    }
});

// A wrapper that merely execs another command must not hide it. `sudo git push`
// and `… | xargs git push` slipped through as unpoliced heads; `sh -c "git push"`
// hid the command inside a quoted argument.
describe("blockedCommands through exec wrappers", () => {
    for (const cmd of [
        "sudo git push origin main",
        "sudo -n git push", // -n is sudo's non-interactive flag, NOT a value flag
        "sudo -u bob gh pr merge 1",
        "doas git push",
        "xargs -n1 git push",
        "echo main | xargs git push origin",
        'bash -c "git push origin main"',
        "sh -c 'gh pr merge 1'",
        'echo "$(git push)"', // substitution runs even inside double quotes
        "stdbuf -o0 git commit -m x",
    ]) {
        it(`sees through ${JSON.stringify(cmd)}`, () => {
            assert.ok(blockedCommands(cmd).length > 0, cmd);
        });
    }

    for (const cmd of [
        "sudo -n true",
        "timeout 5 git log --oneline",
        "nice -n 10 git status",
        'bash -c "git log --oneline | head"',
        "echo x | xargs grep -l pattern",
    ]) {
        it(`leaves ${JSON.stringify(cmd)} alone`, () => {
            assert.deepEqual(blockedCommands(cmd), [], cmd);
        });
    }
});

// Subcommands whose read and write forms differ: blanket-blocking `reflog` or
// `bisect` would refuse the inspection commands agents actually use.
describe("gitArgsReadOnly on context-sensitive subcommands", () => {
    for (const args of [
        ["reflog"],
        ["reflog", "-n", "5"],
        ["bisect", "log"],
        ["notes", "show"],
        ["notes", "list"],
        ["submodule", "status"],
        ["submodule", "summary"],
        ["archive", "HEAD"],
    ]) {
        it(`allows git ${args.join(" ")}`, () => {
            assert.equal(gitArgsReadOnly(args), true, args.join(" "));
        });
    }

    for (const args of [
        ["reflog", "expire", "--all"],
        ["reflog", "delete", "HEAD@{1}"],
        ["bisect", "reset"],
        ["bisect", "start"],
        ["notes", "add", "-m", "x"],
        ["submodule", "update", "--remote"],
        ["submodule", "foreach", "rm -rf x"],
        ["archive", "-o", "out.tar", "HEAD"],
        ["format-patch", "HEAD~1"],
    ]) {
        it(`denies git ${args.join(" ")}`, () => {
            assert.equal(gitArgsReadOnly(args), false, args.join(" "));
        });
    }
});

// ── repo creation (blocked for every agent, including write-capable ones) ────

describe("blockedRepoCreation", () => {
    for (const cmd of [
        "git init",
        "git init --bare .",
        "cd /tmp/x && git init",
        "gh repo create my-app --private",
        "gh repo create --source=. --push",
        "git remote add origin https://github.com/o/r.git",
        "git -C sub remote add origin url",
        "go test ./... && git init",
    ]) {
        it(`blocks ${JSON.stringify(cmd)}`, () => {
            assert.ok(blockedRepoCreation(cmd).length > 0, cmd);
        });
    }

    for (const cmd of [
        "git status --short",
        "git remote -v",
        "git remote get-url origin",
        "git switch -c feat/x",
        "git add -A && git commit -m 'feat: x'",
        "git push -u origin feat/x",
        "gh repo view",
        "gh pr create --draft --title x",
        "go test ./...",
        "",
    ]) {
        it(`allows ${JSON.stringify(cmd)}`, () => {
            assert.deepEqual(blockedRepoCreation(cmd), [], cmd);
        });
    }

    it("does not block the shipper's real workflow", () => {
        const shipper = [
            "git remote -v",
            "git switch -c feat/m1-webhook-ingestion",
            "git add .gitignore api/ go.mod",
            "git commit -q -m 'feat(controlplane): scaffold'",
            "gh pr create --draft",
        ];
        for (const c of shipper) assert.deepEqual(blockedRepoCreation(c), [], c);
    });
});

describe("blockedRootSearch", () => {
    // 24 calls in a month burned 4347s -- 5 to 9 minutes each -- and every one
    // was literally `find /`.
    it("blocks the exact shapes seen in the logs", () => {
        assert.deepEqual(
            blockedRootSearch('find / -path "*/encore.dev/request*" -name "*.go" 2>/dev/null | head'),
            ["find /"],
        );
        assert.deepEqual(blockedRootSearch('find / -name "SKILL.md" -path "*lsp*"'), ["find /"]);
    });

    it("finds it inside a compound command", () => {
        const cmd = 'cd /Users/me/proj && grep -rn "river" go.mod | head && find / -path "*river*" | head -3';
        assert.deepEqual(blockedRootSearch(cmd), ["find /"]);
        const many = 'echo "searching"; find / -name "stats.test.ts"; find / -name "stats.ts"';
        assert.equal(blockedRootSearch(many).length, 2);
    });

    it("leaves a scoped search alone, however absolute", () => {
        // The narrowness is the point: only the filesystem ROOT is refused.
        assert.deepEqual(blockedRootSearch("find /Users/me/project -name x"), []);
        assert.deepEqual(blockedRootSearch("find . -name x"), []);
        assert.deepEqual(blockedRootSearch("find src -name x"), []);
        assert.deepEqual(blockedRootSearch('find "$PWD" -name x'), []);
        assert.deepEqual(blockedRootSearch("find ./ -name x"), []);
    });

    it("does not fire on other commands that mention a root path", () => {
        assert.deepEqual(blockedRootSearch("ls / | head"), []);
        assert.deepEqual(blockedRootSearch("df -h /"), []);
        assert.deepEqual(blockedRootSearch('grep -rn "x" /'), []);
        assert.deepEqual(blockedRootSearch("echo find /"), []);
    });

    it("handles junk without throwing", () => {
        assert.deepEqual(blockedRootSearch(""), []);
        assert.deepEqual(blockedRootSearch(undefined as any), []);
        assert.deepEqual(blockedRootSearch("find"), []);
    });
});
