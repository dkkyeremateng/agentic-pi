import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptRegistry } from "./obs-prompts";
import { makeFactory, type ObsEvent } from "./obs-events";

// one agent session: session_start (model) + boot (config)
function session(opts: {
    sessionId: string;
    agent: string;
    runId: string;
    model: string;
    ts: number;
    promptHash: string;
    promptChars: number;
    tools?: string[];
    skills?: string[];
}): ObsEvent[] {
    const f = makeFactory({ sessionId: opts.sessionId, agent: opts.agent, runId: opts.runId, cwd: "/p" });
    return [
        f.next("session_start", { model: opts.model }, opts.ts),
        f.next("boot", {
            promptHash: opts.promptHash,
            promptChars: opts.promptChars,
            tools: opts.tools ?? ["read", "bash"],
            skills: opts.skills ?? ["github"],
            contextFiles: [],
        }, opts.ts + 1),
    ];
}

test("groups boots into versions per agent, deduping identical configs", () => {
    const evs = [
        ...session({ sessionId: "s1", agent: "orchestrator", runId: "r1", model: "m", ts: 100, promptHash: "aaa", promptChars: 1000 }),
        ...session({ sessionId: "s2", agent: "orchestrator", runId: "r2", model: "m", ts: 200, promptHash: "aaa", promptChars: 1000 }),
        ...session({ sessionId: "s3", agent: "orchestrator", runId: "r3", model: "m", ts: 300, promptHash: "bbb", promptChars: 1200, skills: ["github", "linear"] }),
    ];
    const reg = buildPromptRegistry(evs);
    assert.equal(reg.length, 1);
    const o = reg[0];
    assert.equal(o.agent, "orchestrator");
    assert.equal(o.versions.length, 2); // aaa (×2 runs) and bbb
    // newest first
    assert.equal(o.versions[0].promptHash, "bbb");
    assert.equal(o.versions[0].model, "m");
    assert.deepEqual(o.versions[0].skills, ["github", "linear"]);
    const aaa = o.versions[1];
    assert.equal(aaa.sessions, 2);
    assert.deepEqual(aaa.runs.sort(), ["r1", "r2"]);
});

test("same prompt hash but different model is a distinct version", () => {
    const evs = [
        ...session({ sessionId: "s1", agent: "scout", runId: "r1", model: "haiku", ts: 100, promptHash: "x", promptChars: 500 }),
        ...session({ sessionId: "s2", agent: "scout", runId: "r2", model: "opus", ts: 200, promptHash: "x", promptChars: 500 }),
    ];
    const reg = buildPromptRegistry(evs);
    assert.equal(reg[0].versions.length, 2);
});

test("agents are sorted; a run with no boot contributes nothing", () => {
    const f = makeFactory({ sessionId: "s9", agent: "planner", runId: "r9", cwd: "/p" });
    const evs = [
        f.next("session_start", { model: "m" }, 10),
        f.next("turn_end", { turnIndex: 0 }, 20), // no boot
        ...session({ sessionId: "s1", agent: "shipper", runId: "r1", model: "m", ts: 100, promptHash: "h", promptChars: 1 }),
    ];
    const reg = buildPromptRegistry(evs);
    assert.deepEqual(reg.map((a) => a.agent), ["shipper"]); // planner had no boot
});
