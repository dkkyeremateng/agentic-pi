import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatLine, resolveSessionFile, streamChat } from "./obs-chat";
import { EventEmitter } from "node:events";

test("text_delta frames become token events", () => {
    const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "PONG" },
    });
    assert.deepEqual(parseChatLine(line), { type: "token", text: "PONG" });
});

test("thinking_delta frames become thinking events", () => {
    const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });
    assert.deepEqual(parseChatLine(line), { type: "thinking", text: "hmm" });
});

test("agent_end resolves final assistant text + cost + model", () => {
    const line = JSON.stringify({
        type: "agent_end",
        messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "…" },
                    { type: "text", text: "PONG-ONE" },
                ],
                usage: { cost: { total: 0.0052 } },
                responseModel: "glm-5-2",
            },
        ],
    });
    assert.deepEqual(parseChatLine(line), { type: "done", text: "PONG-ONE", costUsd: 0.0052, model: "glm-5-2" });
});

test("agent_end splits billable (input+output) from cached (cacheRead+cacheWrite) tokens", () => {
    const line = JSON.stringify({
        type: "agent_end",
        messages: [
            {
                role: "assistant",
                content: [{ type: "text", text: "pong!" }],
                usage: { input: 8, output: 4, cacheRead: 69000, cacheWrite: 500, cost: { total: 0.0003 } },
                responseModel: "gemini-3-5-flash",
            },
        ],
    });
    assert.deepEqual(parseChatLine(line), {
        type: "done",
        text: "pong!",
        costUsd: 0.0003,
        model: "gemini-3-5-flash",
        tokens: 12, // input + output, NOT the cached reuse
        cachedTokens: 69500, // cacheRead + cacheWrite
    });
});

test("tool_execution_start/end frames map to tool events", () => {
    assert.deepEqual(parseChatLine(JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" })), {
        type: "tool",
        phase: "start",
        name: "bash",
    });
    assert.deepEqual(parseChatLine(JSON.stringify({ type: "tool_execution_end", toolName: "edit", toolCallId: "c2", isError: false })), {
        type: "tool",
        phase: "end",
        name: "edit",
    });
});

test("noise frames and bad JSON are ignored", () => {
    assert.equal(parseChatLine(JSON.stringify({ type: "turn_start" })), null);
    assert.equal(parseChatLine(JSON.stringify({ type: "message_start", message: { role: "user" } })), null);
    assert.equal(parseChatLine("not json"), null);
    assert.equal(parseChatLine("   "), null);
});

test("resolveSessionFile finds a session by the timestamp_<id>.jsonl convention", () => {
    const base = mkdtempSync(join(tmpdir(), "obs-sess-"));
    try {
        const proj = join(base, "--Users-me-proj--");
        mkdirSync(proj);
        writeFileSync(join(proj, "2026-06-18T10-00-00-000Z_orchestrator-abc-1.jsonl"), "{}");
        writeFileSync(join(proj, "2026-06-18T11-00-00-000Z_other-xyz.jsonl"), "{}");
        const got = resolveSessionFile("orchestrator-abc-1", base);
        assert.ok(got && got.endsWith("_orchestrator-abc-1.jsonl"));
        assert.equal(resolveSessionFile("nope", base), null);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// Fake spawn that records argv and emits a clean agent_end, so we can assert how
// streamChat builds the pi command for an attach (fork) vs a plain turn.
function fakeSpawn(captured: string[][]) {
    return ((_bin: string, args: string[]) => {
        captured.push(args);
        const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => {};
        queueMicrotask(() => {
            proc.stdout.emit(
                "data",
                Buffer.from(
                    JSON.stringify({
                        type: "agent_end",
                        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { cost: { total: 0 } } }],
                    }) + "\n",
                ),
            );
            proc.emit("close", 0);
        });
        return proc;
    }) as unknown as typeof import("node:child_process").spawn;
}

test("streamChat forks the source session on the first turn (no existing session file)", async () => {
    const base = mkdtempSync(join(tmpdir(), "obs-sess-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = base;
    try {
        const proj = join(base, "--p--");
        mkdirSync(proj);
        writeFileSync(join(proj, "2026-01-01T00-00-00-000Z_run-agent-1.jsonl"), "{}");
        const captured: string[][] = [];
        await streamChat(
            { sessionId: "chatNEW", text: "hi", forkFrom: "run-agent-1" },
            () => {},
            { enabled: true, model: "", timeoutMs: 5000 } as never,
            fakeSpawn(captured),
        );
        const args = captured[0];
        const fi = args.indexOf("--fork");
        assert.ok(fi >= 0, "should include --fork");
        assert.ok(args[fi + 1].endsWith("_run-agent-1.jsonl"));
        assert.deepEqual(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2), ["--session-id", "chatNEW"]);
    } finally {
        delete process.env.PI_CODING_AGENT_SESSION_DIR;
        rmSync(base, { recursive: true, force: true });
    }
});

test("streamChat does NOT fork once the chat's own session exists (later turns)", async () => {
    const base = mkdtempSync(join(tmpdir(), "obs-sess-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = base;
    try {
        const proj = join(base, "--p--");
        mkdirSync(proj);
        writeFileSync(join(proj, "2026-01-01T00-00-00-000Z_run-agent-1.jsonl"), "{}");
        writeFileSync(join(proj, "2026-01-02T00-00-00-000Z_chatNEW.jsonl"), "{}"); // our session already exists
        const captured: string[][] = [];
        await streamChat(
            { sessionId: "chatNEW", text: "again", forkFrom: "run-agent-1" },
            () => {},
            { enabled: true, model: "", timeoutMs: 5000 } as never,
            fakeSpawn(captured),
        );
        assert.equal(captured[0].includes("--fork"), false, "later turns must not re-fork");
    } finally {
        delete process.env.PI_CODING_AGENT_SESSION_DIR;
        rmSync(base, { recursive: true, force: true });
    }
});
