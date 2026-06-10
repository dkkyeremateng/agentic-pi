// ABOUTME: Pure policy for the read-only agent guard (extensions/readonly-guard.ts).
// ABOUTME: Classifies the `gh` and `git` invocations inside a bash command as
// ABOUTME: read-only or mutating, so the guard can block state-changing ones.

// Every mutating `gh`/`git` invocation in the bash command, as readable strings.
// Empty when the command runs neither, or only read-only ones. Other tools are not
// policed here. (Exported first so node's type-stripping `--check` detects this as
// an ES module before the typed consts below.)
export function blockedCommands(cmd: string): string[] {
    if (typeof cmd !== "string" || !/\b(gh|git)\b/.test(cmd)) return [];
    const bad: string[] = [];
    for (const seg of segments(cmd)) {
        const toks = commandTokens(seg);
        const head = toks[0] || "";
        const rest = toks.slice(1);
        if (head === "gh" || head.endsWith("/gh")) {
            if (!ghArgsReadOnly(rest)) bad.push(["gh", ...rest].join(" "));
        } else if (head === "git" || head.endsWith("/git")) {
            if (!gitArgsReadOnly(rest)) bad.push(["git", ...rest].join(" "));
        }
    }
    return bad;
}

// Classify the tokens AFTER `gh`. Empty (bare `gh`, `gh --version`/`--help`) is
// read-only. The first two non-flag tokens are the command (noun) and verb.
export function ghArgsReadOnly(rest: string[]): boolean {
    const words = rest.filter((t) => !t.startsWith("-"));
    const noun = (words[0] || "").toLowerCase();
    if (!noun) return true; // bare `gh`, or only flags (e.g. `gh --version`)
    if (noun === "api") return apiIsReadOnly(rest);
    if (GH_READONLY_ALL.has(noun)) return true;
    const allowed = GH_READONLY_VERBS[noun];
    if (!allowed) return false; // unknown/unlisted command → deny
    return allowed.has((words[1] || "").toLowerCase());
}

// Classify the tokens AFTER `git`. Unlike gh this is a DENYLIST: read-only agents
// lean heavily on git reads (diff/log/show/status/rev-parse/blame/ls-files), so the
// default is allow and only known mutating subcommands are blocked. A few are
// context-sensitive (remote, config, stash, branch, tag) — their list/show/get/
// inspection forms are reads, while creates/deletes/moves (including a bare-positional
// `git branch <name>` / `git tag <name>` create) are blocked.
export function gitArgsReadOnly(rest: string[]): boolean {
    const i = gitSubcommandIndex(rest);
    if (i === -1) return true; // bare `git` / only global flags
    const sub = rest[i].toLowerCase();
    const args = rest.slice(i + 1);
    const firstWord = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();

    if (GIT_ALWAYS_MUTATING.has(sub)) return false;
    if (sub === "stash") return firstWord === "list" || firstWord === "show";
    if (sub === "remote") return !GIT_REMOTE_MUTATING.has(firstWord);
    if (sub === "branch") return gitRefCmdReadOnly(args, GIT_BRANCH_MUTATING_FLAGS);
    if (sub === "tag") return gitRefCmdReadOnly(args, GIT_TAG_MUTATING_FLAGS);
    if (sub === "config") {
        const joined = args.join(" ");
        if (
            /(?:^|\s)--(add|unset|unset-all|replace-all|remove-section|rename-section|edit)\b/.test(
                joined,
            )
        )
            return false;
        // Setting a value (key + value) writes; a lone key, --get*, or --list reads.
        return args.filter((a) => !a.startsWith("-")).length < 2;
    }
    return true; // not a mutating subcommand
}

// gh: read-only verbs per command (anything else → deny).
const GH_READONLY_VERBS: Record<string, Set<string>> = {
    pr: new Set(["view", "diff", "checks", "list", "status"]),
    issue: new Set(["view", "list", "status"]),
    run: new Set(["view", "list", "watch"]),
    repo: new Set(["view", "list"]),
    release: new Set(["view", "list", "download"]),
    workflow: new Set(["view", "list"]),
    cache: new Set(["list"]),
    label: new Set(["list"]),
    secret: new Set(["list"]),
    variable: new Set(["list"]),
    gist: new Set(["view", "list"]),
    auth: new Set(["status", "token"]),
};

// gh commands that are read-only in their entirety (any verb), e.g. `gh search`.
const GH_READONLY_ALL = new Set(["search", "status", "browse"]);

// git subcommands that always mutate local and/or remote state.
const GIT_ALWAYS_MUTATING = new Set([
    "push", "commit", "merge", "rebase", "reset", "revert", "cherry-pick",
    "am", "pull", "fetch", "checkout", "switch", "restore", "clean", "rm",
    "mv", "apply", "init", "clone", "gc", "prune", "worktree", "update-ref",
    "filter-branch", "fast-import", "repack",
]);

// `git remote <verb>` forms that mutate (else bare/-v/show/get-url are reads).
const GIT_REMOTE_MUTATING = new Set([
    "add", "remove", "rm", "rename", "set-url", "set-head", "set-branches",
    "prune", "update",
]);

// `git branch`/`git tag` flags that unambiguously create, delete, move, force, or
// re-point a ref. The list/inspection flags (-a, -r, -l, -v, --contains,
// --merged, --points-at, …) are absent, so reads pass.
const GIT_BRANCH_MUTATING_FLAGS = new Set([
    "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy",
    "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream",
    "--edit-description",
]);
const GIT_TAG_MUTATING_FLAGS = new Set([
    "-d", "--delete", "-a", "--annotate", "-s", "--sign", "-m", "--message",
    "-F", "--file", "-f", "--force", "-u", "--local-user", "--create-reflog",
]);

// git global options that consume the following token as their value, so the
// subcommand scanner can skip past them (e.g. `git -C <path> log`).
const GIT_GLOBAL_VALUE_FLAGS = new Set([
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
    "--config-env", "--super-prefix",
]);

// Index of the git subcommand token, skipping leading global options (and the
// values of value-taking ones). -1 when there is no subcommand.
function gitSubcommandIndex(rest: string[]): number {
    let i = 0;
    while (i < rest.length) {
        const t = rest[i];
        if (!t.startsWith("-")) return i;
        if (t.includes("=")) i += 1; // --flag=value
        else if (GIT_GLOBAL_VALUE_FLAGS.has(t)) i += 2; // flag + value
        else i += 1; // value-less global flag
    }
    return -1;
}

// Is a `gh api ...` call read-only? GET is gh's default; an explicit mutating
// method or POST-implying field flags make it a write. GraphQL reads legitimately
// use `-f query=...`, so for `gh api graphql` only an actual `mutation` is a write.
function apiIsReadOnly(rest: string[]): boolean {
    const joined = rest.join(" ");
    if (/(?:^|\s)(?:-X|--method)[\s=]+(?:post|put|patch|delete)\b/i.test(joined))
        return false;
    if (rest.includes("graphql")) return !/\bmutation\b/i.test(joined);
    return !/(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/i.test(joined);
}

// Split a bash command into simple-command segments (best-effort; bash is not fully
// parseable) so each invocation can be classified independently. Splits on command
// separators, pipes, and subshell/group punctuation.
function segments(cmd: string): string[] {
    return cmd
        .replace(/\$\(/g, " ")
        .split(/[|&;\n`(){}]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

// True if any token is one of `flags` (matching `--flag` and `--flag=value`).
function hasAnyFlag(args: string[], flags: Set<string>): boolean {
    return args.some((a) => a.startsWith("-") && flags.has(a.split("=")[0]));
}

// Read-only check for `git branch`/`git tag`. A destructive/create FLAG blocks. A
// plain create takes NO flags (`git branch <name> [start]`, `git tag <name>`), so any
// other flag means list/inspection mode (`--contains <sha>`, `-l <pat>`, `--sort
// <key>`, …) and reads. With no flags, a positional is a new ref name → create →
// block; none is a bare list → allow.
function gitRefCmdReadOnly(args: string[], mutatingFlags: Set<string>): boolean {
    if (hasAnyFlag(args, mutatingFlags)) return false;
    if (args.some((a) => a.startsWith("-"))) return true;
    return args.length === 0; // no flags + a positional ref name = create → block
}

// Drop leading `VAR=value` env assignments, returning the command's tokens.
function commandTokens(seg: string): string[] {
    const toks = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    return toks.slice(i);
}
