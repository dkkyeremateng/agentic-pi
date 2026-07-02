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

test("orchestration wrapper tools/turns are excluded from slow-tool/slow-turn; real leaf outliers still fire", () => {
    const orc = makeFactory({ sessionId: "orc", agent: "orchestrator", runId: "r", cwd: "/p" });
    const wrk = makeFactory({ sessionId: "wrk", agent: "worker", runId: "r", parent: "orchestrator" });
    const T = 1_000;
    const turn = (idx: number, ms: number) =>
        ({ turnIndex: idx, tokens: { total: 100 }, costUsd: 0.01, durationMs: ms });
    const d = buildRunDigest([
        orc.next("session_start", { model: "m" }, T),
        // wrapper tools: huge durations, must NOT be flagged as slow tools
        orc.next("tool_start", { toolCallId: "w1", toolName: "run_agent_workflow" }, T + 1),
        orc.next("tool_end", { toolCallId: "w1", toolName: "run_agent_workflow", durationMs: 300_000 }, T + 2),
        orc.next("tool_start", { toolCallId: "w2", toolName: "dispatch_agent", arg: "worker: do it" }, T + 3),
        orc.next("tool_end", { toolCallId: "w2", toolName: "dispatch_agent", durationMs: 280_000 }, T + 4),
        // orchestrator's own turn blocks on the dispatch → huge, must NOT be a slow turn
        orc.next("turn_end", turn(0, 300_000), T + 5),
        // worker: a genuinely slow leaf tool → SHOULD be a slow tool
        wrk.next("tool_start", { toolCallId: "b1", toolName: "bash", arg: "build" }, T + 6),
        wrk.next("tool_end", { toolCallId: "b1", toolName: "bash", durationMs: 40_000 }, T + 7),
        // worker turns: two quick, one genuinely slow → the slow one SHOULD fire
        wrk.next("turn_end", turn(0, 5_000), T + 8),
        wrk.next("turn_end", turn(1, 5_000), T + 9),
        wrk.next("turn_end", turn(2, 90_000), T + 10),
        orc.next("session_end", {}, T + 11),
    ]);
    const slowTools = d.anomalies.filter((a) => a.kind === "slow-tool");
    assert.equal(slowTools.length, 1);
    assert.match(slowTools[0].detail, /bash took 40s in worker/);
    assert.ok(!slowTools.some((a) => /run_agent_workflow|dispatch_agent/.test(a.detail)), "wrapper tools must not be slow-tool");

    const slowTurns = d.anomalies.filter((a) => a.kind === "slow-turn");
    assert.equal(slowTurns.length, 1);
    assert.match(slowTurns[0].detail, /worker turn 2 took 90s/);
    assert.ok(!slowTurns.some((a) => a.agent === "orchestrator"), "orchestrator blocking turns must not be slow-turn");
    // median is computed over LEAF turns (5s), not the 300s orchestrator turn that would mask it
    assert.match(slowTurns[0].detail, /median turn 5s/);
});

test("digest activeMs is the leaf-work makespan, not wall clock; busyMs sums it", () => {
    const orc = makeFactory({ sessionId: "orc", agent: "orchestrator", runId: "r", cwd: "/p" });
    const wrk = makeFactory({ sessionId: "wrk", agent: "worker", runId: "r", parent: "orchestrator" });
    const T = 1_000_000;
    const d = buildRunDigest([
        orc.next("session_start", { model: "m" }, T),
        orc.next("tool_end", { toolName: "dispatch_agent", durationMs: 300_000 }, T + 300_000),
        orc.next("turn_end", { turnIndex: 0, tokens: { total: 10 }, costUsd: 0.01, durationMs: 300_000 }, T + 300_001),
        // worker: 40s tool + 50s turn (tool nested in the turn window)
        wrk.next("tool_end", { toolName: "bash", durationMs: 40_000 }, T + 100_000),
        wrk.next("turn_end", { turnIndex: 0, tokens: { total: 10 }, costUsd: 0.01, durationMs: 50_000 }, T + 110_000),
        // …then lingers open for 20h before closing
        orc.next("session_end", {}, T + 20 * 3_600_000),
    ]);
    assert.equal(d.wallMs, 20 * 3_600_000); // raw span is the misleading 20h
    assert.equal(d.activeMs, 50_000); // wrapper + orchestrator turn excluded; worker union = 50s
    assert.equal(d.busyMs, 90_000); // 40s tool + 50s turn, summed (no overlap collapse)
    const text = formatRunDigest(d).join("\n");
    assert.match(text, /active 50s · wall 1200m/);
});

test("slow-tool is relative to the tool's own median: a routinely-slow tool is quiet, an outlier fires", () => {
    const f = makeFactory({ sessionId: "s", agent: "worker", runId: "r", cwd: "/p" });
    const call = (id: string, ms: number, at: number) => [
        f.next("tool_start", { toolCallId: id, toolName: "bash", arg: "test" }, at),
        f.next("tool_end", { toolCallId: id, toolName: "bash", durationMs: ms }, at + 1),
    ];
    // Four bash runs all ~35-40s (routinely slow) → none is an outlier vs its own median.
    const routine = buildRunDigest([
        f.next("session_start", { model: "m" }, 0),
        ...call("a", 35_000, 10),
        ...call("b", 36_000, 20),
        ...call("c", 38_000, 30),
        ...call("d", 40_000, 40),
        f.next("session_end", {}, 100),
    ]);
    assert.equal(routine.anomalies.filter((a) => a.kind === "slow-tool").length, 0, "routinely-slow tool must not flag");

    // Same tool, but one call runs 4× its peers → that one is flagged.
    const outlier = buildRunDigest([
        f.next("session_start", { model: "m" }, 0),
        ...call("a", 5_000, 10),
        ...call("b", 6_000, 20),
        ...call("c", 5_000, 30),
        ...call("d", 120_000, 40),
        f.next("session_end", {}, 200),
    ]);
    const flagged = outlier.anomalies.filter((a) => a.kind === "slow-tool");
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].detail, /bash took 120s in worker/);
});
