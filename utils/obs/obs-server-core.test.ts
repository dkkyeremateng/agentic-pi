import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EventStore,
    summarize,
    sseFrame,
    filterRuns,
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
