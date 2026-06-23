import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunDigest, formatRunDigest, runAutoVerdict } from "./obs-explain";
import { makeFactory, type ObsEvent } from "./obs-events";

// A small but eventful run: orchestrator + scout (retried once), a failing and
// a slow tool, a truncated turn, a compaction, and a CLI verdict.
function fixtures(): ObsEvent[] {
    const orc = makeFactory({
        sessionId: "orc-1",
        agent: "orchestrator",
        cwd: "/p/alpha",
        runId: "run-x",
    });
    const sct = makeFactory({
        sessionId: "sct-1",
        agent: "scout",
        cwd: "/p/alpha",
        runId: "run-x",
        parent: "orchestrator",
    });
    const cli = makeFactory({
        sessionId: "score-1",
        agent: "user",
        runId: "run-x",
    });
    const T = 1_000_000;
    return [
        orc.next("session_start", { model: "anthropic/claude-x" }, T),
        orc.next(
            "boot",
            { tools: ["a", "b"], skills: ["s"], contextFiles: [], promptChars: 3000 },
            T + 50,
        ),
        orc.next("dispatch_start", { agent: "scout", dispatchId: "d1" }, T + 100),
        orc.next(
            "dispatch_retry",
            { agent: "scout", reason: "empty", dispatchId: "d1" },
            T + 200,
        ),
        sct.next("session_start", { model: "anthropic/claude-x" }, T + 300),
        sct.next("tool_start", { toolCallId: "t1", toolName: "bash", arg: "npm test" }, T + 400),
        sct.next(
            "tool_end",
            {
                toolCallId: "t1",
                toolName: "bash",
                isError: true,
                durationMs: 500,
                result: "Exit code 1",
            },
            T + 900,
        ),
        sct.next("tool_start", { toolCallId: "t2", toolName: "bash", arg: "npx play" }, T + 1000),
        sct.next(
            "tool_end",
            { toolCallId: "t2", toolName: "bash", durationMs: 45_000 },
            T + 46_000,
        ),
        sct.next(
            "turn_end",
            {
                turnIndex: 0,
                tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
                costUsd: 0.05,
                durationMs: 46_000,
                stopReason: "length",
                context: { percent: 82 },
            },
            T + 47_000,
        ),
        sct.next("session_end", {}, T + 47_100),
        orc.next("compaction", {}, T + 48_000),
        orc.next(
            "turn_end",
            {
                turnIndex: 0,
                tokens: { input: 100, output: 50, cacheRead: 5, cacheWrite: 5, total: 160 },
                costUsd: 0.6,
                durationMs: 2_000,
            },
            T + 50_000,
        ),
        orc.next("session_end", { reason: "done" }, T + 51_000),
        // appended much later — must not stretch the wall clock
        cli.next("verdict", { status: "fail", note: "bad PR", source: "cli" }, T + 999_999),
    ];
}

test("buildRunDigest aggregates totals and bounds (verdict excluded from bounds)", () => {
    const d = buildRunDigest(fixtures());
    assert.equal(d.runId, "run-x");
    assert.equal(d.cwd, "/p/alpha");
    assert.equal(d.wallMs, 51_000); // verdict at +999s did NOT stretch it
    assert.equal(d.totals.turns, 2);
    assert.equal(d.totals.toolCalls, 2);
    assert.equal(d.totals.toolErrors, 1);
    assert.equal(d.totals.retries, 1);
    assert.equal(d.totals.compactions, 1);
    assert.ok(Math.abs(d.totals.costUsd - 0.65) < 1e-9);
    assert.equal(d.totals.tokens.total, 190);
    assert.deepEqual(d.models, ["anthropic/claude-x"]);
    assert.equal(d.verdict?.status, "fail");
    assert.equal(d.verdict?.note, "bad PR");
    // agents ordered by start; no "user" agent from the verdict
    assert.deepEqual(
        d.agents.map((a) => a.agent),
        ["orchestrator", "scout"],
    );
    assert.equal(d.agents[1].maxContextPct, 82);
});

test("buildRunDigest routes agent-scoped verdicts into agentVerdicts, leaving the run verdict alone", () => {
    const cli = makeFactory({ sessionId: "score-2", agent: "user", runId: "run-x" });
    const evs = [
        ...fixtures(), // already carries a run-level "fail" verdict
        cli.next("verdict", { status: "pass", agent: "scout", source: "api" }, 1_000_000),
    ];
    const d = buildRunDigest(evs);
    assert.equal(d.verdict?.status, "fail"); // whole-run verdict untouched
    assert.equal(d.agentVerdicts?.scout?.status, "pass"); // scout scored on its own
    assert.equal(d.agentVerdicts?.orchestrator, undefined); // others unscored
});

test("runAutoVerdict: hard failures fail, clean work passes, empty is null", () => {
    // the fixture run had a provider/dispatch/truncated path → fail
    assert.equal(runAutoVerdict(buildRunDigest(fixtures())), "fail");

    // a clean run that did work with only a routine tool error → pass
    const f = makeFactory({ sessionId: "s", agent: "orchestrator", runId: "ok", cwd: "/p" });
    const clean = buildRunDigest([
        f.next("session_start", { model: "m" }, 0),
        f.next("tool_start", { tool: "bash", toolCallId: "t" }, 1),
        f.next("tool_end", { tool: "bash", toolCallId: "t", isError: true }, 2), // routine tool error
        f.next("turn_end", { turnIndex: 0, tokens: { total: 100 }, costUsd: 0.01 }, 3),
        f.next("session_end", {}, 4),
    ]);
    assert.equal(runAutoVerdict(clean), "pass");

    // a session that did no work → nothing to judge
    const empty = buildRunDigest([
        f.next("session_start", { model: "m" }, 0),
        f.next("session_end", {}, 1),
    ]);
    assert.equal(runAutoVerdict(empty), null);
});

test("buildRunDigest detects the anomaly set", () => {
    const d = buildRunDigest(fixtures());
    const kinds = d.anomalies.map((a) => a.kind);
    for (const k of ["retry", "tool-error", "truncated", "slow-tool", "compaction", "context"])
        assert.ok(kinds.includes(k as any), `missing anomaly kind ${k}`);
    const toolErr = d.anomalies.find((a) => a.kind === "tool-error")!;
    assert.match(toolErr.detail, /bash failed in scout/);
    assert.match(toolErr.detail, /npm test/);
    assert.match(toolErr.detail, /Exit code 1/);
    const slow = d.anomalies.find((a) => a.kind === "slow-tool")!;
    assert.match(slow.detail, /bash took 45s in scout/);
});

test("formatRunDigest renders the section headers and key lines", () => {
    const text = formatRunDigest(buildRunDigest(fixtures())).join("\n");
    for (const h of ["# Run digest — run-x", "## Timeline", "## Anomalies", "## Agents", "## Tools", "## Setup"])
        assert.ok(text.includes(h), `missing section ${h}`);
    assert.match(text, /verdict: fail \[cli\] — bad PR/);
    assert.match(text, /\[retry\] scout re-dispatched \(reason: empty\)/);
    assert.match(text, /2 tools \(1 err\)/);
});

test("buildRunDigest handles an empty event list", () => {
    const d = buildRunDigest([]);
    assert.equal(d.totals.turns, 0);
    assert.equal(d.agents.length, 0);
    assert.equal(d.anomalies.length, 0);
});

test("overflow compaction enriches the agent's compaction anomaly; routine stays plain", () => {
    const f = makeFactory({ sessionId: "s", agent: "implementer", runId: "r" });
    const overflow = buildRunDigest([
        f.next("session_start", { model: "m" }, 1000),
        f.next("compaction", { reason: "overflow", willRetry: true, tokensBefore: 184320 }, 2000),
    ]);
    assert.equal(overflow.totals.compactions, 1);
    // one compaction anomaly (the per-agent rollup), now enriched with overflow detail
    const anoms = overflow.anomalies.filter((a) => a.kind === "compaction");
    assert.equal(anoms.length, 1);
    assert.match(anoms[0].detail, /from overflow, turn retried/);
    assert.match(anoms[0].detail, /184,320 tokens before/);

    const routine = buildRunDigest([
        f.next("session_start", { model: "m" }, 1000),
        f.next("compaction", { reason: "threshold" }, 2000),
    ]);
    assert.equal(routine.totals.compactions, 1);
    const r = routine.anomalies.filter((a) => a.kind === "compaction");
    assert.equal(r.length, 1);
    assert.doesNotMatch(r[0].detail, /overflow/);
});
