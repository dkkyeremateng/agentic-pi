import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdtempSync,
    writeFileSync,
    mkdirSync,
    readFileSync,
    existsSync,
    lstatSync,
    rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    worktreeIsolationEnabled,
    worktreeBlocker,
    worktreeRoot,
    createWaveWorktrees,
    collectWorktreeChanges,
    planWaveMerge,
    applyWaveMerge,
    removeWaveWorktrees,
    linkSharedPaths,
    excludeWorktreeDir,
    SHARED_WORKTREE_PATHS,
    type WorktreeChanges,
} from "./worktree";
import type { GitRunner } from "./checkpoint";

// ── a real repo, because the merge semantics are the risk ─────────────────────
// planWaveMerge can be reasoned about; "does `checkout <sha> -- <path>` actually
// materialise a worker's new file into the main tree" cannot. These tests drive
// real git so a wrong assumption fails here rather than losing a phase's work.

function git(cwd: string): GitRunner {
    return (args) =>
        execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    const run = git(dir);
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "base\n");
    writeFileSync(join(dir, "b.txt"), "base\n");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "base"]);
    return dir;
}

describe("worktreeIsolationEnabled is off unless asked for", () => {
    // A fresh worktree has no node_modules. Until this has run against real
    // projects, defaulting it on would break more waves than it protects.
    it("defaults off", () => {
        assert.equal(worktreeIsolationEnabled({} as any), false);
    });
    it("accepts 1 and true", () => {
        assert.equal(
            worktreeIsolationEnabled({ PI_WORKTREE_ISOLATION: "1" } as any),
            true,
        );
        assert.equal(
            worktreeIsolationEnabled({ PI_WORKTREE_ISOLATION: "TRUE" } as any),
            true,
        );
    });
    it("treats anything else as off", () => {
        for (const v of ["0", "", "yes", "on"])
            assert.equal(
                worktreeIsolationEnabled({ PI_WORKTREE_ISOLATION: v } as any),
                false,
                v,
            );
    });
});

describe("worktreeBlocker says WHY it cannot isolate", () => {
    // A reason, not a bare false: the caller has to tell the user why the wave
    // ran shared, or the fallback looks like the feature silently not working.
    it("passes on a normal repo", () => {
        assert.equal(worktreeBlocker(git(repo())), null);
    });

    it("names a non-repo", () => {
        const dir = mkdtempSync(join(tmpdir(), "wt-none-"));
        assert.match(worktreeBlocker(git(dir)) || "", /not a git repository/);
    });

    it("names an empty repo — a worktree must branch FROM something", () => {
        const dir = mkdtempSync(join(tmpdir(), "wt-empty-"));
        const run = git(dir);
        run(["init", "-q"]);
        assert.match(worktreeBlocker(run) || "", /no commits/);
    });
});

describe("a wave's worktrees are real, separate trees", () => {
    it("creates one per id, each holding the base content", () => {
        const dir = repo();
        const run = git(dir);
        const base = run(["rev-parse", "HEAD"]);
        const wts = createWaveWorktrees(run, dir, base, ["w1", "w2"]);
        assert.equal(wts.length, 2);
        for (const wt of wts) {
            assert.ok(existsSync(join(wt.path, "a.txt")));
            assert.equal(readFileSync(join(wt.path, "a.txt"), "utf-8"), "base\n");
        }
        // The point: a write in one is invisible to the other.
        writeFileSync(join(wts[0].path, "a.txt"), "w1\n");
        assert.equal(readFileSync(join(wts[1].path, "a.txt"), "utf-8"), "base\n");
        assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "base\n");
        removeWaveWorktrees(run, wts);
    });

    it("puts them under .agent/, which is already ignored", () => {
        assert.match(worktreeRoot("/x"), /\/\.agent\/worktrees$/);
    });
});

describe("collectWorktreeChanges commits what a worker left uncommitted", () => {
    // Workers do not commit — the coordinator owns checkpoints — so there are no
    // worker commits to cherry-pick. The harness makes one on their behalf.
    it("records modified, added and deleted paths", () => {
        const dir = repo();
        const run = git(dir);
        const base = run(["rev-parse", "HEAD"]);
        const [wt] = createWaveWorktrees(run, dir, base, ["w1"]);
        writeFileSync(join(wt.path, "a.txt"), "changed\n");
        writeFileSync(join(wt.path, "new.txt"), "added\n");
        rmSync(join(wt.path, "b.txt"));

        const c = collectWorktreeChanges(git, wt);
        assert.ok(c.sha, "should have produced a commit");
        assert.deepEqual(c.files.sort(), ["a.txt", "new.txt"]);
        assert.deepEqual(c.deleted, ["b.txt"]);
        removeWaveWorktrees(run, [wt]);
    });

    it("reports nothing for a worker that only read", () => {
        const dir = repo();
        const run = git(dir);
        const [wt] = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1"]);
        const c = collectWorktreeChanges(git, wt);
        assert.equal(c.sha, "");
        assert.deepEqual(c.files, []);
        removeWaveWorktrees(run, [wt]);
    });
});

describe("planWaveMerge refuses to pick a winner", () => {
    const mk = (index: number, files: string[], deleted: string[] = []) =>
        ({ index, files, deleted, sha: `sha${index}` }) as WorktreeChanges;

    it("applies disjoint work", () => {
        const plan = planWaveMerge([mk(0, ["a.ts"]), mk(1, ["b.ts"])]);
        assert.equal(plan.conflicts.size, 0);
        assert.deepEqual(plan.apply.map((c) => c.index), [0, 1]);
    });

    it("applies NEITHER side of a contested file", () => {
        // The shared tree silently kept the later write. Choosing a winner here
        // would reproduce exactly that data loss, just with better logging.
        const plan = planWaveMerge([mk(0, ["a.ts"]), mk(1, ["a.ts"])]);
        assert.deepEqual(plan.conflicts.get("a.ts"), [0, 1]);
        assert.equal(plan.apply.length, 0);
    });

    it("still applies a contested worker's UNcontested siblings? No — it holds all of it", () => {
        // A worker's changes are one phase's intent. Landing half of it would
        // leave the tree in a state no phase asked for.
        const plan = planWaveMerge([mk(0, ["a.ts", "solo.ts"]), mk(1, ["a.ts"])]);
        assert.equal(plan.apply.length, 0);
    });

    it("counts a delete as touching the file", () => {
        const plan = planWaveMerge([mk(0, [], ["a.ts"]), mk(1, ["a.ts"])]);
        assert.deepEqual(plan.conflicts.get("a.ts"), [0, 1]);
    });

    it("skips a worker that changed nothing", () => {
        const plan = planWaveMerge([mk(0, ["a.ts"]), { index: 1, files: [], deleted: [], sha: "" }]);
        assert.deepEqual(plan.apply.map((c) => c.index), [0]);
    });
});

describe("applyWaveMerge materialises work into the main tree", () => {
    it("lands modifications, additions and deletions", () => {
        const dir = repo();
        const run = git(dir);
        const base = run(["rev-parse", "HEAD"]);
        const wts = createWaveWorktrees(run, dir, base, ["w1", "w2"]);

        writeFileSync(join(wts[0].path, "a.txt"), "from w1\n");
        writeFileSync(join(wts[0].path, "new.txt"), "added by w1\n");
        rmSync(join(wts[1].path, "b.txt"));

        const changes = wts.map((wt) => collectWorktreeChanges(git, wt));
        const plan = planWaveMerge(changes);
        assert.equal(plan.conflicts.size, 0, "disjoint work should not conflict");
        const landed = applyWaveMerge(run, plan);

        assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "from w1\n");
        assert.equal(readFileSync(join(dir, "new.txt"), "utf-8"), "added by w1\n");
        assert.ok(!existsSync(join(dir, "b.txt")), "deletion should land");
        assert.deepEqual(landed.sort(), ["a.txt", "b.txt", "new.txt"]);
        removeWaveWorktrees(run, wts);
    });

    it("leaves the main tree untouched when the wave conflicts", () => {
        const dir = repo();
        const run = git(dir);
        const wts = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1", "w2"]);
        writeFileSync(join(wts[0].path, "a.txt"), "w1\n");
        writeFileSync(join(wts[1].path, "a.txt"), "w2\n");

        const plan = planWaveMerge(wts.map((wt) => collectWorktreeChanges(git, wt)));
        applyWaveMerge(run, plan);
        // Neither wrote. The caller reports the conflict and re-runs sequentially.
        assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "base\n");
        removeWaveWorktrees(run, wts);
    });
});

describe("removeWaveWorktrees is always safe to call", () => {
    it("removes them and tolerates a second call", () => {
        const dir = repo();
        const run = git(dir);
        const wts = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1"]);
        removeWaveWorktrees(run, wts);
        assert.ok(!existsSync(wts[0].path));
        removeWaveWorktrees(run, wts); // must not throw
    });

    it("never throws outside a repo", () => {
        const dir = mkdtempSync(join(tmpdir(), "wt-norepo-"));
        removeWaveWorktrees(git(dir), [{ index: 0, path: "/nope", branch: "x" }]);
    });
});

describe("linkSharedPaths is what makes isolation usable", () => {
    // Without this, a fresh worktree of a Node project has no node_modules and
    // the first `npm test` fails — isolation that breaks every worker.
    it("symlinks gitignored paths the worker needs", () => {
        const dir = repo();
        mkdirSync(join(dir, "node_modules"));
        writeFileSync(join(dir, "node_modules", "marker"), "x");
        writeFileSync(join(dir, ".env"), "SECRET=1\n");
        const run = git(dir);
        const [wt] = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1"]);

        const linked = linkSharedPaths(dir, wt.path);
        assert.ok(linked.includes("node_modules"));
        assert.ok(linked.includes(".env"));
        assert.ok(lstatSync(join(wt.path, "node_modules")).isSymbolicLink());
        assert.equal(
            readFileSync(join(wt.path, "node_modules", "marker"), "utf-8"),
            "x",
        );
        removeWaveWorktrees(run, [wt]);
    });

    it("skips paths the repo does not have", () => {
        const dir = repo();
        const run = git(dir);
        const [wt] = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1"]);
        assert.deepEqual(linkSharedPaths(dir, wt.path), []);
        removeWaveWorktrees(run, [wt]);
    });

    it("never shadows a tracked path git already placed", () => {
        // `vendor/` is tracked in plenty of Go repos. Replacing the worktree's
        // real copy with a symlink to the main tree would undo the isolation for
        // exactly the files being changed.
        const dir = repo();
        mkdirSync(join(dir, "vendor"));
        writeFileSync(join(dir, "vendor", "v.txt"), "tracked\n");
        const run = git(dir);
        run(["add", "-A"]);
        run(["commit", "-q", "-m", "vendor"]);
        const [wt] = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1"]);
        assert.ok(!linkSharedPaths(dir, wt.path).includes("vendor"));
        assert.ok(!lstatSync(join(wt.path, "vendor")).isSymbolicLink());
        removeWaveWorktrees(run, [wt]);
    });

    it("covers the ecosystems the harness actually meets", () => {
        for (const p of ["node_modules", ".env", "vendor", ".venv", "target"])
            assert.ok(SHARED_WORKTREE_PATHS.includes(p), p);
    });
});

describe("excludeWorktreeDir keeps the checkouts out of the repo's history", () => {
    // `.agent/` is untracked-but-not-IGNORED in the projects this runs against.
    // Without the exclude, a coordinator checkpoint using `git add -A` commits
    // every worker's entire checkout — the repo inside itself, once per worker.
    it("makes the worktree dir invisible to git status", () => {
        const dir = repo();
        const run = git(dir);
        excludeWorktreeDir(run(["rev-parse", "--absolute-git-dir"]));
        mkdirSync(join(dir, ".agent", "worktrees", "w1"), { recursive: true });
        writeFileSync(join(dir, ".agent", "worktrees", "w1", "junk.txt"), "x");
        assert.equal(run(["status", "--porcelain"]), "");
    });

    it("writes to .git/info/exclude, not the project's .gitignore", () => {
        // A run must not leave a diff in a tracked file the user did not ask for.
        const dir = repo();
        const run = git(dir);
        excludeWorktreeDir(run(["rev-parse", "--absolute-git-dir"]));
        assert.ok(existsSync(join(dir, ".git", "info", "exclude")));
        assert.ok(!existsSync(join(dir, ".gitignore")));
    });

    it("is idempotent across runs", () => {
        const dir = repo();
        const run = git(dir);
        const gitDir = run(["rev-parse", "--absolute-git-dir"]);
        excludeWorktreeDir(gitDir);
        excludeWorktreeDir(gitDir);
        const lines = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8")
            .split("\n")
            .filter((l) => l.includes("worktrees"));
        assert.equal(lines.length, 1);
    });

    it("never throws on an unwritable git dir", () => {
        excludeWorktreeDir("/proc/nonexistent/nope");
    });
});

describe("a worker's .agent scratch never merges back", () => {
    it("excludes .agent from the worker's commit", () => {
        // The coordinator owns the ledger. Merging a worker's private copy of it
        // would overwrite the real one with a partial view.
        const dir = repo();
        const run = git(dir);
        const [wt] = createWaveWorktrees(run, dir, run(["rev-parse", "HEAD"]), ["w1"]);
        mkdirSync(join(wt.path, ".agent"), { recursive: true });
        writeFileSync(join(wt.path, ".agent", "progress.md"), "worker's view\n");
        writeFileSync(join(wt.path, "a.txt"), "real work\n");

        const c = collectWorktreeChanges(git, wt);
        assert.deepEqual(c.files, ["a.txt"]);
        assert.ok(!c.files.some((f) => f.startsWith(".agent")));
        removeWaveWorktrees(run, [wt]);
    });
});
