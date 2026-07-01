import { test } from "node:test";
import assert from "node:assert/strict";
import { planReap, reapEvent } from "./obs-reap";
import type { ObsEvent } from "./obs-events";

// Minimal event builder — only the fields planReap reads.
let seq = 0;
function ev(sessionId: string, type: ObsEvent["type"], ts: number, extra: Partial<ObsEvent> = {}): ObsEvent {
    return { v: 2, seq: seq++, ts, sessionId, agent: extra.agent ?? "orchestrator", type, payload: {}, ...extra };
}

const MIN = 60_000;

test("planReap closes a started-but-never-ended lane past the stale window", () => {
    const now = 1_000_000_000;
    const events = [
        ev("a", "session_start", now - 100 * MIN),
        ev("a", "turn_end", now - 99 * MIN),
    ];
    const plan = planReap(events, now, 30 * MIN, new Set());
    assert.equal(plan.orphans.length, 1);
    assert.equal(plan.orphans[0].sessionId, "a");
    assert.equal(plan.orphans[0].lastTs, now - 99 * MIN); // last real activity
    assert.equal(plan.sessions, 1);
});

test("planReap leaves cleanly-ended sessions alone", () => {
    const now = 1_000_000_000;
    const events = [
        ev("a", "session_start", now - 100 * MIN),
        ev("a", "session_end", now - 98 * MIN),
    ];
    const plan = planReap(events, now, 30 * MIN, new Set());
    assert.equal(plan.orphans.length, 0);
    assert.equal(plan.ended, 1);
});

test("planReap never reaps a live session even if it looks stalled", () => {
    const now = 1_000_000_000;
    const events = [ev("live1", "session_start", now - 100 * MIN)];
    const plan = planReap(events, now, 30 * MIN, new Set(["live1"]));
    assert.equal(plan.orphans.length, 0);
    assert.equal(plan.live, 1);
});

test("planReap skips lanes still inside the stale window (may be mid-work)", () => {
    const now = 1_000_000_000;
    const events = [
        ev("recent", "session_start", now - 20 * MIN),
        ev("recent", "tool_start", now - 5 * MIN),
    ];
    const plan = planReap(events, now, 30 * MIN, new Set());
    assert.equal(plan.orphans.length, 0);
    assert.equal(plan.fresh, 1);
});

test("planReap ignores lanes that never emitted session_start", () => {
    const now = 1_000_000_000;
    const events = [ev("partial", "turn_end", now - 100 * MIN)];
    const plan = planReap(events, now, 30 * MIN, new Set());
    assert.equal(plan.orphans.length, 0);
    assert.equal(plan.sessions, 1);
});

test("reapEvent closes the lane with a monotonic seq at last activity", () => {
    const now = 1_000_000_000;
    const events = [
        ev("a", "session_start", now - 100 * MIN, { runId: "run-1", cwd: "/work" }),
        ev("a", "turn_end", now - 99 * MIN, { runId: "run-1" }),
    ];
    const [orphan] = planReap(events, now, 30 * MIN, new Set()).orphans;
    const end = reapEvent(orphan, now);
    assert.equal(end.type, "session_end");
    assert.equal(end.sessionId, "a");
    assert.equal(end.runId, "run-1");
    assert.equal(end.cwd, "/work");
    assert.equal(end.seq, orphan.lastSeq + 1); // monotonic per session
    assert.equal(end.ts, orphan.lastTs); // stamped at last activity, not reap time
    assert.equal(end.payload.reason, "reaped");
    assert.equal(end.payload.reapedAt, now);
});
