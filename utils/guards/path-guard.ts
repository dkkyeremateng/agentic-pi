// ABOUTME: Tiny, dependency-light helper for confining file access to a cwd.
// Used by extensions/cwd-guard.ts (loaded into sub-agents) — kept separate from
// workflow-core so the guard stays lightweight (only imports `path`/`os`).

import { isAbsolute, join, resolve, relative, sep } from "path";
import { homedir } from "os";

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

// The skill roots read-only tools may reach even when they sit outside the cwd:
// the repo's bundled skills (`bundledSkillsDir`), pi's GLOBAL skills —
// getAgentDir()/skills ($PI_CODING_AGENT_DIR, tilde-expanded, or ~/.pi/agent) and
// the legacy ~/.pi/skills — and the skills that arrive with INSTALLED PACKAGES.
//
// That last root is the one this list was missing, and its absence made every
// package-provided skill unreadable. `pi install npm:<pkg>` puts a package under
// `<agentDir>/npm/node_modules/<pkg>/`, so its skills live at
// `<agentDir>/npm/node_modules/<pkg>/skills/<name>/SKILL.md` — outside all three
// roots above. pi still advertises those skills to every agent WITH their real
// path, so an agent would follow the instruction it was given and get blocked by
// us. Observed live on run-mte9oayl-nlqlm: three reads of pi-context's
// `context-management` skill refused, in a run where nothing was wrong except
// this list.
//
// The whole node_modules tree is allowed rather than each package's `skills/`
// subdirectory, because packages can be installed mid-session and enumerating
// them at guard-construction time would go stale. The exposure is proportionate:
// these roots gate READ-ONLY tools only (writes stay confined to the cwd), and
// the tree holds packages the user installed into their own pi.
//
// Single source of truth shared by the sub-agent spawn
// (workflow-core.subagentExtArgs, which exports them via PI_SKILLS_DIR) and
// extensions/cwd-guard.ts (which falls back to this when run standalone, with no
// PI_SKILLS_DIR set) — so the two can never drift.
export function defaultSkillRoots(bundledSkillsDir: string): string[] {
    const expand = (p: string) =>
        p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    const agentDir = process.env.PI_CODING_AGENT_DIR
        ? expand(process.env.PI_CODING_AGENT_DIR)
        : join(homedir(), ".pi", "agent");
    return [
        bundledSkillsDir,
        join(agentDir, "skills"),
        join(agentDir, "npm", "node_modules"),
        join(homedir(), ".pi", "skills"),
    ];
}
