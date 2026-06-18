import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveChatControl, listLiveSessions, sidecarPath, sockPath, isPidAlive, type LiveSessionMeta } from "./obs-chat-control";
import type { ChatEvent } from "./obs-chat";

test("LiveChatControl streams a steered reply scoped to its agent run", () => {
    const frames: ChatEvent[] = [];
    const c = new LiveChatControl();
    assert.equal(c.busy(), false);

    // events before the prompt's agent run are ignored
    c.onAssistantEvent({ type: "text_delta", delta: "STRAY" });
    assert.equal(frames.length, 0);

    assert.equal(c.beginPrompt((f) => frames.push(f)), true);
    assert.equal(c.busy(), true);
    // a second concurrent prompt is rejected
    assert.equal(c.beginPrompt(() => {}), false);

    c.onAgentStart();
    c.onAssistantEvent({ type: "thinking_delta", delta: "hmm" });
    c.onAssistantEvent({ type: "text_delta", delta: "Hel" });
    c.onAssistantEvent({ type: "text_delta", delta: "lo" });
    c.onTurnEnd(0.0021, "glm-5-2");
    c.onAgentEnd();

    assert.deepEqual(frames, [
        { type: "thinking", text: "hmm" },
        { type: "token", text: "Hel" },
        { type: "token", text: "lo" },
        { type: "done", text: "Hello", costUsd: 0.0021, model: "glm-5-2" },
    ]);
    assert.equal(c.busy(), false);
});

test("LiveChatControl sums tokens across turns into the done frame", () => {
    const frames: ChatEvent[] = [];
    const c = new LiveChatControl();
    c.beginPrompt((f) => frames.push(f));
    c.onAgentStart();
    c.onAssistantEvent({ type: "text_delta", delta: "ok" });
    c.onTurnEnd(0.001, "m", 120);
    c.onTurnEnd(0.002, "m", 80); // a second turn (tool use) in the same run
    c.onAgentEnd();
    const done = frames.find((f) => f.type === "done");
    assert.deepEqual(done, { type: "done", text: "ok", costUsd: 0.003, model: "m", tokens: 200 });
});

test("LiveChatControl.fail emits a terminal error and releases", () => {
    const frames: ChatEvent[] = [];
    const c = new LiveChatControl();
    c.beginPrompt((f) => frames.push(f));
    c.fail("inject failed");
    assert.deepEqual(frames, [{ type: "error", error: "inject failed" }]);
    assert.equal(c.busy(), false);
    // a done after a fail is a no-op (no double terminal)
    c.onAgentEnd();
    assert.equal(frames.length, 1);
});

test("listLiveSessions returns pid-alive sessions and prunes dead ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-ctrl-"));
    process.env.PI_OBS_CONTROL_DIR = dir;
    try {
        const aliveSid = "orchestrator-alive-1";
        const deadSid = "scout-dead-1";
        const mk = (sid: string, pid: number): LiveSessionMeta => ({
            sessionId: sid,
            agent: sid.split("-")[0],
            cwd: "/p",
            pid,
            startedTs: Date.now(),
            sock: sockPath(sid),
        });
        writeFileSync(sidecarPath(aliveSid), JSON.stringify(mk(aliveSid, process.pid)));
        writeFileSync(sockPath(aliveSid), ""); // stand-in socket file
        writeFileSync(sidecarPath(deadSid), JSON.stringify(mk(deadSid, 2_000_000_000)));
        writeFileSync(sockPath(deadSid), "");

        const got = listLiveSessions();
        assert.deepEqual(got.map((m) => m.sessionId), [aliveSid]);
        // dead sidecar + socket pruned
        assert.equal(existsSync(sidecarPath(deadSid)), false);
        assert.equal(existsSync(sockPath(deadSid)), false);
    } finally {
        delete process.env.PI_OBS_CONTROL_DIR;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("isPidAlive: current process alive, absurd pid dead", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(2_000_000_000), false);
});
