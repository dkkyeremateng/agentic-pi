import { test } from "node:test";
import assert from "node:assert/strict";
import { LineScanner, RunIndexer } from "./obs-run-index";
import {
    makeFactory,
    parseEventLine,
    serializeEvent,
    type ObsEvent,
} from "./obs-events";

// ── LineScanner ──────────────────────────────────────────────────────────────

test("LineScanner reports byte-accurate offsets and holds partial lines", () => {
    const seen: [string, number, number][] = [];
    const s = new LineScanner((l, a, b) => seen.push([l, a, b]));
    s.push(Buffer.from("ab\ncd"));
    assert.deepEqual(seen, [["ab", 0, 3]]);
    assert.equal(s.offset, 5); // "cd" held but consumed
    s.push(Buffer.from("e\n"));
    assert.deepEqual(seen[1], ["cde", 3, 7]);
});

test("LineScanner survives a UTF-8 sequence split across chunks", () => {
    const seen: [string, number, number][] = [];
    const s = new LineScanner((l, a, b) => seen.push([l, a, b]));
    const bytes = Buffer.from("é\n"); // 0xC3 0xA9 0x0A
    s.push(bytes.subarray(0, 1)); // half the multibyte char
    s.push(bytes.subarray(1));
    assert.deepEqual(seen, [["é", 0, 3]]);
});

test("LineScanner reset rebases offsets", () => {
    const seen: number[] = [];
    const s = new LineScanner((_l, a) => seen.push(a));
    s.push(Buffer.from("x\n"));
    s.reset(100);
    s.push(Buffer.from("y\n"));
    assert.deepEqual(seen, [0, 100]);
    assert.equal(s.offset, 102);
});

// ── RunIndexer ───────────────────────────────────────────────────────────────

function runEvents(runId: string, agent: string, ts: number): ObsEvent[] {
    const f = makeFactory({
        sessionId: `${agent}-${runId}`,
        agent,
        cwd: "/proj/" + runId,
        runId,
    });
    return [
        f.next("session_start", { model: "m" }, ts),
        f.next("turn_end", { costUsd: 0.5, tokens: { total: 10 } }, ts + 10),
        f.next("tool_end", { isError: true }, ts + 20),
        f.next("session_end", {}, ts + 30),
    ];
}

// Interleave two runs in one sink buffer, like a shared global sink.
function sinkOf(lines: ObsEvent[]): Buffer {
    return Buffer.from(lines.map((e) => serializeEvent(e)).join("\n") + "\n");
}

test("RunIndexer indexes interleaved runs with correct ranges", () => {
    const a = runEvents("run-a", "orchestrator", 1000);
    const b = runEvents("run-b", "scout", 2000);
    const lines = [a[0], b[0], a[1], b[1], a[2], b[2], a[3], b[3]];
    const sink = sinkOf(lines);

    const idx = new RunIndexer();
    // Feed in awkward chunk sizes to exercise the boundary handling.
    for (let i = 0; i < sink.length; i += 7)
        idx.feed(sink.subarray(i, Math.min(i + 7, sink.length)));
    assert.equal(idx.scannedTo, sink.length);

    const runs = idx.runs();
    assert.deepEqual(
        runs.map((r) => r.runId),
        ["run-b", "run-a"], // latest-first
    );

    const ra = idx.get("run-a")!;
    assert.equal(ra.events, 4);
    assert.deepEqual(ra.agents, ["orchestrator"]);
    assert.equal(ra.cwd, "/proj/run-a");
    assert.equal(ra.costUsd, 0.5);
    assert.equal(ra.tokens, 10); // summed from turn_end tokens.total
    assert.equal(ra.toolCalls, 0); // no tool_start in this fixture
    assert.equal(ra.errors, 1); // the failing tool_end
    assert.equal(ra.firstTs, 1000);
    assert.equal(ra.lastTs, 1030);

    // The byte range must recover exactly run-a's events (the /events?run= path).
    const slice = sink.subarray(ra.startOffset, ra.endOffset).toString("utf-8");
    const got = slice
        .split("\n")
        .map(parseEventLine)
        .filter((e) => e && e.runId === "run-a");
    assert.equal(got.length, 4);
    assert.deepEqual(
        got.map((e) => e!.type),
        ["session_start", "turn_end", "tool_end", "session_end"],
    );
});

test("RunIndexer skips lines without a runId and malformed lines", () => {
    const f = makeFactory({ sessionId: "s", agent: "a" }); // no runId (legacy v1)
    const idx = new RunIndexer();
    idx.feed(
        Buffer.from(
            serializeEvent(f.next("turn_end", {}, 1)) + "\nnot json\n",
        ),
    );
    assert.equal(idx.runs().length, 0);
});

test("RunIndexer reset clears runs and offsets for a rebuild", () => {
    const idx = new RunIndexer();
    idx.feed(sinkOf(runEvents("run-x", "a", 1)));
    assert.equal(idx.runs().length, 1);
    idx.reset();
    assert.equal(idx.scannedTo, 0);
    assert.equal(idx.runs().length, 0);
});

test("RunIndexer ignores a trailing partial line until its newline arrives", () => {
    const [ev] = runEvents("run-p", "a", 1);
    const line = serializeEvent(ev);
    const idx = new RunIndexer();
    idx.feed(Buffer.from(line)); // no newline yet
    assert.equal(idx.runs().length, 0);
    idx.feed(Buffer.from("\n"));
    assert.equal(idx.get("run-p")?.events, 1);
});

test("RunIndexer captures the run verdict (last one wins)", () => {
    const f = makeFactory({
        sessionId: "orc-v",
        agent: "orchestrator",
        runId: "run-v",
    });
    const cli = makeFactory({
        sessionId: "score-1",
        agent: "user",
        runId: "run-v",
    });
    const idx = new RunIndexer();
    idx.feed(
        sinkOf([
            f.next("session_start", {}, 1),
            f.next(
                "verdict",
                { status: "open", outcome: "needs-review", source: "workflow" },
                2,
            ),
            cli.next(
                "verdict",
                { status: "pass", note: "looks good", source: "cli" },
                3,
            ),
        ]),
    );
    const v = idx.get("run-v")?.verdict;
    assert.equal(v?.status, "pass"); // the later CLI score overrides
    assert.equal(v?.note, "looks good");
    assert.equal(v?.source, "cli");
    assert.equal(v?.ts, 3);
});

test("RunIndexer attributes per-session turn cost to each model", () => {
    const orc = makeFactory({ sessionId: "orc", agent: "orchestrator", runId: "run-mc", cwd: "/p" });
    const sub = makeFactory({ sessionId: "sub", agent: "implementer", parent: "orchestrator", runId: "run-mc", cwd: "/p" });
    const idx = new RunIndexer();
    idx.feed(
        sinkOf([
            orc.next("session_start", { model: "anthropic/claude-fable-5" }, 1),
            orc.next("turn_end", { costUsd: 0.5, tokens: { total: 10 } }, 2),
            sub.next("session_start", { model: "gateframe/gpt-5-nano" }, 3),
            sub.next("turn_end", { costUsd: 0.2, tokens: { total: 5 } }, 4),
            orc.next("turn_end", { costUsd: 0.3, tokens: { total: 8 } }, 5),
        ]),
    );
    const r = idx.get("run-mc")!;
    assert.deepEqual(r.models, ["anthropic/claude-fable-5", "gateframe/gpt-5-nano"]); // sorted
    assert.ok(Math.abs(r.modelCost["anthropic/claude-fable-5"] - 0.8) < 1e-9); // 0.5 + 0.3
    assert.ok(Math.abs(r.modelCost["gateframe/gpt-5-nano"] - 0.2) < 1e-9);
});

test("RunIndexer counts tool_start calls and flags an all-zero (empty) run", () => {
    const f = makeFactory({ sessionId: "orc", agent: "orchestrator", runId: "run-tools", cwd: "/p" });
    const e = makeFactory({ sessionId: "orc2", agent: "orchestrator", runId: "run-empty", cwd: "/p" });
    const idx = new RunIndexer();
    idx.feed(
        sinkOf([
            f.next("session_start", {}, 1),
            f.next("tool_start", { tool: "bash" }, 2),
            f.next("tool_end", {}, 3),
            f.next("tool_start", { tool: "grep" }, 4),
            f.next("turn_end", { costUsd: 0.1, tokens: { total: 5 } }, 5),
            // a do-nothing run: only session start/end, no turns/tools/cost
            e.next("session_start", {}, 6),
            e.next("session_end", {}, 7),
        ]),
    );
    const tools = idx.get("run-tools")!;
    assert.equal(tools.toolCalls, 2); // two tool_start events
    assert.equal(tools.tokens, 5);

    const empty = idx.get("run-empty")!;
    assert.equal(empty.costUsd, 0);
    assert.equal(empty.tokens, 0);
    assert.equal(empty.toolCalls, 0); // ← the dashboard hides this once it's quiet
});

test("agent-scoped verdicts do not become the run-level verdict", () => {
    const f = makeFactory({ sessionId: "orc-av", agent: "orchestrator", runId: "run-av" });
    const cli = makeFactory({ sessionId: "score-av", agent: "user", runId: "run-av" });
    const idx = new RunIndexer();
    idx.feed(
        sinkOf([
            f.next("session_start", {}, 1),
            // a verdict targeting just the implementer's run — must be ignored at run level
            cli.next("verdict", { status: "fail", agent: "implementer", source: "api" }, 2),
        ]),
    );
    assert.equal(idx.get("run-av")?.verdict, undefined); // run stays unscored
});
