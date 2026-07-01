import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
    MEMORY_CAP,
    type Lesson,
    type MemoryIO,
} from "./memory";

const L = (text: string, o: Partial<Lesson> = {}): Lesson => ({ text, ...o });

test("memoryEnabled: default ON; disabled by 0/false/off", () => {
    assert.equal(memoryEnabled({}), true);
    assert.equal(memoryEnabled({ PI_AGENT_MEMORY: "0" }), false);
    assert.equal(memoryEnabled({ PI_AGENT_MEMORY: "false" }), false);
    assert.equal(memoryEnabled({ PI_AGENT_MEMORY: "OFF" }), false);
});

test("parse/render round-trips lessons with metadata", () => {
    const lessons = [L("re-run the failing test before approving", { runId: "r1", added: "2026-07-01" }), L("no metadata bullet")];
    const back = parseMemory(renderMemory("reviewer", lessons));
    assert.equal(back.length, 2);
    assert.deepEqual(back[0], lessons[0]);
    assert.equal(back[1].text, "no metadata bullet");
});

test("parseMemory ignores prose/headers, keeps bullets", () => {
    assert.deepEqual(parseMemory("# reviewer memory\n\nsome prose\n"), []);
    assert.equal(parseMemory("- a hand-written lesson\n")[0].text, "a hand-written lesson");
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
    assert.equal(addLessons("validator", ["verify the project is a git repo before git checks"], { runId: "rF" }, io), 1);
    assert.equal(store.get("validator")![0].text, "verify the project is a git repo before git checks");
    // dedupe: adding the same lesson again is a no-op
    assert.equal(addLessons("validator", ["Verify the project is a git repo before git checks."], {}, io), 0);
    // disabled kill switch: no write
    process.env.PI_AGENT_MEMORY = "0";
    assert.equal(addLessons("validator", ["something new"], {}, io), 0);
    delete process.env.PI_AGENT_MEMORY;
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

        // PASS: each agent's lesson lands in its own file
        const n = commitStagedLearnings(cwd, { passed: true, runId: "rX" }, io);
        assert.equal(n, 2);
        assert.deepEqual(store.get("reviewer")!.map((l) => l.text), ["run the build before approving"]);
        assert.deepEqual(store.get("implementer")!.map((l) => l.text), ["add a regression test"]);
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
