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
    return {
        head: safe(["rev-parse", "HEAD"]),
        branch: safe(["rev-parse", "--abbrev-ref", "HEAD"]),
        snapshot: safe(["stash", "create"]),
        takenAt: now,
        request,
    };
}

// The ordered git commands that restore `cp` (run after backing up current state):
// undo commits made since the checkpoint, then re-apply the pre-run uncommitted
// work. Untracked files are intentionally NOT removed (too destructive to do
// automatically) — the caller surfaces that caveat.
export function revertCommands(cp: Checkpoint): string[][] {
    const cmds: string[][] = [];
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

// Ensure the run is on a non-default work branch and report the base sha (HEAD at
// this point — the squash/revert floor). Creates+switches a fresh `agent/<slug>`
// branch only when currently on a default branch; otherwise reuses the current
// branch. Returns null when branching doesn't apply or fails — not a git repo, a
// repo with no commits yet, or a default branch we could not switch off — in
// which case the caller records no Base and the implementer skips per-phase
// commits (so work never lands on the default branch).
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
    const base = safe(["rev-parse", "HEAD"]);
    if (!base) return null; // no commits yet — nothing to branch from

    const current = safe(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current && !isDefaultBranch(run, current)) {
        return { branch: current, base, created: false }; // already off the default
    }

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
