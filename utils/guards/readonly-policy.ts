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
    // `submodule foreach` runs an arbitrary command per submodule, so only the two
    // genuine inspection verbs pass.
    if (sub === "submodule") return firstWord === "status" || firstWord === "summary";
    if (sub === "notes") return firstWord === "list" || firstWord === "show";
    if (sub === "reflog") return firstWord !== "expire" && firstWord !== "delete";
    if (sub === "bisect")
        return firstWord === "log" || firstWord === "view" || firstWord === "visualize";
    // `git archive` streams to stdout unless asked for a file.
    if (sub === "archive") return !hasAnyFlag(args, GIT_ARCHIVE_WRITE_FLAGS);
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
// (`2>&1`, `>&2` — `&` is excluded from the lookahead so they never match) and
// the standard null/std sinks, which read-only agents use constantly.
//
// The scan runs over a QUOTE-MASKED copy, because a `>` inside a string is an
// argument, not a redirection. Without that, `grep -n "a > b" src/x.ts`,
// `node -e "console.log(1 > 0)"` and `awk "{ if ($1 > 2) print }" f` were all
// refused as writes — ordinary reading work, blocked by the guard that exists to
// let read-only agents work. A false block costs a run; the leak it would close
// (a redirection hidden inside quotes) is not a redirection at all.
function redirectTarget(seg: string): string | null {
    const masked = maskQuoted(seg);
    // Match up to the START of the target, then read the real (unmasked) word, so
    // a quoted target (`> "my file.txt"`) is reported in full rather than as `"`.
    const re = /(?:^|\s)\d?>>?\s*(?=[^\s|&;<>])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
        const target = readWord(seg, m.index + m[0].length);
        if (!target) continue;
        if (/^\/dev\/(null|stdout|stderr|fd\/\d+|tty)$/.test(target)) continue;
        return target;
    }
    return null;
}

// Replace the CONTENTS of quoted spans with spaces, keeping the quote characters
// and the overall length so offsets into the original stay valid. An unterminated
// quote swallows the rest of the segment, which is what bash does too.
function maskQuoted(s: string): string {
    const out = s.split("");
    let quote: string | null = null;
    for (let i = 0; i < out.length; i++) {
        const ch = out[i];
        if (quote) {
            if (ch === quote) quote = null;
            else out[i] = " ";
            continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
    }
    return out.join("");
}

// Read one shell word starting at `i`, honouring quotes and stripping them.
// Stops at whitespace or a separator that is outside quotes.
function readWord(s: string, i: number): string {
    let out = "";
    while (i < s.length) {
        const ch = s[i];
        if (ch === "'" || ch === '"') {
            const end = s.indexOf(ch, i + 1);
            if (end === -1) return out + s.slice(i + 1);
            out += s.slice(i + 1, end);
            i = end + 1;
            continue;
        }
        if (/[\s|&;<>]/.test(ch)) break;
        out += ch;
        i++;
    }
    return out;
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
    // writes .patch files into the working tree by default
    "format-patch",
]);

// `git archive` flags that send the archive to a FILE instead of stdout.
const GIT_ARCHIVE_WRITE_FLAGS = new Set(["-o", "--output"]);

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
// separators, pipes, and subshell/group punctuation — but only OUTSIDE quotes, so a
// separator inside a string stays part of its argument. A blind character split cut
// `node -e "console.log(1 > 0)"` at the parens and handed `1 > 0` to the redirection
// scanner as if it were a command.
//
// A `sh -c "…"` payload is segmented too and appended, so the command a shell
// wrapper is asked to run is classified rather than hidden behind the wrapper.
function segments(cmd: string, depth = 0): string[] {
    const out = splitTopLevel(cmd);
    if (depth >= 2) return out; // guard against pathological nesting
    const nested: string[] = [];
    for (const seg of out) {
        const toks = commandTokens(seg); // peels sudo/env/… first
        const head = toks[0] || "";
        const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
        if (!SHELL_WRAPPERS.has(base)) continue;
        const i = toks.findIndex((t, n) => n > 0 && /^-[a-z]*c$/.test(t));
        if (i === -1 || !toks[i + 1]) continue;
        nested.push(...segments(toks[i + 1], depth + 1));
    }
    return nested.length ? [...out, ...nested] : out;
}

// Shells whose `-c` argument is another command to classify.
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash"]);

// Characters that end a simple command when they appear outside quotes.
const SEPARATORS = new Set(["|", "&", ";", "\n", "`", "(", ")", "{", "}"]);

// Quote-aware split on SEPARATORS. `$(…)` opens a nested command even inside double
// quotes (that is real bash), so its body is emitted as its own segment and the
// enclosing quote state is restored on the closing paren.
function splitTopLevel(cmd: string): string[] {
    const out: string[] = [];
    const quotes: (string | null)[] = [];
    let cur = "";
    let quote: string | null = null;
    let subDepth = 0;
    const flush = () => {
        const t = cur.trim();
        if (t) out.push(t);
        cur = "";
    };
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote !== "'" && ch === "$" && cmd[i + 1] === "(") {
            flush();
            quotes.push(quote);
            quote = null;
            subDepth++;
            i++;
            continue;
        }
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
                cur += ch + cmd[++i];
                continue;
            }
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === ")" && subDepth > 0) {
            flush();
            quote = quotes.pop() ?? null;
            subDepth--;
            continue;
        }
        if (SEPARATORS.has(ch)) {
            flush();
            continue;
        }
        cur += ch;
    }
    flush();
    return out;
}

// Split a segment into words on unquoted whitespace, stripping the quotes. Keeps
// `git commit -m "a b"` as four tokens rather than five, and lets `find "/"` be
// recognised as the root search it is.
function shellTokens(seg: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < seg.length) {
        if (/\s/.test(seg[i])) {
            i++;
            continue;
        }
        const start = i;
        let word = "";
        while (i < seg.length && !/\s/.test(seg[i])) {
            const ch = seg[i];
            if (ch === "'" || ch === '"') {
                const end = seg.indexOf(ch, i + 1);
                if (end === -1) {
                    word += seg.slice(i + 1);
                    i = seg.length;
                    break;
                }
                word += seg.slice(i + 1, end);
                i = end + 1;
                continue;
            }
            word += ch;
            i++;
        }
        if (word || i > start) out.push(word);
    }
    return out.filter(Boolean);
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
// `timeout 5 gh …`, `nice git push`, `sudo git push`, `… | xargs git push`, so it's
// still classified instead of slipping through as an unpoliced head.
const EXEC_WRAPPERS = new Set([
    "env", "command", "builtin", "exec", "nohup", "setsid", "nice", "timeout",
    "sudo", "doas", "xargs", "stdbuf",
]);

// Wrapper option flags that consume the FOLLOWING token as their value (so the
// scanner skips the value too, not just the flag).
//
// Keyed PER WRAPPER, because the same flag means different things: `nice -n 5` and
// `xargs -n 1` take a value while `sudo -n` (non-interactive) does not, and a shared
// table would skip the very token that names the command — turning `sudo -n git push`
// into an unclassified `push`.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
    env: new Set(["-u", "--unset", "-C", "--chdir"]),
    nice: new Set(["-n", "--adjustment"]),
    timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
    sudo: new Set([
        "-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from",
        "-D", "--chdir", "-h", "--host", "-r", "--role", "-t", "--type",
        "-U", "--other-user", "-R", "--chroot",
    ]),
    doas: new Set(["-u", "-C"]),
    xargs: new Set([
        "-n", "--max-args", "-P", "--max-procs", "-I", "--replace", "-d",
        "--delimiter", "-E", "-e", "--eof", "-L", "--max-lines", "-s",
        "--max-chars", "-a", "--arg-file",
    ]),
    stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
    exec: new Set(["-a"]),
};
const NO_VALUE_FLAGS: Set<string> = new Set();

// Return the real command tokens for a segment: drop leading `VAR=value` env
// assignments, then peel any exec-wrapper prefixes (env/command/nohup/timeout/…)
// so the underlying gh/git invocation is what gets classified. Best-effort — bash
// isn't fully parseable — and it only ever REVEALS a command, never turns a read
// into a block.
function commandTokens(seg: string): string[] {
    let toks = shellTokens(seg);
    for (let guard = 0; guard < 8 && toks.length; guard++) {
        let i = 0;
        while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // VAR=value
        toks = toks.slice(i);
        const head = toks[0] || "";
        const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
        if (!EXEC_WRAPPERS.has(base)) break;
        const valueFlags = WRAPPER_VALUE_FLAGS[base] ?? NO_VALUE_FLAGS;
        let j = 1;
        let sawDuration = false;
        while (j < toks.length) {
            const t = toks[j];
            if (t === "--") { j++; break; }
            if (t.startsWith("-")) {
                j += valueFlags.has(t.split("=")[0]) && !t.includes("=") ? 2 : 1;
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
