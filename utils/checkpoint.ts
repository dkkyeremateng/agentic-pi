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

// One-line human description of a checkpoint for the confirm prompt / report.
export function describeCheckpoint(cp: Checkpoint): string {
    const when = new Date(cp.takenAt).toLocaleString();
    const at = cp.head ? cp.head.slice(0, 8) : "(no commits)";
    const dirty = cp.snapshot ? " + uncommitted changes" : "";
    const req = cp.request ? ` — "${cp.request.slice(0, 60)}"` : "";
    return `${cp.branch || "HEAD"} @ ${at}${dirty} (taken ${when})${req}`;
}
