// memory.ts — per-agent MEMORY. Each agent authors its own durable lessons via the
// `remember` tool (extensions/agent-memory.ts). The design is the "B" hybrid:
//   - DURING a run the agent STAGES candidate lessons (remember -> a per-run staging
//     file under the working cwd's .agent/).
//   - AT FINALIZE the orchestrator COMMITS them to <memoryDir>/<agent>.md ONLY IF
//     the run objectively PASSED — the verdict gate against unverified lessons.
//   - On the NEXT run each agent's memory is injected into its prompt.
// Location: agents/memory/<agent>.md in the AGENTS' HOME repo by default (next to
// agents/*.md), resolved like the bundled agent defs so a lesson applies wherever
// the agent runs; override with PI_AGENT_MEMORY_DIR to keep it outside the repo
// (see memoryDir). Git-tracked by default (every commit is a visible, revertable
// diff); bounded (dedup + cap); kill switch PI_AGENT_MEMORY=0. See
// docs/research/agent-self-improvement.md.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Which path wrote a lesson: `remember` = the agent saved it via the tool and
 *  the run PASSED (verdict-gated); `reflect` = the failure reflector distilled it
 *  from a FAILED run's obs digest. Absent = written before source tracking (or a
 *  hand edit) → counted as "unknown". */
export type LessonSource = "remember" | "reflect";

export interface Lesson {
    text: string;
    runId?: string;
    added?: string; // ISO day (YYYY-MM-DD)
    source?: LessonSource;
}

/** Hard cap on lessons per agent — keeps the injected block small. */
export const MEMORY_CAP = 40;
/** Max lessons injected into a prompt in one run. */
export const INJECT_TOP_N = 20;
const MAX_LESSON_CHARS = 280;

// ── kill switch ──────────────────────────────────────────────────────────────

/** Master on/off for both staging/commit and injection. Default ON;
 *  PI_AGENT_MEMORY=0 (or "false"/"off") disables the whole loop instantly. */
export function memoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = (env.PI_AGENT_MEMORY || "").trim().toLowerCase();
    return v !== "0" && v !== "false" && v !== "off";
}

// ── parse / render (pure) ────────────────────────────────────────────────────

const META_RE = /<!--\s*(.*?)\s*-->\s*$/;

/** Parse a memory markdown file into lessons (bullet lines with optional
 *  `<!-- run=… added=… -->` metadata). Tolerant of hand edits. */
export function parseMemory(md: string): Lesson[] {
    const out: Lesson[] = [];
    for (const raw of (md || "").split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!/^\s*-\s+/.test(line)) continue;
        let text = line.replace(/^\s*-\s+/, "");
        let runId: string | undefined;
        let added: string | undefined;
        let source: LessonSource | undefined;
        const m = text.match(META_RE);
        if (m) {
            text = text.slice(0, m.index).trim();
            for (const kv of m[1].split(/\s+/)) {
                const [k, val] = kv.split("=");
                if (k === "run") runId = val;
                else if (k === "added") added = val;
                else if (k === "source" && (val === "remember" || val === "reflect")) source = val;
            }
        }
        text = text.trim();
        if (text) out.push({ text, runId, added, source });
    }
    return out;
}

/** Render lessons back to the managed markdown file. */
export function renderMemory(agent: string, lessons: Lesson[]): string {
    const head = [
        `# ${agent} memory`,
        "",
        `Durable lessons ${agent} has learned from its own past runs (written via the`,
        `\`remember\` tool, kept only when the run succeeded). Injected into ${agent}'s`,
        "prompt on future runs. Managed by utils/workflow/memory.ts; hand edits are preserved.",
        "",
    ];
    const body = lessons.map((l) => {
        const meta = [l.runId ? `run=${l.runId}` : "", l.added ? `added=${l.added}` : "", l.source ? `source=${l.source}` : ""]
            .filter(Boolean)
            .join(" ");
        return meta ? `- ${l.text} <!-- ${meta} -->` : `- ${l.text}`;
    });
    return head.concat(body).join("\n") + "\n";
}

// ── dedupe / cap / fold (pure) ───────────────────────────────────────────────

function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function similar(a: string, b: string): boolean {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

/** Append new lesson texts that aren't already present. Pure. */
export function dedupeAppend(
    lessons: Lesson[],
    newTexts: string[],
    opts: { runId?: string; day?: string; source?: LessonSource } = {},
): Lesson[] {
    const out = lessons.slice();
    for (const raw of newTexts) {
        const text = (raw || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > MAX_LESSON_CHARS) continue;
        if (out.some((l) => similar(l.text, text))) continue;
        out.push({ text, runId: opts.runId, added: opts.day, source: opts.source });
    }
    return out;
}

/** Keep the most recent `cap` lessons (oldest fall off the end). Pure. */
export function capLessons(lessons: Lesson[], cap: number = MEMORY_CAP): Lesson[] {
    return lessons.length <= cap ? lessons : lessons.slice(lessons.length - cap);
}

/** Fold staged lesson texts into an agent's current memory: dedupe-append, then
 *  cap. Pure — the IO lives in commitStagedLearnings. */
export function foldStaged(
    current: Lesson[],
    texts: string[],
    opts: { runId?: string; day?: string; source?: LessonSource } = {},
): Lesson[] {
    return capLessons(dedupeAppend(current, texts, opts));
}

/** Ordered identity signature of a lesson list (normalized text + source). Two
 *  lists with the same signature render to the same file. Detects the change a
 *  bare length check misses: AT THE CAP a new lesson evicts an old one, so the
 *  count is unchanged (40 → 40) but the content differs — the length gate then
 *  skipped the write and the agent's learning silently froze at the cap. */
function lessonsSignature(lessons: Lesson[]): string {
    return lessons.map((l) => `${l.source ?? ""} ${norm(l.text)}`).join("\n");
}
export function lessonsChanged(before: Lesson[], after: Lesson[]): boolean {
    return lessonsSignature(before) !== lessonsSignature(after);
}
/** Count of lessons in `after` whose normalized text isn't already in `before`
 *  (accurate even at the cap, where the list length doesn't grow). */
function newlyAdded(before: Lesson[], after: Lesson[]): number {
    const seen = new Set(before.map((l) => norm(l.text)));
    return after.reduce((n, l) => n + (seen.has(norm(l.text)) ? 0 : 1), 0);
}

// ── injection (pure) ─────────────────────────────────────────────────────────

/** The lessons to inject this run — most recent first, capped. */
export function selectForInjection(lessons: Lesson[], topN: number = INJECT_TOP_N): Lesson[] {
    return lessons.slice(-topN).reverse();
}

/** A one-line nudge so an agent knows it HAS a memory even before it has any
 *  lessons — otherwise a fresh agent is never told to start using `remember`
 *  (the cold-start gap). */
const REMEMBER_NUDGE =
    "You have a `remember` tool: when you learn a durable, general lesson that would " +
    "make you better next time — a BETTER way to do a task (a more effective technique, " +
    "tool, or approach worth reusing) or a pitfall to avoid — call it to save the lesson " +
    "for your future runs.";

/** The text block appended to an agent's system prompt. Always present (when
 *  enabled) so a fresh agent is nudged to use `remember`; grows to include the
 *  agent's saved lessons once it has any. */
export function renderInjection(agent: string, lessons: Lesson[], topN: number = INJECT_TOP_N): string {
    const picked = selectForInjection(lessons, topN);
    if (!picked.length) return `\n\n## Memory\n${REMEMBER_NUDGE}\n`;
    const bullets = picked.map((l) => `- ${l.text}`).join("\n");
    return (
        `\n\n## Memory (lessons from your past runs)\n` +
        `Durable lessons you saved on prior ${agent} runs. Apply them; they are not the task.\n` +
        REMEMBER_NUDGE +
        "\n" +
        bullets +
        "\n"
    );
}

// ── paths ────────────────────────────────────────────────────────────────────

/** Where each agent's committed lessons live. Defaults to agents/memory/ in the
 *  AGENTS' HOME repo (this repo), resolved relative to this source file so it's
 *  found regardless of the working cwd.
 *
 *  Override with PI_AGENT_MEMORY_DIR (in the repo's .env, or the environment) to
 *  keep memory OUTSIDE the repo — e.g. a private, un-synced location. A leading
 *  `~` expands to the home dir; a relative path resolves against the repo root
 *  (not the variable cwd), preserving the "found regardless of cwd" guarantee. */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const override = (env.PI_AGENT_MEMORY_DIR || "").trim();
    if (!override) return join(repoRoot, "agents", "memory");
    const expanded = override === "~" ? homedir() : override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
    return isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
}
function memoryPath(agent: string): string {
    // Sanitize to a bare filename: agent names normally come from configs/defs,
    // but a stray path separator or `..` (a crafted agent name, a lesson authored
    // for one) must never let a write escape memoryDir. Collapse anything but
    // [a-z0-9_-] so no separators or dots survive.
    const safe = agent.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    return join(memoryDir(), `${safe || "agent"}.md`);
}
/** Per-run staging file under the working cwd's .agent/ (cleared each run). */
export function stagingPath(cwd: string): string {
    return join(cwd, ".agent", "learnings.jsonl");
}

// ── staging (sub-agent side, via the remember tool) ──────────────────────────

interface Staged {
    agent: string;
    text: string;
}

/** Stage a candidate lesson for the current run (append-only JSONL). */
export function stageLearning(cwd: string, agent: string, text: string): void {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    const p = stagingPath(cwd);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ agent: agent.toLowerCase(), text: t }) + "\n", "utf-8");
}

export function readStaged(cwd: string): Staged[] {
    try {
        const p = stagingPath(cwd);
        if (!existsSync(p)) return [];
        const out: Staged[] = [];
        for (const line of readFileSync(p, "utf-8").split("\n")) {
            const s = line.trim();
            if (!s) continue;
            try {
                const o = JSON.parse(s);
                if (o && typeof o.agent === "string" && typeof o.text === "string") out.push({ agent: o.agent, text: o.text });
            } catch {}
        }
        return out;
    } catch {
        return [];
    }
}

/** Drop the staging file (called at commit and at run start). */
export function clearStaged(cwd: string): void {
    try {
        rmSync(stagingPath(cwd), { force: true });
    } catch {}
}

// ── memory file IO ───────────────────────────────────────────────────────────

export function readMemory(agent: string): Lesson[] {
    try {
        const p = memoryPath(agent);
        return existsSync(p) ? parseMemory(readFileSync(p, "utf-8")) : [];
    } catch {
        return [];
    }
}
function writeMemory(agent: string, lessons: Lesson[]): void {
    try {
        mkdirSync(memoryDir(), { recursive: true });
        writeFileSync(memoryPath(agent), renderMemory(agent.toLowerCase(), lessons), "utf-8");
    } catch {
        /* best-effort */
    }
}

/** The prompt suffix appended for `agent` this run (empty when disabled/none). */
export function memoryInjection(agent: string, env: NodeJS.ProcessEnv = process.env): string {
    if (!memoryEnabled(env)) return "";
    return renderInjection(agent.toLowerCase(), readMemory(agent));
}

export interface MemoryIO {
    read(agent: string): Lesson[];
    write(agent: string, lessons: Lesson[]): void;
}
const realIO: MemoryIO = { read: readMemory, write: writeMemory };

/** Add lessons directly to an agent's memory (dedupe + cap), independent of the
 *  per-run staging/pass-gate flow. Used by the failure reflector, which distils
 *  lessons from a FAILED run (the agent-authored path only keeps successes).
 *  Returns the number newly added. Gated + best-effort. */
export function addLessons(
    agent: string,
    texts: string[],
    opts: { runId?: string; day?: string; source?: LessonSource } = {},
    io: MemoryIO = realIO,
): number {
    if (!memoryEnabled() || !texts.length) return 0;
    try {
        const before = io.read(agent);
        const after = foldStaged(before, texts, { runId: opts.runId, day: opts.day ?? today(), source: opts.source });
        // Write on any content change — NOT just a length increase, which stalls at
        // the cap (a new lesson evicting an old one keeps the count at MEMORY_CAP).
        if (lessonsChanged(before, after)) io.write(agent, after);
        return newlyAdded(before, after);
    } catch {
        return 0;
    }
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

// ── source stats (observability) ─────────────────────────────────────────────

export interface SourceTally {
    remember: number; // saved via the tool, kept on a passing run
    reflect: number; // distilled from a failed run by the reflector
    unknown: number; // written before source tracking, or a hand edit
    total: number;
}
export interface LessonSourceStats {
    byAgent: Array<{ agent: string } & SourceTally>;
    totals: SourceTally;
}

function bucketOf(source: LessonSource | undefined): keyof Omit<SourceTally, "total"> {
    return source === "remember" ? "remember" : source === "reflect" ? "reflect" : "unknown";
}

/** Tally lessons by their source, per agent and overall. Pure. */
export function tallySources(lessonsByAgent: Array<{ agent: string; lessons: Lesson[] }>): LessonSourceStats {
    const totals: SourceTally = { remember: 0, reflect: 0, unknown: 0, total: 0 };
    const byAgent = lessonsByAgent.map(({ agent, lessons }) => {
        const t: SourceTally = { remember: 0, reflect: 0, unknown: 0, total: 0 };
        for (const l of lessons) {
            t[bucketOf(l.source)]++;
            t.total++;
        }
        totals.remember += t.remember;
        totals.reflect += t.reflect;
        totals.unknown += t.unknown;
        totals.total += t.total;
        return { agent, ...t };
    });
    byAgent.sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent));
    return { byAgent, totals };
}

/** Read every agent memory file (`<agent>.md`) under memoryDir(). Best-effort. */
export function readAllMemories(): Array<{ agent: string; lessons: Lesson[] }> {
    try {
        const dir = memoryDir();
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
            .filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase() !== "readme.md")
            .map((f) => ({ agent: f.replace(/\.md$/i, ""), lessons: parseMemory(readFileSync(join(dir, f), "utf-8")) }));
    } catch {
        return [];
    }
}

/** Lessons-by-source stats across every agent memory file. Lets you watch the
 *  balance of self-authored (`remember`) vs failure-distilled (`reflect`)
 *  learning instead of inferring it. */
export function lessonSourceStats(): LessonSourceStats {
    return tallySources(readAllMemories());
}

/** Called once at run finalize. Reads (and clears) this run's staged learnings and,
 *  IF the run objectively PASSED, commits each agent's lessons to its memory file
 *  (dedup + cap). On a FAIL the staged lessons are dropped. Best-effort + gated.
 *  `io` is injectable for tests. Returns the number of lessons committed. */
export function commitStagedLearnings(cwd: string, opts: { passed: boolean; runId?: string }, io: MemoryIO = realIO): number {
    if (!memoryEnabled()) return 0;
    let committed = 0;
    try {
        const staged = readStaged(cwd);
        clearStaged(cwd);
        if (!opts.passed || !staged.length) return 0; // verdict gate: keep only on success
        const byAgent = new Map<string, string[]>();
        for (const s of staged) {
            const arr = byAgent.get(s.agent) || [];
            arr.push(s.text);
            byAgent.set(s.agent, arr);
        }
        const day = today();
        for (const [agent, texts] of byAgent) {
            const before = io.read(agent);
            const after = foldStaged(before, texts, { runId: opts.runId, day, source: "remember" });
            // Persist on any content change, not just a length change — at the cap a
            // new lesson evicts an old one (count unchanged), which the old length
            // gate dropped, silently freezing the agent's learning at MEMORY_CAP.
            if (lessonsChanged(before, after)) {
                io.write(agent, after);
                committed += newlyAdded(before, after);
            }
        }
    } catch {
        /* never break a run over the learning loop */
    }
    return committed;
}
