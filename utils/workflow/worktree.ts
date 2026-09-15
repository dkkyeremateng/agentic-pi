// ABOUTME: Ephemeral git worktrees so a parallel wave stops sharing one tree.
//
// The problem. `dispatch_parallel` spawns every worker with the same `cwd`, and
// the only thing keeping them apart is a sentence in the agent prompts: "touch
// only the files your task names". When that holds, nothing happens. When it
// does not, two workers write one file and the later write wins silently — no
// error, no conflict, just a file holding half of each phase's intent. The
// collision detector added alongside this WARNS about it after the fact; a
// worktree per worker prevents it, and turns an invisible clobber into a
// reported overlap.
//
// WHY THIS IS OPT-IN AND DEFAULTS OFF.
//
// A fresh worktree contains only tracked files. It has no `node_modules`, no
// `.env`, no build cache, no `.agent/`. For a Go repo that is fine — the module
// cache is global. For a Node repo the first `npm test` fails instantly, and the
// isolation is strictly worse than the race it prevents. `linkSharedPaths`
// mitigates the common cases by symlinking them in, but "the common cases" is a
// guess until it has been run against real projects. So: PI_WORKTREE_ISOLATION=1
// turns it on, and every failure below degrades to the shared tree rather than
// failing the wave.
//
// WHY THE MERGE LOOKS LIKE THIS.
//
// Workers do not commit — the coordinator owns the ledger and the checkpoints
// (see agents/implementer.md), so a worker leaves uncommitted changes behind.
// That rules out the obvious "cherry-pick each worker's commits". Instead the
// harness commits on the worker's behalf inside its own worktree (infrastructure
// bookkeeping, not the agent's), and the wave then materialises those paths into
// the main tree. Worktrees share one object store, so a commit made in one is
// immediately reachable from the other with no fetch.

import {
    existsSync,
    symlinkSync,
    lstatSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "./checkpoint";

/** Paths that are gitignored but that a worker almost always needs. Symlinked
 *  into each worktree so the isolation does not cost a reinstall. */
export const SHARED_WORKTREE_PATHS = [
    "node_modules",
    ".env",
    "vendor",
    ".venv",
    "target",
    ".gradle",
    "__pycache__",
];

/**
 * Symlink the gitignored paths a worker needs into its worktree.
 *
 * This is what makes worktree isolation usable at all. `git worktree add` copies
 * only TRACKED files, so a fresh worktree of a Node project has no
 * `node_modules` and `npm test` fails on the first command — isolation that
 * breaks every worker is worse than the race it prevents.
 *
 * Symlinks, not copies: `node_modules` is routinely gigabytes, and every worker
 * in the wave wants the same one. That does mean workers SHARE these paths, so
 * the isolation covers tracked source only — which is the contended surface. A
 * worker that writes into `node_modules` still races, and nothing here pretends
 * otherwise.
 *
 * Best-effort per path. A missing source is the normal case (most repos have
 * only one or two of these) and is not an error.
 */
export function linkSharedPaths(
    repoRoot: string,
    worktreePath: string,
    names: string[] = SHARED_WORKTREE_PATHS,
): string[] {
    const linked: string[] = [];
    for (const name of names) {
        const src = join(repoRoot, name);
        const dest = join(worktreePath, name);
        try {
            if (!existsSync(src)) continue;
            // Never shadow something the worktree legitimately has: if the path
            // is tracked, git already put the real thing there.
            if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false }))
                continue;
            symlinkSync(src, dest);
            linked.push(name);
        } catch {
            /* a link we could not make is a path the worker does without */
        }
    }
    return linked;
}

export interface WaveWorktree {
    /** Index of the item in the wave, so results map back to their worker. */
    index: number;
    /** Absolute path the worker should run in. */
    path: string;
    /** The branch created for it, removed on cleanup. */
    branch: string;
}

export interface WorktreeChanges {
    index: number;
    /** Paths the worker changed, relative to the repo root. */
    files: string[];
    /** Paths it deleted — `checkout <sha> -- <path>` cannot materialise these. */
    deleted: string[];
    /** The commit holding its work, or "" when it changed nothing. */
    sha: string;
}

/** Whether to isolate parallel workers. Off unless explicitly enabled — see the
 *  header for why this is not the default. */
export function worktreeIsolationEnabled(env = process.env): boolean {
    const v = (env.PI_WORKTREE_ISOLATION || "").trim().toLowerCase();
    return v === "1" || v === "true";
}

/** Where a wave's worktrees live. Under `.agent/` so an interrupted run leaves
 *  them somewhere obvious and already gitignored. */
export function worktreeRoot(cwd: string): string {
    return `${cwd}/.agent/worktrees`;
}

/**
 * Is this repo in a state where worktrees can be used at all?
 *
 * Needs a git repo with at least one commit: a worktree must branch FROM
 * something. Returns a reason rather than a bare false so the caller can say why
 * it fell back instead of silently doing nothing.
 */
export function worktreeBlocker(run: GitRunner): string | null {
    try {
        if (run(["rev-parse", "--is-inside-work-tree"]) !== "true")
            return "not a git repository";
    } catch {
        return "not a git repository";
    }
    try {
        run(["rev-parse", "HEAD"]);
    } catch {
        return "repository has no commits to branch a worktree from";
    }
    return null;
}

/**
 * Create one worktree per wave item, all branched from `base`.
 *
 * Returns only the ones that succeeded. A partial result is deliberate: a wave
 * where three of four worktrees came up still gains isolation for those three,
 * and the caller runs the fourth in the shared tree. Failing the whole wave
 * because one `git worktree add` failed would make isolation a liability.
 */
/**
 * Keep `.agent/worktrees/` out of the repo's history.
 *
 * `.agent/` is untracked-but-not-ignored in the projects this runs against, so
 * without this a coordinator checkpoint using `git add -A` would commit every
 * worker's entire checkout — the repo, inside itself, once per worker.
 *
 * Written to `.git/info/exclude` rather than `.gitignore`: it is this machine's
 * bookkeeping, not a change to the project, and a run must not leave a diff in a
 * tracked file the user did not ask for.
 */
export function excludeWorktreeDir(gitDir: string): void {
    const file = join(gitDir, "info", "exclude");
    const entry = ".agent/worktrees/";
    try {
        const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
        if (current.split("\n").some((l) => l.trim() === entry)) return;
        mkdirSync(join(gitDir, "info"), { recursive: true });
        writeFileSync(
            file,
            (current && !current.endsWith("\n") ? current + "\n" : current) +
                `${entry}\n`,
        );
    } catch {
        /* an un-excluded worktree dir is untidy, not dangerous enough to fail on */
    }
}

export function createWaveWorktrees(
    run: GitRunner,
    cwd: string,
    base: string,
    ids: string[],
): WaveWorktree[] {
    const out: WaveWorktree[] = [];
    ids.forEach((id, index) => {
        const path = `${worktreeRoot(cwd)}/${id}`;
        const branch = `agent/wt-${id}`;
        try {
            run(["worktree", "add", "--detach", "-f", path, base]);
            out.push({ index, path, branch });
        } catch {
            /* caller falls back to the shared tree for this item */
        }
    });
    return out;
}

/**
 * Commit whatever a worker left behind, and report what it touched.
 *
 * `add -A` picks up new files too: a worker that adds a test file has done real
 * work, and a merge that dropped it would be worse than no isolation. An empty
 * result (`sha: ""`) is normal — plenty of workers only read.
 */
export function collectWorktreeChanges(
    runIn: (path: string) => GitRunner,
    wt: WaveWorktree,
): WorktreeChanges {
    const empty: WorktreeChanges = {
        index: wt.index,
        files: [],
        deleted: [],
        sha: "",
    };
    let run: GitRunner;
    try {
        run = runIn(wt.path);
        // Everything EXCEPT `.agent/`. A worker may write scratch files or a
        // stray ledger copy there; merging those back would overwrite the
        // coordinator's own bookkeeping with a worker's private view of it.
        run(["add", "-A", "--", ".", ":!.agent"]);
    } catch {
        return empty;
    }
    // Read the INDEX, not `status --porcelain`. Status reports everything in the
    // tree, including the `.agent/` the add above deliberately excluded, so the
    // file list disagreed with what the commit actually held. `diff --cached`
    // describes exactly what is about to be committed.
    let staged: string;
    try {
        staged = run(["diff", "--cached", "--name-status", "HEAD"]);
    } catch {
        return empty;
    }
    if (!staged.trim()) return empty;

    const files: string[] = [];
    const deleted: string[] = [];
    for (const raw of staged.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const [code, ...rest] = line.split("\t");
        if (!rest.length) continue;
        // A rename is "R100\told\tnew": the old path is gone, the new one lands.
        if (code.startsWith("R") && rest.length >= 2) {
            deleted.push(unquote(rest[0]));
            files.push(unquote(rest[1]));
            continue;
        }
        const path = unquote(rest[rest.length - 1]);
        if (!path) continue;
        if (code.startsWith("D")) deleted.push(path);
        else files.push(path);
    }
    try {
        run(["commit", "--no-verify", "-m", `wave worker ${wt.index}`]);
        return { index: wt.index, files, deleted, sha: run(["rev-parse", "HEAD"]) };
    } catch {
        return empty;
    }
}

// Git quotes paths containing unusual bytes. Undo that so the path we hand back
// to `checkout -- <path>` is the real one.
function unquote(p: string): string {
    if (!p.startsWith('"') || !p.endsWith('"')) return p;
    try {
        return JSON.parse(p) as string;
    } catch {
        return p.slice(1, -1);
    }
}

export interface MergePlan {
    /** Worker changes that can be applied without stepping on each other. */
    apply: WorktreeChanges[];
    /** file -> the worker indexes that both changed it. */
    conflicts: Map<string, number[]>;
}

/**
 * Decide what is safe to merge back.
 *
 * Disjointness is the whole point. Two workers touching one file is exactly the
 * clobber the shared tree hid; here it surfaces BEFORE anything is written, and
 * neither side is applied, because picking a winner is how the silent version
 * lost data in the first place. The caller reports the conflict and re-runs those
 * phases sequentially.
 */
export function planWaveMerge(changes: WorktreeChanges[]): MergePlan {
    const owners = new Map<string, number[]>();
    for (const c of changes)
        for (const f of [...c.files, ...c.deleted]) {
            const list = owners.get(f) ?? [];
            list.push(c.index);
            owners.set(f, list);
        }
    const conflicts = new Map<string, number[]>();
    for (const [file, idxs] of owners)
        if (new Set(idxs).size > 1) conflicts.set(file, Array.from(new Set(idxs)));
    const contested = new Set(conflicts.keys());
    const apply = changes.filter(
        (c) =>
            c.sha &&
            ![...c.files, ...c.deleted].some((f) => contested.has(f)),
    );
    return { apply, conflicts };
}

/**
 * Materialise the planned changes into the main tree.
 *
 * `checkout <sha> -- <path>` rather than cherry-pick: the paths are proven
 * disjoint by this point, so there is nothing to merge, and checkout cannot
 * produce a conflicted index or a detached HEAD on failure. Deletions need `rm`,
 * since checkout cannot materialise a path that is absent from the commit.
 *
 * Returns the paths that actually landed, so the caller reports what moved
 * rather than asserting it.
 */
export function applyWaveMerge(run: GitRunner, plan: MergePlan): string[] {
    const landed: string[] = [];
    for (const c of plan.apply) {
        for (const f of c.files) {
            try {
                run(["checkout", c.sha, "--", f]);
                landed.push(f);
            } catch {
                /* reported by omission: the caller diffs landed against planned */
            }
        }
        for (const f of c.deleted) {
            try {
                run(["rm", "-q", "--ignore-unmatch", "--", f]);
                landed.push(f);
            } catch {
                /* same */
            }
        }
    }
    return landed;
}

/** Tear down a wave's worktrees. Best-effort and always non-fatal: a leftover
 *  worktree costs disk, while throwing here would fail a wave whose work has
 *  already been merged. */
export function removeWaveWorktrees(
    run: GitRunner,
    worktrees: WaveWorktree[],
): void {
    for (const wt of worktrees) {
        try {
            run(["worktree", "remove", "--force", wt.path]);
        } catch {
            /* fall through to prune */
        }
    }
    try {
        run(["worktree", "prune"]);
    } catch {
        /* nothing to prune, or no git — neither matters here */
    }
}
