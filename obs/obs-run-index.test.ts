import { test } from "node:test";
import assert from "node:assert/strict";
import { LineScanner, RunIndexer, intervalUnionMs } from "./obs-run-index";
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

test("RunIndexer captures the root's first boot request as the run title", () => {
    const f = makeFactory({ sessionId: "orchestrator-r1", agent: "orchestrator", cwd: "/proj/pi", runId: "run-r1" });
    const idx = new RunIndexer();
    idx.feed(
        Buffer.from(
            [
                serializeEvent(f.next("session_start", { model: "m" }, 1)),
                serializeEvent(f.next("boot", { request: "add rate limiting to the API", promptChars: 10 }, 2)),
                serializeEvent(f.next("boot", { request: "a later boot — ignored", promptChars: 10 }, 3)),
            ].join("\n") + "\n",
        ),
    );
    assert.equal(idx.get("run-r1")?.request, "add rate limiting to the API"); // first wins
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

// ── active makespan ──────────────────────────────────────────────────────────

test("intervalUnionMs: merges overlaps, sums disjoint, ignores empties", () => {
    assert.equal(intervalUnionMs([]), 0);
    assert.equal(intervalUnionMs([[0, 100]]), 100);
    assert.equal(intervalUnionMs([[0, 100], [50, 150]]), 150); // overlap counted once
    assert.equal(intervalUnionMs([[0, 100], [100, 150]]), 150); // touching
    assert.equal(intervalUnionMs([[0, 100], [200, 250]]), 150); // 100 + 50, the gap excluded
    assert.equal(intervalUnionMs([[0, 100], [10, 20]]), 100); // fully contained
    assert.equal(intervalUnionMs([[50, 50], [0, 10]]), 10); // zero-length dropped
});

test("activeMs excludes the idle/abandoned tail (the 20h-latency bug)", () => {
    const f = makeFactory({ sessionId: "s", agent: "worker", runId: "run-idle" });
    const T = 1_000_000;
    const idx = new RunIndexer();
    idx.feed(
        sinkOf([
            f.next("session_start", { model: "m" }, T),
            f.next("tool_end", { toolName: "bash", durationMs: 60_000 }, T + 60_000),
            f.next("turn_end", { durationMs: 120_000, tokens: { total: 10 } }, T + 180_000),
            // …then the session lingers open and a close event lands 20h later
            f.next("session_end", {}, T + 20 * 3_600_000),
        ]),
    );
    const r = idx.get("run-idle")!;
    assert.equal(r.lastTs - r.firstTs, 20 * 3_600_000); // wall clock is the misleading 20h
    // active = union of the 60s tool span and the 120s turn span (they overlap: the
    // tool ran inside the turn window T+60s..T+180s) → 180s, NOT 20h.
    assert.equal(r.activeMs, 180_000);
});

test("activeMs excludes orchestrator blocking turns and wrapper tools; counts real leaf work", () => {
    const orc = makeFactory({ sessionId: "orc", agent: "orchestrator", runId: "run-orch" });
    const wrk = makeFactory({ sessionId: "wrk", agent: "worker", runId: "run-orch", parent: "orchestrator" });
    const T = 1_000_000;
    const idx = new RunIndexer();
    idx.feed(
        sinkOf([
            orc.next("session_start", { model: "m" }, T),
            // orchestrator dispatches the worker: the wrapper tool_end (flags the
            // orchestrator) precedes the orchestrator's own blocking turn_end.
            orc.next("tool_end", { toolName: "dispatch_agent", durationMs: 300_000 }, T + 300_000),
            orc.next("turn_end", { durationMs: 300_000, tokens: { total: 10 } }, T + 300_001),
            // the worker did 40s of real tool work + a 50s turn inside that window
            wrk.next("tool_end", { toolName: "bash", durationMs: 40_000 }, T + 100_000),
            wrk.next("turn_end", { durationMs: 50_000, tokens: { total: 10 } }, T + 110_000),
            orc.next("session_end", {}, T + 300_002),
        ]),
    );
    const r = idx.get("run-orch")!;
    // wrapper tool (300s) and orchestrator turn (300s) excluded; only the worker's
    // 40s tool + 50s turn count, unioned over T+60s..T+110s → 50s.
    assert.equal(r.activeMs, 50_000);
});
