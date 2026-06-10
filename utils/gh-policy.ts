// ABOUTME: Pure policy for the read-only GitHub guard (extensions/gh-guard.ts).
// ABOUTME: Classifies the gh invocations inside a bash command as read-only or
// ABOUTME: mutating, default-denying anything not on the small read-only allowlist.

// Every mutating `gh` invocation in the bash command, as readable strings. Empty
// when the command runs no `gh`, or only read-only `gh` commands. `git` and other
// tools are not policed here — this guard is gh-only. (Exported first so node's
// type-stripping `--check` detects this as an ES module before the typed consts.)
export function blockedGhCommands(cmd: string): string[] {
    if (typeof cmd !== "string" || !/\bgh\b/.test(cmd)) return [];
    const bad: string[] = [];
    for (const seg of segments(cmd)) {
        const toks = commandTokens(seg);
        const head = toks[0] || "";
        if (head !== "gh" && !head.endsWith("/gh")) continue;
        const rest = toks.slice(1);
        if (!ghArgsReadOnly(rest)) bad.push(["gh", ...rest].join(" "));
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
    if (READONLY_ALL.has(noun)) return true;
    const allowed = READONLY_VERBS[noun];
    if (!allowed) return false; // unknown/unlisted command → deny
    return allowed.has((words[1] || "").toLowerCase());
}

// Read-only verbs per `gh` command. A command not listed here (and not in
// READONLY_ALL) is treated as mutating (default-deny — safer than enumerating every
// write subcommand).
const READONLY_VERBS: Record<string, Set<string>> = {
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

// Commands that are read-only in their entirety (any verb), e.g. `gh search code`.
const READONLY_ALL = new Set(["search", "status", "browse"]);

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
// parseable) so each `gh` invocation can be classified independently. Splits on
// command separators, pipes, and subshell/group punctuation.
function segments(cmd: string): string[] {
    return cmd
        .replace(/\$\(/g, " ")
        .split(/[|&;\n`(){}]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

// Drop leading `VAR=value` env assignments, returning the command's tokens.
function commandTokens(seg: string): string[] {
    const toks = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    return toks.slice(i);
}
