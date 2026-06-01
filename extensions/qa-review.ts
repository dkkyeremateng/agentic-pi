/**
 * QA Review — a pi coding-agent extension.
 *
 * Registers the `/qa_review` command, which runs an LLM-driven code review of
 * your changes, primed with deterministic linter/type-checker output.
 *
 * What it does
 * ------------
 * 1. Resolves the change set to review (see "Scope selection" below).
 * 2. Runs the appropriate linters over the changed files as a fast, objective
 *    first pass.
 * 3. Hands the diff + changed-file list + lint findings to the agent via
 *    `pi.sendUserMessage`, which triggers a turn so the model performs the
 *    actual review (correctness, security, error handling, edge cases,
 *    concurrency, resource leaks, maintainability).
 *
 * Scope selection (no argument)
 * -----------------------------
 * - Uncommitted work (tracked changes + untracked files) when the tree is dirty.
 * - Otherwise the last commit (`HEAD~1..HEAD`, or empty-tree..HEAD for a root commit).
 * - A repo with no commits reviews staged + untracked files.
 *
 * Arguments (optional)
 * --------------------
 * - A git range/refs, e.g. `/qa_review main..HEAD` or `/qa_review HEAD~3 HEAD`.
 * - A repo path (an existing directory) to review somewhere other than the cwd.
 * - JSON for both: `/qa_review {"repoPath":"/path","range":"main..HEAD"}`.
 *
 * Linters (best-effort; missing tools are reported, never fatal)
 * --------------------------------------------------------------
 * - JS/TS  → ESLint (project-local `node_modules/.bin/eslint`, grouped by config root).
 * - Go     → golangci-lint when available, otherwise `go vet`.
 * - Python → ruff, plus mypy when a mypy config is present (grouped by project root).
 * Linters are discovered project-locally first (venv / node_modules), then on PATH,
 * run concurrently, and any unavailable/failed tool degrades to a "Notes" line.
 *
 * Notes
 * -----
 * - `pi.exec` always resolves (never throws): a missing binary returns
 *   `{ stdout: "", stderr: "", code: 1 }`, so exit codes + output drive control flow.
 * - A `registerCommand` handler returns `Promise<void>`; its return value is
 *   discarded, so all output goes through `ctx.ui.notify` / `pi.sendUserMessage`.
 *
 * Install: place in `~/.pi/agent/extensions/`, in a project's `.pi/extensions/`,
 * or list its path under `extensions` in settings.json; then `/reload`.
 */
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

interface Finding {
    tool: string;
    filePath: string;
    line?: number;
    column?: number;
    severity: "error" | "warning";
    message: string;
    ruleId?: string;
}

/** What we're about to review, resolved from git state + optional range arg. */
interface ChangeSet {
    /** Human-readable description of the diff range (shown to the user/LLM). */
    label: string;
    /** Files to lint: tracked changes ∪ untracked, repo-relative. */
    changedFiles: string[];
    /** Untracked files (subset of changedFiles), not represented in `patch`. */
    untracked: string[];
    /** Unified diff for tracked changes (may be truncated). */
    patch: string;
    /** Optional caveat about the change set. */
    note?: string;
}

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".cjs", ".mjs"]);
const GO_EXTS = new Set([".go"]);
const PY_EXTS = new Set([".py", ".pyi"]);

const ESLINT_CONFIGS = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    ".eslintrc",
];
const PY_PROJECT_MARKERS = ["pyproject.toml", "setup.cfg", "setup.py"];
const MYPY_CONFIGS = ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"];

// Git's well-known empty-tree object; lets us diff a root commit (no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF_CHARS = 60000;
const GIT_TIMEOUT = 20000;
const ESLINT_TIMEOUT = 60000;
const GOVET_TIMEOUT = 120000;
const GOLANGCI_TIMEOUT = 180000;
const RUFF_TIMEOUT = 60000;
const MYPY_TIMEOUT = 120000;

function extOf(file: string): string {
    const i = file.lastIndexOf(".");
    return i >= 0 ? file.slice(i).toLowerCase() : "";
}

function unique(items: string[]): string[] {
    return [...new Set(items)];
}

function toLines(s: unknown): string[] {
    return String(s ?? "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
}

function stripAnsi(s: unknown): string {
    // eslint-disable-next-line no-control-regex
    return String(s ?? "").replace(/\[[0-9;]*m/g, "");
}

function firstLine(s: unknown): string {
    return toLines(s)[0] ?? "";
}

/** Directories from `startDir` up to and including `repoPath`. */
function ancestorsWithin(startDir: string, repoPath: string): string[] {
    const dirs: string[] = [];
    let dir = startDir;
    while (true) {
        dirs.push(dir);
        if (dir === repoPath) break;
        const parent = dirname(dir);
        if (parent === dir) break; // hit fs root before repoPath
        dir = parent;
    }
    return dirs;
}

function findUp(
    startDir: string,
    repoPath: string,
    test: (dir: string) => boolean,
): string | undefined {
    return ancestorsWithin(startDir, repoPath).find(test);
}

/**
 * Resolve a tool binary: prefer a project-local install (e.g. a venv or
 * node_modules) found by walking up from `startDir`, else fall back to the
 * bare name (resolved via PATH by `spawn`).
 */
function resolveTool(
    startDir: string,
    repoPath: string,
    relCandidates: string[],
    fallbackName: string,
): string {
    const dir = findUp(startDir, repoPath, (d) =>
        relCandidates.some((c) => existsSync(join(d, c))),
    );
    if (dir) {
        const hit = relCandidates.find((c) => existsSync(join(dir, c)));
        if (hit) return join(dir, hit);
    }
    return fallbackName;
}

/** Truncate a diff on a line boundary, noting how much was dropped. */
function capDiff(raw: unknown): string {
    const diff = String(raw ?? "");
    if (diff.length <= MAX_DIFF_CHARS) return diff;
    const head = diff.slice(0, MAX_DIFF_CHARS);
    const cut = head.lastIndexOf("\n");
    const body = cut > 0 ? head.slice(0, cut) : head;
    const omitted = diff.length - body.length;
    return `${body}\n… [diff truncated — ${omitted} more chars omitted; read files directly for full context]`;
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        ctx.ui.notify(
            "QA Review loaded. Use /qa_review to review code changes.",
            "info",
        );
    });

    // `pi.exec` always resolves (never throws): a missing binary comes back as
    // `{ stdout: "", stderr: "", code: 1 }`. So we rely on exit codes + output.
    const run = (
        cmd: string,
        args: string[],
        cwd: string,
        timeout: number,
        signal?: AbortSignal,
    ) => pi.exec(cmd, args, { cwd, timeout, signal });

    /** True unless the result looks like "command not found" (code≠0, no output). */
    function ranOk(res: { code: number; stdout: string; stderr: string }): boolean {
        return !(res.code !== 0 && !res.stdout && !res.stderr);
    }

    const git = (repoPath: string, args: string[], signal?: AbortSignal) =>
        run("git", args, repoPath, GIT_TIMEOUT, signal);

    async function isGitRepo(
        repoPath: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const res = await git(
            repoPath,
            ["rev-parse", "--is-inside-work-tree"],
            signal,
        );
        return res.code === 0 && String(res.stdout).trim() === "true";
    }

    async function commitExists(
        repoPath: string,
        rev: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const res = await git(
            repoPath,
            ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
            signal,
        );
        return res.code === 0;
    }

    async function listUntracked(
        repoPath: string,
        signal?: AbortSignal,
    ): Promise<string[]> {
        const res = await git(
            repoPath,
            ["ls-files", "--others", "--exclude-standard"],
            signal,
        );
        return toLines(res.stdout);
    }

    async function diffAgainst(
        repoPath: string,
        diffArgs: string[],
        signal?: AbortSignal,
    ): Promise<{ files: string[]; patch: string }> {
        const names = await git(
            repoPath,
            ["diff", "--name-only", ...diffArgs],
            signal,
        );
        const patch = await git(repoPath, ["diff", ...diffArgs], signal);
        return { files: toLines(names.stdout), patch: capDiff(patch.stdout) };
    }

    /**
     * Decide what to review:
     *   1. an explicit range arg (e.g. `main..HEAD`, `HEAD~3 HEAD`), else
     *   2. uncommitted work (tracked changes + untracked files), else
     *   3. the last commit (`HEAD~1..HEAD`, or empty-tree..HEAD for a root commit).
     */
    async function resolveChanges(
        repoPath: string,
        range: string | undefined,
        signal?: AbortSignal,
    ): Promise<ChangeSet> {
        if (range) {
            const diffArgs = range.split(/\s+/).filter(Boolean);
            const { files, patch } = await diffAgainst(
                repoPath,
                diffArgs,
                signal,
            );
            return {
                label: `range: ${range}`,
                changedFiles: files,
                untracked: [],
                patch,
            };
        }

        const hasHead = await commitExists(repoPath, "HEAD", signal);
        const untracked = await listUntracked(repoPath, signal);

        if (!hasHead) {
            const staged = toLines(
                (await git(repoPath, ["diff", "--cached", "--name-only"], signal))
                    .stdout,
            );
            return {
                label: "working tree (no commits yet)",
                changedFiles: unique([...staged, ...untracked]),
                untracked,
                patch: "",
                note: "Repository has no commits yet; reviewing staged/untracked files.",
            };
        }

        // `git diff --quiet HEAD` exits non-zero when tracked files differ.
        const dirty =
            (await git(repoPath, ["diff", "--quiet", "HEAD"], signal)).code !== 0;

        if (dirty || untracked.length > 0) {
            const { files, patch } = await diffAgainst(
                repoPath,
                ["HEAD"],
                signal,
            );
            return {
                label: "uncommitted changes (working tree vs HEAD)",
                changedFiles: unique([...files, ...untracked]),
                untracked,
                patch,
            };
        }

        // Clean tree: review the most recent commit.
        const hasParent = await commitExists(repoPath, "HEAD~1", signal);
        const base = hasParent ? "HEAD~1" : EMPTY_TREE;
        const { files, patch } = await diffAgainst(
            repoPath,
            [base, "HEAD"],
            signal,
        );
        return {
            label: hasParent ? "last commit (HEAD~1..HEAD)" : "initial commit",
            changedFiles: files,
            untracked: [],
            patch,
        };
    }

    // ── Linters ─────────────────────────────────────────────────────────────

    /** Lint JS/TS files with the project-local ESLint, grouped by config root. */
    async function runEslint(
        repoPath: string,
        files: string[],
        findings: Finding[],
        notes: string[],
        signal?: AbortSignal,
    ): Promise<void> {
        const groups = new Map<string, string[]>();
        for (const rel of files) {
            const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
            const configRoot = findUp(dirname(abs), repoPath, (dir) =>
                ESLINT_CONFIGS.some((c) => existsSync(join(dir, c))),
            );
            if (!configRoot) {
                notes.push(`eslint: no config found for ${rel} — skipped`);
                continue;
            }
            const list = groups.get(configRoot) ?? [];
            list.push(abs);
            groups.set(configRoot, list);
        }

        for (const [configRoot, absFiles] of groups) {
            const binDir = findUp(configRoot, repoPath, (dir) =>
                existsSync(join(dir, "node_modules", ".bin", "eslint")),
            );
            if (!binDir) {
                notes.push(
                    `eslint: no local install near ${relative(repoPath, configRoot) || "."} — skipped`,
                );
                continue;
            }
            const eslintBin = join(binDir, "node_modules", ".bin", "eslint");
            const relFiles = absFiles.map((f) => relative(configRoot, f));
            const res = await run(
                eslintBin,
                ["-f", "json", "--no-error-on-unmatched-pattern", ...relFiles],
                configRoot,
                ESLINT_TIMEOUT,
                signal,
            );
            let parsed: unknown;
            try {
                parsed = JSON.parse(String(res.stdout ?? "").trim());
            } catch {
                parsed = undefined;
            }
            if (!Array.isArray(parsed)) {
                notes.push(
                    `eslint failed in ${relative(repoPath, configRoot) || "."}: ${firstLine(res.stderr) || `exit ${res.code}`}`,
                );
                continue;
            }
            for (const file of parsed as any[]) {
                for (const m of file.messages ?? []) {
                    findings.push({
                        tool: "eslint",
                        filePath: relative(repoPath, file.filePath),
                        line: m.line,
                        column: m.column,
                        severity: m.severity === 2 ? "error" : "warning",
                        message: m.message,
                        ruleId: m.ruleId ?? undefined,
                    });
                }
            }
        }
    }

    /** `go vet`, one run per package directory. */
    async function runGoVet(
        repoPath: string,
        pkgDirs: string[],
        findings: Finding[],
        notes: string[],
        signal?: AbortSignal,
    ): Promise<void> {
        const lineRe = /^(.+\.go):(\d+):(\d+):\s*(.+)$/;
        for (const relDir of pkgDirs) {
            const res = await run(
                "go",
                ["vet", `./${relDir}`],
                repoPath,
                GOVET_TIMEOUT,
                signal,
            );
            if (!ranOk(res)) {
                notes.push(`go vet: toolchain not available (./${relDir})`);
                continue;
            }
            const out = stripAnsi(`${res.stdout}\n${res.stderr}`);
            for (const raw of out.split(/\r?\n/)) {
                const m = raw.match(lineRe);
                if (!m) continue;
                const file = m[1];
                findings.push({
                    tool: "go vet",
                    filePath: isAbsolute(file) ? relative(repoPath, file) : file,
                    line: Number(m[2]),
                    column: Number(m[3]),
                    severity: "error",
                    message: m[4],
                });
            }
        }
    }

    /** Lint Go: prefer golangci-lint (covers vet); fall back to `go vet`. */
    async function runGo(
        repoPath: string,
        files: string[],
        findings: Finding[],
        notes: string[],
        signal?: AbortSignal,
    ): Promise<void> {
        const pkgDirs = unique(
            files.map((rel) => {
                const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
                return (relative(repoPath, dirname(abs)) || ".").replace(
                    /\\/g,
                    "/",
                );
            }),
        );

        const gl = await run(
            "golangci-lint",
            ["run", ...pkgDirs.map((d) => `./${d}`)],
            repoPath,
            GOLANGCI_TIMEOUT,
            signal,
        );

        if (!ranOk(gl)) {
            // golangci-lint not installed — use go vet.
            await runGoVet(repoPath, pkgDirs, findings, notes, signal);
            return;
        }

        // Default text output: `path:line:col: message (linter)`.
        const issueRe = /^(.+\.go):(\d+):(\d+):\s*(.+)$/;
        const out = stripAnsi(`${gl.stdout}\n${gl.stderr}`);
        let found = 0;
        for (const raw of out.split(/\r?\n/)) {
            const m = raw.match(issueRe);
            if (!m) continue;
            found++;
            const ruleMatch = m[4].match(/\(([\w.-]+)\)\s*$/);
            findings.push({
                tool: "golangci-lint",
                filePath: isAbsolute(m[1]) ? relative(repoPath, m[1]) : m[1],
                line: Number(m[2]),
                column: Number(m[3]),
                severity: "warning",
                message: ruleMatch
                    ? m[4].slice(0, ruleMatch.index).trim()
                    : m[4],
                ruleId: ruleMatch?.[1],
            });
        }

        // Clean run is exit 0; a non-zero exit with nothing parsed is a real
        // error (bad config, not a module, …) — note it and try go vet instead.
        if (found === 0 && gl.code !== 0) {
            notes.push(
                `golangci-lint error (exit ${gl.code}): ${firstLine(gl.stderr) || "no output"} — using go vet`,
            );
            await runGoVet(repoPath, pkgDirs, findings, notes, signal);
        }
    }

    /** ruff: fast Python linter; runs from each Python project root. */
    async function runRuff(
        repoPath: string,
        root: string,
        relFiles: string[],
        findings: Finding[],
        notes: string[],
        signal?: AbortSignal,
    ): Promise<void> {
        const bin = resolveTool(
            root,
            repoPath,
            [".venv/bin/ruff", "venv/bin/ruff", ".venv/Scripts/ruff.exe"],
            "ruff",
        );
        const res = await run(
            bin,
            ["check", "--output-format", "json", "--", ...relFiles],
            root,
            RUFF_TIMEOUT,
            signal,
        );
        if (!ranOk(res)) {
            notes.push("ruff: not installed — skipped");
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(stripAnsi(res.stdout).trim());
        } catch {
            parsed = undefined;
        }
        if (!Array.isArray(parsed)) {
            notes.push(
                `ruff failed in ${relative(repoPath, root) || "."}: ${firstLine(res.stderr) || `exit ${res.code}`}`,
            );
            return;
        }
        for (const it of parsed as any[]) {
            const file = isAbsolute(it.filename)
                ? it.filename
                : join(root, it.filename ?? "");
            findings.push({
                tool: "ruff",
                filePath: relative(repoPath, file),
                line: it.location?.row,
                column: it.location?.column,
                // ruff reports a null code for syntax errors — treat those as errors.
                severity: it.code ? "warning" : "error",
                message: it.message,
                ruleId: it.code ?? undefined,
            });
        }
    }

    /** mypy: Python type checker; only runs when a mypy config is present. */
    async function runMypy(
        repoPath: string,
        root: string,
        relFiles: string[],
        findings: Finding[],
        notes: string[],
        signal?: AbortSignal,
    ): Promise<void> {
        const cfgDir = findUp(root, repoPath, (d) =>
            MYPY_CONFIGS.some((c) => existsSync(join(d, c))),
        );
        if (!cfgDir) {
            notes.push("mypy: no config found — skipped");
            return;
        }
        const bin = resolveTool(
            root,
            repoPath,
            [".venv/bin/mypy", "venv/bin/mypy", ".venv/Scripts/mypy.exe"],
            "mypy",
        );
        const res = await run(
            bin,
            [
                "--no-error-summary",
                "--no-color-output",
                "--show-column-numbers",
                "--",
                ...relFiles,
            ],
            root,
            MYPY_TIMEOUT,
            signal,
        );
        if (!ranOk(res)) {
            notes.push("mypy: not installed — skipped");
            return;
        }
        const out = stripAnsi(`${res.stdout}\n${res.stderr}`);
        const re =
            /^(.+\.pyi?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.+)$/;
        for (const raw of out.split(/\r?\n/)) {
            const m = raw.match(re);
            if (!m) continue;
            if (m[4] === "note") continue; // context for the preceding diagnostic
            const file = isAbsolute(m[1]) ? m[1] : join(root, m[1]);
            const codeMatch = m[5].match(/\s*\[([\w-]+)\]\s*$/);
            findings.push({
                tool: "mypy",
                filePath: relative(repoPath, file),
                line: Number(m[2]),
                column: m[3] ? Number(m[3]) : undefined,
                severity: m[4] === "warning" ? "warning" : "error",
                message: codeMatch ? m[5].slice(0, codeMatch.index).trim() : m[5],
                ruleId: codeMatch?.[1],
            });
        }
    }

    /** Lint Python files: ruff + mypy, grouped by project root. */
    async function runPython(
        repoPath: string,
        files: string[],
        findings: Finding[],
        notes: string[],
        signal?: AbortSignal,
    ): Promise<void> {
        const groups = new Map<string, string[]>();
        for (const rel of files) {
            const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
            const root =
                findUp(dirname(abs), repoPath, (d) =>
                    PY_PROJECT_MARKERS.some((m) => existsSync(join(d, m))),
                ) ?? repoPath;
            const list = groups.get(root) ?? [];
            list.push(abs);
            groups.set(root, list);
        }

        await Promise.all(
            [...groups].map(async ([root, absFiles]) => {
                const relFiles = absFiles.map((f) => relative(root, f));
                await Promise.all([
                    runRuff(repoPath, root, relFiles, findings, notes, signal),
                    runMypy(repoPath, root, relFiles, findings, notes, signal),
                ]);
            }),
        );
    }

    /** Run all applicable linters and return a compact, readable block. */
    async function lintSummary(
        repoPath: string,
        changedFiles: string[],
        signal?: AbortSignal,
    ): Promise<string> {
        const jsFiles = changedFiles.filter((f) => JS_EXTS.has(extOf(f)));
        const goFiles = changedFiles.filter((f) => GO_EXTS.has(extOf(f)));
        const pyFiles = changedFiles.filter((f) => PY_EXTS.has(extOf(f)));
        const otherFiles = changedFiles.filter(
            (f) =>
                !JS_EXTS.has(extOf(f)) &&
                !GO_EXTS.has(extOf(f)) &&
                !PY_EXTS.has(extOf(f)),
        );

        const findings: Finding[] = [];
        const notes: string[] = [];

        const tasks: Promise<void>[] = [];
        if (jsFiles.length > 0)
            tasks.push(runEslint(repoPath, jsFiles, findings, notes, signal));
        if (goFiles.length > 0)
            tasks.push(runGo(repoPath, goFiles, findings, notes, signal));
        if (pyFiles.length > 0)
            tasks.push(runPython(repoPath, pyFiles, findings, notes, signal));
        await Promise.all(tasks);

        if (otherFiles.length > 0) {
            notes.push(`No linter mapped for: ${otherFiles.join(", ")}`);
        }

        const errors = findings.filter((f) => f.severity === "error").length;
        const warnings = findings.length - errors;

        const counts: string[] = [];
        if (jsFiles.length) counts.push(`${jsFiles.length} JS/TS`);
        if (goFiles.length) counts.push(`${goFiles.length} Go`);
        if (pyFiles.length) counts.push(`${pyFiles.length} Python`);

        let out = `Linted: ${counts.join(", ") || "0 files"}\n`;
        out += `Automated findings: ${findings.length} (${errors} error, ${warnings} warning)\n`;
        if (findings.length > 0) {
            for (const f of findings.slice(0, 50)) {
                const loc = f.line != null ? `:${f.line}:${f.column ?? 0}` : "";
                const rule = f.ruleId ? ` (${f.ruleId})` : "";
                out += `- [${f.tool}] ${f.filePath}${loc} [${f.severity}] ${f.message}${rule}\n`;
            }
            if (findings.length > 50) {
                out += `… and ${findings.length - 50} more\n`;
            }
        }
        if (notes.length > 0) {
            out += "Notes:\n";
            for (const n of notes) out += `- ${n}\n`;
        }
        return out;
    }

    // ── Review orchestration ─────────────────────────────────────────────────

    type ReviewResult =
        | { status: "triggered"; label: string; fileCount: number }
        | { status: "no-changes"; label: string }
        | { status: "not-a-repo"; repoPath: string };

    /**
     * Assemble the review request and hand it to the agent via
     * `pi.sendUserMessage`, which always triggers a turn — so the LLM performs
     * the actual code review (lint output is supplied as supporting signal).
     */
    async function startReview(
        repoPath: string,
        range: string | undefined,
        signal?: AbortSignal,
    ): Promise<ReviewResult> {
        if (!(await isGitRepo(repoPath, signal))) {
            return { status: "not-a-repo", repoPath };
        }

        const changes = await resolveChanges(repoPath, range, signal);
        if (changes.changedFiles.length === 0 && !changes.patch.trim()) {
            return { status: "no-changes", label: changes.label };
        }

        const lint = await lintSummary(repoPath, changes.changedFiles, signal);

        const sections: string[] = [
            `Please perform a thorough QA code review of the following changes in \`${repoPath}\`.`,
            "",
            `Scope: ${changes.label}`,
            `Changed files: ${changes.changedFiles.length > 0 ? changes.changedFiles.join(", ") : "(none)"}`,
        ];
        if (changes.untracked.length > 0) {
            sections.push(
                `New/untracked files (full contents NOT in the diff — read them directly): ${changes.untracked.join(", ")}`,
            );
        }
        if (changes.note) sections.push(`Note: ${changes.note}`);
        sections.push(
            "",
            "Automated lint/type results (supporting signal — not a substitute for your own review):",
            lint.trim(),
            "",
            "Review for correctness bugs, security issues, error handling, edge cases, concurrency/race conditions, resource leaks, and maintainability. Read the full files for context where the diff is insufficient. Report concrete, actionable findings as `file:line — issue` grouped by severity, or state clearly if the changes look good.",
            "",
            "Diff:",
            "```diff",
            changes.patch.trim() ||
                "(no textual diff — review the listed files directly)",
            "```",
        );

        pi.sendUserMessage(sections.join("\n"));
        return {
            status: "triggered",
            label: changes.label,
            fileCount: changes.changedFiles.length,
        };
    }

    /** Parse the command argument into an optional repo path and/or git range. */
    function parseArgs(
        cwd: string,
        rawArgs: string,
    ): { repoPath: string; range?: string } {
        const s = typeof rawArgs === "string" ? rawArgs.trim() : "";
        if (!s) return { repoPath: resolve(cwd) };

        // JSON form: { "repoPath": "...", "range": "main..HEAD" }
        if (s.startsWith("{")) {
            try {
                const parsed = JSON.parse(s);
                const repoPath =
                    typeof parsed?.repoPath === "string"
                        ? resolve(parsed.repoPath)
                        : resolve(cwd);
                const range =
                    typeof parsed?.range === "string" && parsed.range.trim()
                        ? parsed.range.trim()
                        : undefined;
                return { repoPath, range };
            } catch {
                // fall through to bare-arg handling
            }
        }

        // Bare arg: an existing directory is a repo path; otherwise a git range.
        const asPath = resolve(cwd, s);
        if (existsSync(asPath)) return { repoPath: asPath };
        return { repoPath: resolve(cwd), range: s };
    }

    // NOTE: a registerCommand handler's return type is `Promise<void>` — pi
    // discards whatever it returns. Output/side effects must go through the UI
    // (ctx.ui.notify) or session APIs (pi.sendUserMessage / pi.sendMessage).
    const handler = async (args: string, ctx: ExtensionCommandContext) => {
        const { repoPath, range } = parseArgs(ctx.cwd, args);

        ctx.ui.notify(`Preparing QA review in ${repoPath}…`, "info");
        try {
            const result = await startReview(repoPath, range, ctx.signal);
            switch (result.status) {
                case "triggered":
                    ctx.ui.notify(
                        `Reviewing ${result.fileCount} file(s) — ${result.label}. See the agent's reply.`,
                        "info",
                    );
                    break;
                case "no-changes":
                    ctx.ui.notify(
                        `No changes to review (${result.label}). Try \`/qa_review <git-range>\`.`,
                        "warning",
                    );
                    break;
                case "not-a-repo":
                    ctx.ui.notify(
                        `Not a git repository (or git unavailable): ${result.repoPath}`,
                        "error",
                    );
                    break;
            }
        } catch (err: any) {
            ctx.ui.notify(
                `QA review failed: ${err?.message ?? String(err)}`,
                "error",
            );
        }
    };

    const description =
        "QA code review of your changes. No args: reviews uncommitted changes (or the last commit if clean). Optional: a git range (e.g. main..HEAD) or a repo path. Linters: ESLint (JS/TS), golangci-lint/go vet (Go), ruff & mypy (Python).";

    pi.registerCommand("qa_review", { description, handler });
}
