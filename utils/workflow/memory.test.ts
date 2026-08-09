import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    memoryDir,
    memoryEnabled,
    parseMemory,
    renderMemory,
    dedupeAppend,
    capLessons,
    foldStaged,
    selectForInjection,
    renderInjection,
    addLessons,
    stageLearning,
    readStaged,
    clearStaged,
    stagingPath,
    commitStagedLearnings,
    tallySources,
    MEMORY_CAP,
    type Lesson,
    type MemoryIO,
} from "./memory";

const L = (text: string, o: Partial<Lesson> = {}): Lesson => ({ text, ...o });

test("memoryDir: defaults into the repo, honours PI_AGENT_MEMORY_DIR override", () => {
    const { isAbsolute } = require("node:path") as typeof import("node:path");
    const { homedir } = require("node:os") as typeof import("node:os");
    // default → the bundled agents/memory/ (absolute, cwd-independent)
    const def = memoryDir({});
    assert.ok(def.endsWith(join("agents", "memory")));
    assert.ok(isAbsolute(def));
    // absolute override → used verbatim (this is how you move it out of the repo)
    assert.equal(memoryDir({ PI_AGENT_MEMORY_DIR: "/data/pi-memory" }), "/data/pi-memory");
    // ~ expands to the home dir
    assert.equal(memoryDir({ PI_AGENT_MEMORY_DIR: "~/pi-memory" }), join(homedir(), "pi-memory"));
    assert.equal(memoryDir({ PI_AGENT_MEMORY_DIR: "~" }), homedir());
    // a relative override resolves against the repo root, not the cwd
    const rel = memoryDir({ PI_AGENT_MEMORY_DIR: "../shared-memory" });
    assert.ok(isAbsolute(rel) && rel.endsWith("shared-memory"));
    // blank/whitespace override falls back to the default
    assert.equal(memoryDir({ PI_AGENT_MEMORY_DIR: "   " }), def);
});

test("memoryEnabled: default ON; disabled by 0/false/off", () => {
    assert.equal(memoryEnabled({}), true);
    assert.equal(memoryEnabled({ PI_AGENT_MEMORY: "0" }), false);
    assert.equal(memoryEnabled({ PI_AGENT_MEMORY: "false" }), false);
    assert.equal(memoryEnabled({ PI_AGENT_MEMORY: "OFF" }), false);
});

test("parse/render round-trips lessons with metadata (incl. source)", () => {
    const lessons = [
        L("re-run the failing test before approving", { runId: "r1", added: "2026-07-01", source: "remember" }),
        L("no metadata bullet"),
    ];
    const rendered = renderMemory("reviewer", lessons);
    assert.match(rendered, /source=remember/);
    const back = parseMemory(rendered);
    assert.equal(back.length, 2);
    assert.deepEqual(back[0], lessons[0]);
    assert.equal(back[1].text, "no metadata bullet");
    // an unrecognised source value is dropped (tolerant of hand edits)
    assert.equal(parseMemory("- x <!-- source=bogus -->")[0].source, undefined);
});

test("parseMemory ignores prose/headers, keeps bullets", () => {
    assert.deepEqual(parseMemory("# reviewer memory\n\nsome prose\n"), []);
    assert.equal(parseMemory("- a hand-written lesson\n")[0].text, "a hand-written lesson");
});

test("parseMemory keeps lesson text that itself contains an HTML comment", () => {
    // The meta comment is the LAST one on the line. Matching from the FIRST `<!--`
    // truncated the lesson there, and the loss compounded on every rewrite.
    const lessons = [L("strip <!-- generated --> markers from the html output", { runId: "r1", added: "2026-08-08", source: "remember" })];
    const back = parseMemory(renderMemory("implementer", lessons));
    assert.deepEqual(back, lessons);
    // stable across a read-modify-write cycle (the shape that lost the text)
    assert.deepEqual(parseMemory(renderMemory("implementer", back)), lessons);
    // a comment with no meta after it is left entirely alone
    assert.equal(parseMemory("- keep <!-- this --> and this")[0].text, "keep <!-- this --> and this");
});

test("dedupeAppend skips near-duplicates and overlong, adds new", () => {
    const cur = [L("check the tsconfig paths alias")];
    const next = dedupeAppend(cur, ["Check the tsconfig paths alias.", "run the linter", "x".repeat(500)], { runId: "r2", day: "2026-07-02" });
    assert.deepEqual(next.map((l) => l.text), ["check the tsconfig paths alias", "run the linter"]);
    assert.equal(next[1].runId, "r2");
});

test("capLessons keeps the most recent cap; foldStaged = dedupe + cap", () => {
    const many: Lesson[] = Array.from({ length: MEMORY_CAP + 5 }, (_, i) => L(`rule ${i}`));
    const capped = capLessons(many);
    assert.equal(capped.length, MEMORY_CAP);
    assert.equal(capped[0].text, "rule 5"); // oldest 5 dropped
    assert.equal(capped[capped.length - 1].text, `rule ${MEMORY_CAP + 4}`);

    const folded = foldStaged([L("old")], ["old", "new"]);
    assert.deepEqual(folded.map((l) => l.text), ["old", "new"]); // dup 'old' skipped
});

test("injection: nudges even when EMPTY (cold start); lessons most-recent first", () => {
    // cold start: no lessons yet, but the agent must still be told it has `remember`
    const empty = renderInjection("reviewer", []);
    assert.match(empty, /## Memory/);
    assert.match(empty, /remember/);
    const lessons = [L("first"), L("second"), L("third")];
    assert.deepEqual(selectForInjection(lessons, 2).map((l) => l.text), ["third", "second"]);
    const inj = renderInjection("reviewer", lessons);
    assert.match(inj, /## Memory/);
    assert.match(inj, /remember/); // nudges the tool
    assert.match(inj, /- third/);
});

test("addLessons writes directly (dedupe+cap), independent of the pass gate", () => {
    const store = new Map<string, Lesson[]>();
    const io: MemoryIO = { read: (a) => store.get(a) ?? [], write: (a, l) => void store.set(a, l) };
    assert.equal(addLessons("validator", ["verify the project is a git repo before git checks"], { runId: "rF", source: "reflect" }, io), 1);
    assert.equal(store.get("validator")![0].text, "verify the project is a git repo before git checks");
    assert.equal(store.get("validator")![0].source, "reflect", "reflector lessons are tagged reflect");
    // dedupe: adding the same lesson again is a no-op
    assert.equal(addLessons("validator", ["Verify the project is a git repo before git checks."], {}, io), 0);
    // disabled kill switch: no write
    process.env.PI_AGENT_MEMORY = "0";
    assert.equal(addLessons("validator", ["something new"], {}, io), 0);
    delete process.env.PI_AGENT_MEMORY;
});

test("addLessons keeps learning AT THE CAP (a new lesson evicts the oldest)", () => {
    const store = new Map<string, Lesson[]>();
    const io: MemoryIO = { read: (a) => store.get(a) ?? [], write: (a, l) => void store.set(a, l) };
    // fill exactly to the cap. Fixed-width labels so `similar()` (substring dedup)
    // doesn't collapse "lesson 1" into "lesson 10".
    const label = (i: number) => `lesson ${String(i).padStart(3, "0")}`;
    const initial = Array.from({ length: MEMORY_CAP }, (_, i) => label(i));
    assert.equal(addLessons("scout", initial, {}, io), MEMORY_CAP);
    assert.equal(store.get("scout")!.length, MEMORY_CAP);
    // a genuinely new lesson at the cap MUST persist (evicting the oldest). The old
    // length-only gate saw 40 → 40 and skipped the write, freezing learning.
    assert.equal(addLessons("scout", ["a brand new lesson at the cap"], {}, io), 1);
    const after = store.get("scout")!;
    assert.equal(after.length, MEMORY_CAP);
    assert.equal(after[after.length - 1].text, "a brand new lesson at the cap");
    assert.equal(after[0].text, label(1)); // oldest (label(0)) evicted
    // a duplicate at the cap is still a no-op (no spurious write)
    assert.equal(addLessons("scout", ["a brand new lesson at the cap"], {}, io), 0);
});

test("commitStagedLearnings persists a new lesson AT THE CAP (no freeze)", () => {
    const store = new Map<string, Lesson[]>();
    const io: MemoryIO = { read: (a) => store.get(a) ?? [], write: (a, l) => void store.set(a, l) };
    store.set("reviewer", Array.from({ length: MEMORY_CAP }, (_, i) => L(`r ${i}`)));
    const cwd = mkdtempSync(join(tmpdir(), "mem-commit-"));
    try {
        stageLearning(cwd, "reviewer", "a fresh reviewer lesson at the cap");
        assert.equal(commitStagedLearnings(cwd, { passed: true }, io), 1);
        const after = store.get("reviewer")!;
        assert.equal(after.length, MEMORY_CAP);
        assert.equal(after[after.length - 1].text, "a fresh reviewer lesson at the cap");
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("memory writes can't escape memoryDir via a crafted agent name", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-esc-"));
    const prev = process.env.PI_AGENT_MEMORY_DIR;
    process.env.PI_AGENT_MEMORY_DIR = dir;
    try {
        // a path-traversal agent name must land INSIDE dir, sanitized — not escape it
        assert.equal(addLessons("../../pwned", ["do not escape the memory dir"], {}), 1);
        assert.equal(existsSync(join(dir, "..", "..", "pwned.md")), false);
        const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
        assert.equal(files.length, 1);
        assert.match(files[0], /^[a-z0-9_-]+\.md$/); // no separators / dots survived
    } finally {
        if (prev === undefined) delete process.env.PI_AGENT_MEMORY_DIR;
        else process.env.PI_AGENT_MEMORY_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("memory files are written atomically (temp + rename, no leftovers)", () => {
    // Every write is a read-modify-write of the whole file: an in-place writeFileSync
    // that crashes mid-write truncates it, and the tolerant parser then drops the
    // tail lessons forever.
    const dir = mkdtempSync(join(tmpdir(), "mem-atomic-"));
    const prev = process.env.PI_AGENT_MEMORY_DIR;
    process.env.PI_AGENT_MEMORY_DIR = dir;
    try {
        const noTmp = () => assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
        assert.equal(addLessons("scribe", ["prefer a rename over an in-place rewrite"], {}), 1);
        const file = join(dir, "scribe.md");
        assert.match(readFileSync(file, "utf-8"), /prefer a rename over an in-place rewrite/);
        noTmp();
        // a second write replaces the file wholesale and still leaves nothing behind
        assert.equal(addLessons("scribe", ["and keep the parser tolerant of hand edits"], {}), 1);
        assert.equal(parseMemory(readFileSync(file, "utf-8")).length, 2);
        noTmp();
    } finally {
        if (prev === undefined) delete process.env.PI_AGENT_MEMORY_DIR;
        else process.env.PI_AGENT_MEMORY_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("staging round-trips per-agent candidates under .agent/", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mem-"));
    try {
        stageLearning(cwd, "Reviewer", "always run the build");
        stageLearning(cwd, "implementer", "write the test first");
        stageLearning(cwd, "reviewer", "  "); // blank ignored
        const staged = readStaged(cwd);
        assert.deepEqual(staged, [
            { agent: "reviewer", text: "always run the build" },
            { agent: "implementer", text: "write the test first" },
        ]);
        assert.ok(existsSync(stagingPath(cwd)));
        clearStaged(cwd);
        assert.equal(readStaged(cwd).length, 0);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("commitStagedLearnings: commits per-agent ONLY on pass, drops on fail, clears staging", () => {
    const store = new Map<string, Lesson[]>();
    const io: MemoryIO = { read: (a) => store.get(a) ?? [], write: (a, l) => void store.set(a, l) };
    const cwd = mkdtempSync(join(tmpdir(), "mem-"));
    try {
        stageLearning(cwd, "reviewer", "run the build before approving");
        stageLearning(cwd, "implementer", "add a regression test");

        // FAIL: nothing committed, staging cleared (verdict gate)
        const droppedRun = mkdtempSync(join(tmpdir(), "mem-fail-"));
        stageLearning(droppedRun, "reviewer", "a bad lesson from a failed run");
        assert.equal(commitStagedLearnings(droppedRun, { passed: false }, io), 0);
        assert.equal(store.size, 0);
        assert.equal(readStaged(droppedRun).length, 0, "staging cleared even on fail");
        rmSync(droppedRun, { recursive: true, force: true });

        // PASS: each agent's lesson lands in its own file, tagged source=remember
        const n = commitStagedLearnings(cwd, { passed: true, runId: "rX" }, io);
        assert.equal(n, 2);
        assert.deepEqual(store.get("reviewer")!.map((l) => l.text), ["run the build before approving"]);
        assert.deepEqual(store.get("implementer")!.map((l) => l.text), ["add a regression test"]);
        assert.equal(store.get("reviewer")![0].source, "remember", "committed lessons are tagged remember");
        assert.equal(readStaged(cwd).length, 0, "staging cleared after commit");

        // idempotent-ish: a second commit with no staged learnings does nothing
        assert.equal(commitStagedLearnings(cwd, { passed: true }, io), 0);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("commitStagedLearnings: disabled kill switch is a no-op", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mem-"));
    try {
        stageLearning(cwd, "reviewer", "x");
        process.env.PI_AGENT_MEMORY = "0";
        const store = new Map<string, Lesson[]>();
        const io: MemoryIO = { read: (a) => store.get(a) ?? [], write: (a, l) => void store.set(a, l) };
        assert.equal(commitStagedLearnings(cwd, { passed: true }, io), 0);
        assert.equal(store.size, 0);
        assert.equal(readStaged(cwd).length, 1, "staging untouched while disabled");
    } finally {
        delete process.env.PI_AGENT_MEMORY;
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("tallySources: counts remember/reflect/unknown per agent and overall, sorted by total", () => {
    const stats = tallySources([
        {
            agent: "validator",
            lessons: [L("a", { source: "reflect" }), L("b", { source: "reflect" }), L("c", { source: "remember" }), L("legacy")],
        },
        { agent: "scout", lessons: [L("d", { source: "reflect" })] },
        { agent: "planner", lessons: [] },
    ]);
    // sorted by total desc: validator (4), scout (1), planner (0)
    assert.deepEqual(stats.byAgent.map((a) => a.agent), ["validator", "scout", "planner"]);
    assert.deepEqual(stats.byAgent[0], { agent: "validator", remember: 1, reflect: 2, unknown: 1, total: 4 });
    assert.deepEqual(stats.byAgent[1], { agent: "scout", remember: 0, reflect: 1, unknown: 0, total: 1 });
    assert.deepEqual(stats.totals, { remember: 1, reflect: 3, unknown: 1, total: 5 });
    // empty input → zeroed totals
    assert.deepEqual(tallySources([]).totals, { remember: 0, reflect: 0, unknown: 0, total: 0 });
});
