// ABOUTME: Tiny, dependency-light helper for confining file access to a cwd.
// Used by extensions/cwd-guard.ts (loaded into sub-agents) — kept separate from
// workflow-core so the guard stays lightweight (only imports `path`).

import { isAbsolute, resolve, relative, sep } from "path";

// True if `p` resolves to a location OUTSIDE `cwd` (a parent, sibling, or absolute
// path elsewhere). Relative paths are resolved against `cwd`. Lexical only — it does
// not follow symlinks, so a symlink inside cwd that points outside is not caught.
export function isOutsideCwd(cwd: string, p: string): boolean {
    if (!p) return false;
    try {
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        const rel = relative(resolve(cwd), abs);
        return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
    } catch {
        return false; // fail open — this is a guardrail, not a hard sandbox
    }
}

// True if `p` resolves INSIDE at least one of `roots` (falsy roots are ignored).
// Used to allow read-only access to extra trusted roots (e.g. the skills dir)
// even when they sit outside the cwd. Relative paths resolve against the FIRST
// root (the cwd) for the membership test.
export function isWithinAny(roots: (string | undefined)[], p: string): boolean {
    return roots.some((r) => !!r && !isOutsideCwd(r, p));
}
