import { test } from "node:test";
import assert from "node:assert/strict";
import {
    OBS_SCHEMA,
    makeFactory,
    usageFrom,
    argPreview,
    resultPreview,
    serializeEvent,
    parseEventLine,
} from "./obs-events";

test("makeFactory stamps schema, increments seq, carries identity", () => {
    const f = makeFactory({ sessionId: "s1", agent: "scout", cwd: "/p" });
    const a = f.next("session_start", {}, 1000);
    const b = f.next("turn_end", { x: 1 }, 2000);
    assert.equal(a.v, OBS_SCHEMA);
    assert.equal(a.seq, 0);
    assert.equal(b.seq, 1);
    assert.equal(a.sessionId, "s1");
    assert.equal(b.agent, "scout");
    assert.equal(a.cwd, "/p");
    assert.equal(b.ts, 2000);
    assert.deepEqual(b.payload, { x: 1 });
});

test("usageFrom normalizes the message usage block", () => {
    const u = usageFrom({
        usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 0,
            totalTokens: 160,
            cost: { total: 0.012 },
        },
    });
    assert.equal(u?.input, 100);
    assert.equal(u?.total, 160);
    assert.equal(u?.costUsd, 0.012);
    assert.equal(usageFrom({}), undefined);
});

test("argPreview prefers informative fields and truncates", () => {
    assert.equal(argPreview({ command: "ls -la" }), "ls -la");
    assert.equal(argPreview({ path: ".agent/plan.md" }), ".agent/plan.md");
    assert.equal(argPreview("x".repeat(200)).length, 120);
    assert.equal(argPreview(null), "");
});

test("resultPreview flattens text blocks and trims", () => {
    assert.equal(
        resultPreview([{ type: "text", text: "hello\n  world" }]),
        "hello world",
    );
    assert.ok(resultPreview("y".repeat(300)).endsWith("…"));
});

test("serialize/parse round-trips, parse rejects malformed", () => {
    const f = makeFactory({ sessionId: "s1", agent: "impl" });
    const ev = f.next("tool_start", { toolName: "read" }, 5);
    const line = serializeEvent(ev);
    const back = parseEventLine(line);
    assert.deepEqual(back, ev);
    assert.equal(parseEventLine(""), null);
    assert.equal(parseEventLine("{not json"), null);
    assert.equal(parseEventLine('{"foo":1}'), null); // missing required fields
});
