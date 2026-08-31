// ABOUTME: Pure helpers for the QA review extension (extensions/qa-review.ts) —
// ABOUTME: output parsing, path walking, tool resolution and diff truncation.
// ABOUTME: Kept here so they are unit-tested; the extension stays a thin wrapper.
//
// These lived inside the extension, where nothing could reach them: CI covers
// `extensions/*.ts` with `node --check` only, which parses and never executes. So
// the diff cap, the ancestor walk and the tool-resolution order — the parts most
// likely to be wrong and least likely to be noticed — had no behavioural coverage
// at all. None of this needs pi, so none of it had to live in an extension.

import { dirname, join } from "path";
import { existsSync } from "fs";

/** Source extensions each linter claims. Used to decide which tools to run. */
export const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".cjs", ".mjs"]);
export const GO_EXTS = new Set([".go"]);
export const PY_EXTS = new Set([".py", ".pyi"]);

/** Cap on the unified diff handed to the model. */
export const MAX_DIFF_CHARS = 60000;

/** Lowercased extension including the dot, or "" when there is none. A dotfile
 *  with no extension (`.gitignore`) reports `.gitignore` — harmless, since the
 *  callers only ever test membership in the language sets above. */
export function extOf(file: string): string {
    const i = file.lastIndexOf(".");
    return i >= 0 ? file.slice(i).toLowerCase() : "";
}

/** De-duplicate, preserving first-seen order. */
export function unique(items: string[]): string[] {
    return [...new Set(items)];
}

/** Split tool output into trimmed, non-empty lines. */
export function toLines(s: unknown): string[] {
    return String(s ?? "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
}

/** Strip ANSI SGR colour codes so a linter's coloured output parses as text. */
export function stripAnsi(s: unknown): string {
    return String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** First non-empty line, or "" — used to summarise a tool's stderr. */
export function firstLine(s: unknown): string {
    return toLines(s)[0] ?? "";
}

/** Directories from `startDir` up to and including `repoPath`.
 *  Stops at the filesystem root if `startDir` is not under `repoPath`, so a bad
 *  pair yields a bounded walk rather than looping. */
export function ancestorsWithin(startDir: string, repoPath: string): string[] {
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

/** Nearest ancestor (inclusive, walking up to `repoPath`) satisfying `test`. */
export function findUp(
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
 *
 * `exists` is injectable so the resolution ORDER can be tested without a
 * fixture tree: the nearest ancestor wins, and within a directory the first
 * listed candidate wins.
 */
export function resolveTool(
    startDir: string,
    repoPath: string,
    relCandidates: string[],
    fallbackName: string,
    exists: (p: string) => boolean = existsSync,
): string {
    const dir = findUp(startDir, repoPath, (d) =>
        relCandidates.some((c) => exists(join(d, c))),
    );
    if (dir) {
        const hit = relCandidates.find((c) => exists(join(dir, c)));
        if (hit) return join(dir, hit);
    }
    return fallbackName;
}

/** Truncate a diff on a line boundary, noting how much was dropped. */
export function capDiff(raw: unknown, maxChars: number = MAX_DIFF_CHARS): string {
    const diff = String(raw ?? "");
    if (diff.length <= maxChars) return diff;
    const head = diff.slice(0, maxChars);
    const cut = head.lastIndexOf("\n");
    const body = cut > 0 ? head.slice(0, cut) : head;
    const omitted = diff.length - body.length;
    return `${body}\n… [diff truncated — ${omitted} more chars omitted; read files directly for full context]`;
}
