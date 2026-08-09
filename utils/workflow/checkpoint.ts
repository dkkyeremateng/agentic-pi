// ABOUTME: Workspace checkpoint/revert helpers for the agent workflow. Before a
// run_agent_workflow run we snapshot the repo (HEAD + a `git stash create` of any
// uncommitted work); /revert restores that snapshot (after backing up the current
// state). Git side-effects are injected as a `GitRunner` so the logic is pure and
// unit-testable; the extension supplies a real runner (execFileSync).

export interface Checkpoint {
    head: string; // HEAD sha before the run ("" when the repo has no commits yet)
    snapshot: string; // `git stash create` sha of pre-run uncommitted work ("" if clean)
    branch: string; // branch name (or detached sha) for display
    takenAt: number; // epoch ms
    request: string; // the workflow request that triggered the checkpoint
}

// Runs a git command and returns trimmed stdout; throws on non-zero exit.
export type GitRunner = (args: string[]) => string;

export function isGitRepo(run: GitRunner): boolean {
    try {
        return run(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
        return false;
    }
}

// Capture the current repo state. Returns null when not inside a git work tree.
// `head` is "" for a repo with no commits; `snapshot` is "" when the tree is clean.
export function createCheckpoint(
    run: GitRunner,
    request: string,
    now: number = Date.now(),
): Checkpoint | null {
    if (!isGitRepo(run)) return null;
    const safe = (args: string[]): string => {
        try {
            return run(args);
        } catch {
            return "";
        }
    };
    const head = safe(["rev-parse", "HEAD"]);
    const branch = safe(["rev-parse", "--abbrev-ref", "HEAD"]);
    const snapshot = safe(["stash", "create"]);
    // `stash create` builds a DANGLING commit: nothing references it, so `git gc`
    // (or the two-week unreachable-object expiry) can prune it, after which
    // /revert's `stash apply <sha>` throws and the pre-run uncommitted work is
    // gone for good. `stash store` puts it in the stash reflog — making it
    // reachable — without touching the working tree or the index.
    if (snapshot) safe(["stash", "store", "-m", "pre-run checkpoint", snapshot]);
    return { head, branch, snapshot, takenAt: now, request };
}

// True when a recorded checkpoint branch is a real branch we can switch back to.
// `rev-parse --abbrev-ref HEAD` yields the literal "HEAD" on a detached HEAD, and
// older checkpoints may carry an empty string.
function isRealBranch(branch: string): boolean {
    return branch !== "" && branch !== "HEAD";
}

// The ordered git commands that restore `cp` (run after backing up current state):
// return to the checkpoint's branch, undo commits made since the checkpoint, then
// re-apply the pre-run uncommitted work. Untracked files are intentionally NOT
// removed (too destructive to do automatically) — the caller surfaces that caveat.
//
// The switch comes FIRST and matters: a run that started on main but moved to
// agent/<slug> would otherwise `reset --hard <main's old tip>` while still ON the
// agent branch, force-rewriting that branch (and any PR opened from it) and
// leaving the user off the branch they checkpointed.
//
// `--force` (a.k.a. --discard-changes) is required, not incidental: the caller
// backs the tree up with `stash create` + `stash store`, which — unlike
// `stash push` — leaves the working tree DIRTY. A plain `switch` would abort on
// "local changes would be overwritten" and take the whole revert down with it,
// and those changes are exactly what the `reset --hard` on the next line
// discards anyway.
export function revertCommands(cp: Checkpoint): string[][] {
    const cmds: string[][] = [];
    if (isRealBranch(cp.branch)) cmds.push(["switch", "--force", cp.branch]);
    if (cp.head) cmds.push(["reset", "--hard", cp.head]);
    if (cp.snapshot) cmds.push(["stash", "apply", cp.snapshot]);
    return cmds;
}

// ── Work branch ──────────────────────────────────
// So the implementer's per-phase commits never land on the default branch, the
// orchestrator switches to a dedicated work branch BEFORE the implement phase
// (the implementer no longer does this itself — a prompt can be skipped, code
// can't). Git side-effects go through the injected GitRunner so this is unit-
// testable; the extension supplies the real runner.

const DEFAULT_BRANCHES = new Set(["main", "master"]);

// Turn a request into a safe branch slug: lowercase, non-alphanumerics to dashes,
// collapsed and trimmed, capped. Falls back to "run" when nothing usable remains.
export function slugifyBranch(request: string): string {
    const s = request
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    return s || "run";
}

// True when `branch` is the repo's default branch — main/master, or whatever
// origin/HEAD points at when that differs.
export function isDefaultBranch(run: GitRunner, branch: string): boolean {
    if (DEFAULT_BRANCHES.has(branch)) return true;
    try {
        const head = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        const def = head.replace(/^origin\//, "").trim();
        return def !== "" && def === branch;
    } catch {
        return false;
    }
}

// A branch this workflow created for a prior run (see ensureWorkBranch's naming).
export function isAgentBranch(branch: string): boolean {
    return branch.startsWith("agent/");
}

// The repo's default branch name: origin/HEAD if set, else whichever of
// main/master actually exists, else "" (unknown).
export function defaultBranchName(run: GitRunner): string {
    try {
        const head = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        const def = head.replace(/^origin\//, "").trim();
        if (def) return def;
    } catch {}
    for (const cand of ["main", "master"]) {
        try {
            if (run(["rev-parse", "--verify", "--quiet", cand]).trim()) return cand;
        } catch {}
    }
    return "";
}

// Ensure the run is on a fresh work branch and report the base sha (HEAD at this
// point — the squash/revert floor). Behavior by current branch:
//   - default branch (main/master/origin HEAD) → create+switch agent/<slug>-<sha>
//   - a PRIOR agent branch (agent/…)           → switch back to the default
//        branch, then branch fresh — so a new requirement never stacks onto the
//        finished run's branch (which, with its commits/PR, is left intact)
//   - the user's own non-default branch        → reuse it (don't disturb it)
//   - a detached HEAD (not a branch at all)    → create+switch agent/<slug>-<sha>
// Returns null when branching doesn't apply or fails — not a git repo, a repo
// with no commits yet, or a default branch we could not switch off — in which
// case the caller records no Base and the implementer skips per-phase commits
// (so work never lands on the default branch).
export function ensureWorkBranch(
    run: GitRunner,
    request: string,
): { branch: string; base: string; created: boolean } | null {
    if (!isGitRepo(run)) return null;
    const safe = (args: string[]): string => {
        try {
            return run(args);
        } catch {
            return "";
        }
    };
    if (!safe(["rev-parse", "HEAD"])) return null; // no commits yet — nothing to branch from

    // A detached HEAD reports the literal "HEAD" here — NOT a branch. Treating it
    // as the user's own branch let the run commit while detached, orphaning every
    // commit at the next checkout; fall through instead and cut agent/<slug>-<sha>
    // from the detached sha (`switch -c` works fine from a detached HEAD).
    const current = safe(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (isRealBranch(current) && !isDefaultBranch(run, current)) {
        // Off the default branch already. If it's the user's own branch, respect
        // it and build there. If it's a PRIOR agent run's branch, don't stack a
        // new requirement onto it — switch back to the default branch and start
        // fresh (the old branch, its commits, and any PR are left intact).
        if (!isAgentBranch(current)) {
            return { branch: current, base: safe(["rev-parse", "HEAD"]), created: false };
        }
        const def = defaultBranchName(run);
        if (!def) {
            return { branch: current, base: safe(["rev-parse", "HEAD"]), created: false };
        }
        try {
            run(["switch", def]);
            // now on the default branch — fall through to branch fresh from it
        } catch {
            return { branch: current, base: safe(["rev-parse", "HEAD"]), created: false };
        }
    }

    const base = safe(["rev-parse", "HEAD"]);
    if (!base) return null;
    const branch = `agent/${slugifyBranch(request)}-${base.slice(0, 7)}`;
    try {
        run(["switch", "-c", branch]);
        return { branch, base, created: true };
    } catch {
        // Branch already exists (e.g. an identical re-run) — switch onto it.
        try {
            run(["switch", branch]);
            return { branch, base, created: true };
        } catch {
            // Could not leave the default branch. Return null rather than the
            // default branch, so the caller records no Base and the implementer
            // skips per-phase commits — work stays uncommitted (the shipper
            // branches at the end) and never lands on the default branch.
            return null;
        }
    }
}

// One-line human description of a checkpoint for the confirm prompt / report.
export function describeCheckpoint(cp: Checkpoint): string {
    const when = new Date(cp.takenAt).toLocaleString();
    const at = cp.head ? cp.head.slice(0, 8) : "(no commits)";
    const dirty = cp.snapshot ? " + uncommitted changes" : "";
    const req = cp.request ? ` — "${cp.request.slice(0, 60)}"` : "";
    return `${cp.branch || "HEAD"} @ ${at}${dirty} (taken ${when})${req}`;
}
