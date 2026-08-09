import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWatchEvent, parseArgs, sinkPath, idleTimeoutMs} from "./obs-watch";
import { makeFactory } from "./obs-events";

// Force plain output for stable assertions (obs-watch reads NO_COLOR at import).
const strip = (s: string | null) => (s == null ? null : s.replace(/\x1b\[[0-9;]*m/g, ""));

const f = makeFactory({ sessionId: "s", agent: "scout", runId: "r" });

test("formatWatchEvent renders the events a lane cares about", () => {
    assert.match(strip(formatWatchEvent(f.next("session_start", { model: "anthropic/claude-x" }, 0)))!, /▶ start · anthropic\/claude-x/);

    const turn = strip(
        formatWatchEvent(
            f.next("turn_end", { turnIndex: 1, tokens: { total: 4200 }, costUsd: 0.12, context: { percent: 63 } }, 0),
        ),
    )!;
    assert.match(turn, /● turn 1/);
    assert.match(turn, /4\.2k tok/);
    assert.match(turn, /\$0\.12/);
    assert.match(turn, /ctx 63%/);

    assert.match(strip(formatWatchEvent(f.next("tool_end", { toolName: "bash", durationMs: 2500 }, 0)))!, /✓ bash 2\.5s/);
    assert.match(strip(formatWatchEvent(f.next("tool_end", { toolName: "bash", isError: true, durationMs: 40 }, 0)))!, /✖ bash 40ms/);
    assert.match(strip(formatWatchEvent(f.next("error", { status: 529 }, 0)))!, /provider error \(status 529\)/);
    assert.match(strip(formatWatchEvent(f.next("compaction", { reason: "overflow" }, 0)))!, /↻ compaction \(overflow\)/);
    assert.match(strip(formatWatchEvent(f.next("session_end", {}, 0)))!, /■ done/);
});

test("formatWatchEvent surfaces the detail: tool command, tool result, and agent prose", () => {
    // tool_start shows the command being run
    assert.match(
        strip(formatWatchEvent(f.next("tool_start", { toolName: "bash", arg: "command=playwright-cli -s=google" }, 0)))!,
        /→ bash command=playwright-cli -s=google/,
    );
    // tool_end shows its result preview on a second line
    const te = strip(formatWatchEvent(f.next("tool_end", { toolName: "bash", durationMs: 900, result: "Exit code 0 — page loaded" }, 0)))!;
    assert.match(te, /✓ bash 900ms/);
    assert.match(te, /Exit code 0 — page loaded/);
    // assistant prose (only present when PI_OBS_CONTENT=1) is rendered, indented
    const msg = strip(formatWatchEvent(f.next("message", { role: "assistant", kind: "assistant", text: "# Report\nThe page loaded fine." }, 0)))!;
    assert.match(msg, /assistant/);
    assert.match(msg, /# Report/);
    assert.match(msg, /The page loaded fine\./);
});

test("formatWatchEvent flags a truncated turn and skips empty/uninteresting events", () => {
    const trunc = strip(formatWatchEvent(f.next("turn_end", { turnIndex: 0, tokens: { total: 10 }, costUsd: 0, stopReason: "length" }, 0)))!;
    assert.match(trunc, /TRUNCATED/);
    assert.equal(formatWatchEvent(f.next("message", { kind: "assistant", text: "   " }, 0)), null); // empty prose
    assert.equal(formatWatchEvent(f.next("boot", {}, 0)), null);
});

test("formatWatchEvent renders dispatch retries and failed dispatches, skips clean ones", () => {
    assert.match(strip(formatWatchEvent(f.next("dispatch_retry", { reason: "empty" }, 0)))!, /↻ dispatch retry \(empty\)/);
    assert.match(strip(formatWatchEvent(f.next("dispatch_end", { status: "error", reason: "truncated" }, 0)))!, /✖ dispatch error \(truncated\)/);
    assert.equal(formatWatchEvent(f.next("dispatch_end", { status: "done" }, 0)), null); // a clean finish is not lane-worthy
});

test("parseArgs reads --run/--agent/--sink/--dispatch and lowercases the agent", () => {
    assert.deepEqual(parseArgs(["--run", "r1", "--agent", "Scout", "--sink", "/s"]), { run: "r1", agent: "scout", sink: "/s" });
    assert.deepEqual(parseArgs(["--run", "r1", "--agent", "scout", "--dispatch", "scout-9"]), { run: "r1", agent: "scout", dispatch: "scout-9" });
    assert.deepEqual(parseArgs([]), {});
});

test("sinkPath honors PI_OBS_SINK (with ~) else the default global sink", () => {
    assert.equal(sinkPath({ PI_OBS_SINK: "/tmp/x/events.jsonl" }), "/tmp/x/events.jsonl");
    assert.match(sinkPath({}), /\.pi\/agent\/obs\/events\.jsonl$/);
});

// The old absolute cap reaped panes out from under working agents: an implementer
// that ran 95 minutes lost its pane at the 60-minute mark, two thirds through.
test("idleTimeoutMs defaults to 15 minutes of SILENCE, not wall-clock", () => {
    assert.equal(idleTimeoutMs({}), 15 * 60_000);
    // Long enough to outlast a slow suite; the gaps between events are far
    // smaller than the 5-31 minute phase durations observed in real runs.
    assert.ok(idleTimeoutMs({}) >= 10 * 60_000);
});

test("idleTimeoutMs honours an explicit override", () => {
    assert.equal(idleTimeoutMs({ PI_WORKFLOW_PANE_MAX_MS: "60000" }), 60_000);
});

test("idleTimeoutMs falls back on junk, zero and negatives", () => {
    // 0 or NaN would arm setTimeout(0) and kill the pane instantly, or disable the
    // backstop entirely — both worse than the default.
    for (const v of ["", "junk", "0", "-1", "NaN"])
        assert.equal(
            idleTimeoutMs({ PI_WORKFLOW_PANE_MAX_MS: v }),
            15 * 60_000,
            `bad value ${JSON.stringify(v)} should fall back`,
        );
});
