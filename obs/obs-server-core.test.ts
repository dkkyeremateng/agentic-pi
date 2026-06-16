import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EventStore,
    summarize,
    sseFrame,
    filterRuns,
    isEmptyFinishedRun,
} from "./obs-server-core";
import { makeFactory, type ObsEvent } from "./obs-events";

function evs(agent: string): {
    start: ObsEvent;
    turn: (tok: number, cost: number) => ObsEvent;
    toolStart: ObsEvent;
    toolEnd: (err: boolean) => ObsEvent;
    f: ReturnType<typeof makeFactory>;
} {
    const f = makeFactory({ sessionId: agent, agent });
    return {
        f,
        start: f.next("session_start", {}, 1),
        turn: (tok, cost) =>
            f.next("turn_end", { tokens: { total: tok }, costUsd: cost }, 2),
        toolStart: f.next("tool_start", { toolName: "read" }, 3),
        toolEnd: (err) => f.next("tool_end", { isError: err }, 4),
    };
}

test("EventStore dedupes by sessionId+seq", () => {
    const s = new EventStore();
    const f = makeFactory({ sessionId: "x", agent: "a" });
    const e = f.next("turn_end", {}, 1);
    assert.equal(s.add(e), true);
    assert.equal(s.add(e), false); // duplicate
    assert.equal(s.size(), 1);
});

test("EventStore caps the ring and forgets dropped keys", () => {
    const s = new EventStore(2);
    const f = makeFactory({ sessionId: "x", agent: "a" });
    s.add(f.next("custom", {}, 1));
    s.add(f.next("custom", {}, 2));
    s.add(f.next("custom", {}, 3));
    assert.equal(s.size(), 2);
    assert.deepEqual(
        s.recent().map((e) => e.seq),
        [1, 2],
    );
});

test("summarize rolls up per-agent turns, tools, tokens and cost", () => {
    const a = evs("scout");
    const b = evs("implementer");
    const all = [
        a.start,
        a.turn(100, 0.01),
        a.toolStart,
        a.toolEnd(false),
        b.start,
        b.turn(900, 0.4),
        b.toolStart,
        b.toolEnd(true),
    ];
    const sum = summarize(all);
    assert.equal(sum.sessions, 2);
    assert.equal(sum.totalEvents, 8);
    assert.equal(sum.totalTokens, 1000);
    assert.ok(Math.abs(sum.totalCostUsd - 0.41) < 1e-9);
    const impl = sum.agents.find((x) => x.agent === "implementer");
    assert.equal(impl?.turns, 1);
    assert.equal(impl?.toolCalls, 1);
    assert.equal(impl?.toolErrors, 1);
    assert.equal(impl?.tokens, 900);
});

test("summarize drops finished no-op sessions but keeps active ones", () => {
    const worked = evs("scout");
    const noop = makeFactory({ sessionId: "orch-1", agent: "orchestrator" });
    const justStarted = makeFactory({ sessionId: "orch-2", agent: "seeker" });
    const sum = summarize([
        worked.start,
        worked.turn(100, 0.01),
        // orchestrator: session start → end, no turns/tools/cost → hidden
        noop.next("session_start", { model: "m" }, 1),
        noop.next("session_end", { reason: "quit" }, 2),
        // seeker: started, no end yet → still active → kept
        justStarted.next("session_start", { model: "m" }, 3),
    ]);
    const names = sum.agents.map((a) => a.agent).sort();
    assert.deepEqual(names, ["scout", "seeker"]); // no "orchestrator" no-op
});

test("summarize ignores verdict events (no synthetic 'user' agent)", () => {
    const a = evs("scout");
    const scorer = makeFactory({ sessionId: "score-1", agent: "user" });
    const sum = summarize([
        a.start,
        a.turn(100, 0.01),
        scorer.next("verdict", { status: "pass", source: "api" }, 5),
    ]);
    assert.equal(sum.agents.find((x) => x.agent === "user"), undefined); // not an agent
    assert.deepEqual(sum.agents.map((x) => x.agent), ["scout"]);
    assert.equal(sum.sessions, 1); // the scorer session doesn't count either
});

test("summarize counts provider error events per agent and in total", () => {
    const f = makeFactory({ sessionId: "s", agent: "scout" });
    const all = [
        f.next("session_start", {}, 1),
        f.next("error", { source: "provider", status: 429 }, 2),
        f.next("error", { source: "provider", status: 503 }, 3),
    ];
    const sum = summarize(all);
    assert.equal(sum.totalErrors, 2);
    assert.equal(sum.agents.find((a) => a.agent === "scout")?.errors, 2);
});

test("sseFrame emits a valid named SSE frame", () => {
    const f = makeFactory({ sessionId: "x", agent: "a" });
    const frame = sseFrame(f.next("turn_start", {}, 1));
    assert.match(frame, /^event: obs\ndata: \{/);
    assert.ok(frame.endsWith("\n\n"));
});

test("filterRuns scopes by project basename, since, and limit", () => {
    const runs = [
        { runId: "c", cwd: "/u/x/proj-b", firstTs: 3000 },
        { runId: "b", cwd: "/u/x/proj-a", firstTs: 2000 },
        { runId: "a", cwd: "/u/x/proj-a", firstTs: 1000 },
    ];
    assert.deepEqual(
        filterRuns(runs, { project: "proj-a" }).map((r) => r.runId),
        ["b", "a"],
    );
    assert.deepEqual(
        filterRuns(runs, { since: 2000 }).map((r) => r.runId),
        ["c", "b"],
    );
    assert.deepEqual(
        filterRuns(runs, { limit: 1 }).map((r) => r.runId),
        ["c"], // latest-first input — limit keeps the newest
    );
    assert.deepEqual(
        filterRuns(runs, { project: "proj-a", since: 2000, limit: 5 }).map((r) => r.runId),
        ["b"],
    );
    assert.equal(filterRuns(runs, {}).length, 3);
});

test("isEmptyFinishedRun hides only quiet all-zero runs", () => {
    const NOW = 1_000_000;
    const quiet = NOW - 200_000; // older than RUN_QUIET_MS (90s)
    const recent = NOW - 1_000;
    // quiet + all zero → hidden
    assert.equal(isEmptyFinishedRun({ costUsd: 0, tokens: 0, toolCalls: 0, lastTs: quiet }, NOW), true);
    // still live (recent) → kept, even though all-zero
    assert.equal(isEmptyFinishedRun({ costUsd: 0, tokens: 0, toolCalls: 0, lastTs: recent }, NOW), false);
    // quiet but did real work → kept
    assert.equal(isEmptyFinishedRun({ costUsd: 0.2, tokens: 0, toolCalls: 0, lastTs: quiet }, NOW), false);
    assert.equal(isEmptyFinishedRun({ costUsd: 0, tokens: 100, toolCalls: 0, lastTs: quiet }, NOW), false);
    assert.equal(isEmptyFinishedRun({ costUsd: 0, tokens: 0, toolCalls: 3, lastTs: quiet }, NOW), false);
    // missing tokens/toolCalls (older server shape) treated as 0
    assert.equal(isEmptyFinishedRun({ costUsd: 0, lastTs: quiet }, NOW), true);
});
