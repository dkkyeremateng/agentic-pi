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

// Shell constructs that write a file directly, bypassing the `write`/`edit` tools
// and therefore every guard watching them. Observed live: a `read-only-bash`
// roadmapper reached for `sed -i` to fix a typo in its own deliverable. Harmless in
// that instance — it may write that file — but the same move lets any read-only
// agent rewrite anything in the tree, which is precisely what the guard exists to
// prevent.
//
// Deliberately narrow. Only constructs with no legitimate read-only use are listed:
// `mkdir`/`touch`/`cp` are NOT here, because a validator's test setup may run them
// and a false block would break a real run — a worse trade than the leak it closes.
export function blockedFileWrites(cmd: string): string[] {
    if (typeof cmd !== "string" || !cmd.trim()) return [];
    const bad: string[] = [];
    for (const seg of segments(cmd)) {
        const toks = commandTokens(seg);
        const head = toks[0] || "";
        const base = head.includes("/")
            ? head.slice(head.lastIndexOf("/") + 1)
            : head;
        const rest = toks.slice(1);

        // In-place stream editing: `sed -i`, `sed -i ''`, `sed -i.bak`, `perl -i`.
        if (INPLACE_TOOLS.has(base) && rest.some((t) => /^-[a-zA-Z]*i/.test(t))) {
            bad.push(`${base} -i (in-place file edit)`);
        } else if (base === "tee") {
            // `| tee file` writes; `| tee /dev/null` is a no-op sink.
            const targets = rest.filter((t) => !t.startsWith("-"));
            if (targets.some((t) => !isNullSink(t)))
                bad.push(`tee ${targets.join(" ")}`);
        } else if (ALWAYS_WRITES.has(base)) {
            bad.push(toks.join(" "));
        } else if (base === "dd" && rest.some((t) => t.startsWith("of="))) {
            bad.push(toks.join(" "));
        }

        const redir = redirectTarget(seg);
        if (redir) bad.push(`> ${redir} (shell redirection to a file)`);
    }
    return bad;
}

// Stream editors/interpreters whose `-i` flag rewrites the input file in place.
const INPLACE_TOOLS = new Set(["sed", "perl", "ruby", "gawk"]);

// Commands whose entire purpose is to modify file contents.
const ALWAYS_WRITES = new Set(["truncate", "shred", "patch"]);

function isNullSink(t: string): boolean {
    return t === "/dev/null";
}

// The first `>`/`>>` redirection whose target is a real file. Skips fd duplication
// (`2>&1`, `>&2` — `&` is excluded from the target class so they never match) and
// the standard null/std sinks, which read-only agents use constantly.
function redirectTarget(seg: string): string | null {
    const re = /(?:^|\s)\d?>>?\s*([^\s|&;<>]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg))) {
        const target = m[1];
        if (/^\/dev\/(null|stdout|stderr|fd\/\d+|tty)$/.test(target)) continue;
        return target;
    }
    return null;
}

// Commands that bring a repository into existence, or repoint one at a new remote.
// Blocked for EVERY workflow agent, including write-capable ones: where a project's
// history begins, and where it pushes, is the user's decision — never a side effect
// of a build run. An unasked-for `git init` is also awkward to undo cleanly once
// commits land on top of it.
//
// Read-only agents are already covered by blockedCommands (git init and
// `git remote add` are mutating, `gh repo create` is not an allowlisted verb); this
// exists for the agents that legitimately mutate git — the implementer and the
// shipper — which otherwise load no guard at all.
export function blockedRepoCreation(cmd: string): string[] {
    if (typeof cmd !== "string" || !/\b(git|gh)\b/.test(cmd)) return [];
    const bad: string[] = [];
    for (const seg of segments(cmd)) {
        const toks = commandTokens(seg);
        const head = toks[0] || "";
        const base = head.includes("/")
            ? head.slice(head.lastIndexOf("/") + 1)
            : head;
        const rest = toks.slice(1);
        const words = rest.filter((t) => !t.startsWith("-"));
        if (base === "git") {
            const i = gitSubcommandIndex(rest);
            if (i === -1) continue;
            const sub = rest[i].toLowerCase();
            const after = rest.slice(i + 1).filter((t) => !t.startsWith("-"));
            if (sub === "init") bad.push("git init");
            else if (sub === "remote" && (after[0] || "").toLowerCase() === "add")
                bad.push("git remote add");
        } else if (base === "gh") {
            if (
                (words[0] || "").toLowerCase() === "repo" &&
                (words[1] || "").toLowerCase() === "create"
            )
                bad.push("gh repo create");
        }
    }
    return bad;
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
    // `-X` takes its value glued (`-XPOST`) or separated (`-X POST` / `-X=POST`);
    // `--method` separates with a space or `=`. The old `[\s=]+` missed the glued
    // `-XPOST` form, so `gh api -XPOST …` slipped through as read-only.
    if (/(?:^|\s)(?:-X[\s=]*|--method[\s=]+)(?:post|put|patch|delete)\b/i.test(joined))
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

// Command prefixes that merely exec another command. Peeling them exposes a gh/git
// call hidden behind `env FOO=b gh …`, `command gh …`, `nohup gh …`,
// `timeout 5 gh …`, `nice git push`, so it's still classified instead of slipping
// through as an unpoliced head.
const EXEC_WRAPPERS = new Set(["env", "command", "builtin", "exec", "nohup", "setsid", "nice", "timeout"]);
// Wrapper option flags that consume the FOLLOWING token as their value (so the
// scanner skips the value too, not just the flag).
const WRAPPER_VALUE_FLAGS = new Set([
    "-u", "--unset", "-C", "--chdir", "-n", "--adjustment", "-s", "--signal", "-k", "--kill-after",
]);

// Return the real command tokens for a segment: drop leading `VAR=value` env
// assignments, then peel any exec-wrapper prefixes (env/command/nohup/timeout/…)
// so the underlying gh/git invocation is what gets classified. Best-effort — bash
// isn't fully parseable — and it only ever REVEALS a command, never turns a read
// into a block.
function commandTokens(seg: string): string[] {
    let toks = seg.split(/\s+/).filter(Boolean);
    for (let guard = 0; guard < 8 && toks.length; guard++) {
        let i = 0;
        while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // VAR=value
        toks = toks.slice(i);
        const head = toks[0] || "";
        const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
        if (!EXEC_WRAPPERS.has(base)) break;
        let j = 1;
        let sawDuration = false;
        while (j < toks.length) {
            const t = toks[j];
            if (t === "--") { j++; break; }
            if (t.startsWith("-")) {
                j += WRAPPER_VALUE_FLAGS.has(t) ? 2 : 1;
                continue;
            }
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { j++; continue; } // env VAR=value
            if (base === "timeout" && !sawDuration) { sawDuration = true; j++; continue; } // DURATION positional
            break; // the wrapped command starts here
        }
        toks = toks.slice(j);
    }
    return toks;
}

// Searches rooted at the filesystem root. `find / …` walks every mounted volume,
// every node_modules and every permission-denied branch, and in an agent run it
// is always the wrong instrument: the thing being looked for is in the working
// directory, in a known package path, or nowhere.
//
// Measured over a month of runs (2026-07-27 -> 08-27): 24 such calls burned
// **4347 seconds** — 1.2 hours — at 5 to 9 minutes each, hunting things like a
// SKILL.md and a vendored .go file. Every one of them was a `find /`.
//
// Deliberately narrow: the root must be EXACTLY `/`. `find /Users/me/project`
// and `find .` are ordinary and pass untouched, so this cannot block a scoped
// search that merely happens to be absolute.
export function blockedRootSearch(cmd: string): string[] {
    if (typeof cmd !== "string" || !/\bfind\b/.test(cmd)) return [];
    const bad: string[] = [];
    for (const seg of segments(cmd)) {
        const toks = commandTokens(seg);
        const head = toks[0] || "";
        const base = head.includes("/")
            ? head.slice(head.lastIndexOf("/") + 1)
            : head;
        if (base !== "find") continue;
        // The search roots are the leading non-flag operands, before the first
        // predicate (`-name`, `-path`, …). Any one of them being "/" is enough.
        for (const t of toks.slice(1)) {
            if (t.startsWith("-")) break;
            if (t === "/") {
                bad.push("find /");
                break;
            }
        }
    }
    return bad;
}
