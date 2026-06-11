import { test } from "node:test";
import assert from "node:assert/strict";
import {
    OBS_SCHEMA,
    makeFactory,
    usageFrom,
    argPreview,
    resultPreview,
    flattenText,
    messageContent,
    capText,
    serializeEvent,
    parseEventLine,
    setObsEmit,
    obsEmit,
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

test("makeFactory carries runId/parent when given, omits them otherwise", () => {
    const linked = makeFactory({
        sessionId: "s1",
        agent: "scout",
        runId: "run-abc",
        parent: "orchestrator",
    });
    const ev = linked.next("session_start");
    assert.equal(ev.runId, "run-abc");
    assert.equal(ev.parent, "orchestrator");

    const root = makeFactory({ sessionId: "s2", agent: "orchestrator" });
    const rev = root.next("session_start");
    assert.equal("runId" in rev, false);
    assert.equal("parent" in rev, false);
});

test("obsEmit routes through a published hook and is a no-op once cleared", () => {
    const seen: { type: string; payload: any }[] = [];
    setObsEmit((type, payload) => seen.push({ type, payload }));
    obsEmit("dispatch_start", { agent: "scout", attempt: 1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "dispatch_start");
    assert.deepEqual(seen[0].payload, { agent: "scout", attempt: 1 });

    // A throwing hook must never bubble out of obsEmit.
    setObsEmit(() => {
        throw new Error("boom");
    });
    assert.doesNotThrow(() => obsEmit("dispatch_end", { agent: "scout" }));

    setObsEmit(undefined);
    assert.doesNotThrow(() => obsEmit("dispatch_start"));
    assert.equal(seen.length, 1); // nothing more captured
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

test("flattenText preserves full text without collapsing whitespace", () => {
    assert.equal(flattenText("a\n  b"), "a\n  b");
    assert.equal(
        flattenText([{ type: "text", text: "line1\n" }, { type: "text", text: "line2" }]),
        "line1\nline2",
    );
    assert.equal(flattenText({ ok: true }), '{\n  "ok": true\n}');
    assert.equal(flattenText(null), "");
});

test("capText truncates with ellipsis, preserves short/newline text", () => {
    assert.equal(capText("hi\nthere", 100), "hi\nthere");
    assert.equal(capText("abcdef", 4), "abc…");
    // non-positive / non-finite max means no limit (full string)
    assert.equal(capText("abcdef", 0), "abcdef");
    assert.equal(capText("abcdef", Infinity), "abcdef");
});

test("messageContent separates text and thinking blocks, capped", () => {
    const m = {
        role: "assistant",
        content: [
            { type: "thinking", thinking: "let me reason about this" },
            { type: "text", text: "Here is the answer." },
            { type: "toolCall", id: "t1", name: "read" },
        ],
    };
    const c = messageContent(m, 1000);
    assert.equal(c.text, "Here is the answer.");
    assert.equal(c.thinking, "let me reason about this");

    const capped = messageContent(
        { role: "assistant", content: [{ type: "text", text: "x".repeat(50) }] },
        10,
    );
    assert.equal(capped.text.length, 10);
    assert.equal(messageContent({}).text, "");
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
