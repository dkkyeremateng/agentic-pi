import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsToOtlp } from "./obs-otel";
import { type ObsEvent } from "./obs-events";

// Minimal event builder for a two-agent run: orchestrator dispatches scout.
function sampleEvents(): ObsEvent[] {
    const mk = (
        agent: string,
        sessionId: string,
        seq: number,
        ts: number,
        type: any,
        payload: any = {},
        parent?: string,
    ): ObsEvent => {
        const e: ObsEvent = {
            v: 2,
            seq,
            ts,
            sessionId,
            agent,
            runId: "run-1",
            type,
            payload,
        };
        if (parent) e.parent = parent;
        return e;
    };
    return [
        mk("orchestrator", "orc", 0, 1000, "session_start", {
            model: "gfr_prt/anthropic/claude-fable-5",
        }),
        mk("orchestrator", "orc", 1, 1100, "turn_start", { turnIndex: 0 }),
        mk("orchestrator", "orc", 2, 5000, "turn_end", {
            turnIndex: 0,
            model: "gfr_prt/anthropic/claude-fable-5",
            tokens: { input: 1200, output: 800, total: 2000 },
            stopReason: "end_turn",
            costUsd: 0.02,
        }),
        mk("orchestrator", "orc", 3, 9000, "session_end", { reason: "done" }),
        // scout, dispatched by the orchestrator
        mk(
            "scout",
            "sct",
            0,
            2000,
            "session_start",
            { model: "gfr/qwen-max:low" },
            "orchestrator",
        ),
        mk("scout", "sct", 1, 2100, "tool_start", {
            toolCallId: "t1",
            toolName: "grep",
        }, "orchestrator"),
        mk("scout", "sct", 2, 2500, "tool_end", {
            toolCallId: "t1",
            toolName: "grep",
            isError: true,
            durationMs: 400,
        }, "orchestrator"),
        mk("scout", "sct", 3, 2600, "turn_start", { turnIndex: 0 }, "orchestrator"),
        mk("scout", "sct", 4, 4000, "turn_end", {
            turnIndex: 0,
            tokens: { input: 900, output: 1400, total: 2300 },
            stopReason: "length",
        }, "orchestrator"),
        mk("scout", "sct", 5, 4200, "session_end", {}, "orchestrator"),
    ];
}

function findSpan(otlp: any, pred: (s: any) => boolean) {
    return otlp.resourceSpans[0].scopeSpans[0].spans.find(pred);
}
function attrVal(span: any, key: string) {
    const a = span.attributes.find((x: any) => x.key === key);
    if (!a) return undefined;
    const v = a.value;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.intValue !== undefined) return v.intValue;
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.arrayValue !== undefined)
        return v.arrayValue.values.map((x: any) => x.stringValue);
    return undefined;
}

test("eventsToOtlp emits an invoke_agent span per agent with gen_ai attrs", () => {
    const otlp = eventsToOtlp(sampleEvents());
    const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
    const orc = findSpan(otlp, (s) => s.name === "invoke_agent orchestrator");
    const scout = findSpan(otlp, (s) => s.name === "invoke_agent scout");
    assert.ok(orc, "orchestrator agent span present");
    assert.ok(scout, "scout agent span present");
    assert.equal(attrVal(orc, "gen_ai.operation.name"), "invoke_agent");
    assert.equal(attrVal(orc, "gen_ai.agent.name"), "orchestrator");
    assert.equal(attrVal(orc, "gen_ai.provider.name"), "gfr_prt");
    // every span shares one trace id (same run)
    const traceIds = new Set(spans.map((s: any) => s.traceId));
    assert.equal(traceIds.size, 1);
});

test("child agent span links to its parent via parentSpanId", () => {
    const otlp = eventsToOtlp(sampleEvents());
    const orc = findSpan(otlp, (s) => s.name === "invoke_agent orchestrator");
    const scout = findSpan(otlp, (s) => s.name === "invoke_agent scout");
    assert.equal(scout.parentSpanId, orc.spanId);
    assert.equal(orc.parentSpanId, undefined); // root
});

test("chat span carries token usage and finish reasons", () => {
    const otlp = eventsToOtlp(sampleEvents());
    const chat = findSpan(
        otlp,
        (s) => attrVal(s, "gen_ai.operation.name") === "chat" && s.name.includes("qwen") === false,
    );
    assert.ok(chat);
    assert.equal(attrVal(chat, "gen_ai.usage.input_tokens"), "1200");
    assert.equal(attrVal(chat, "gen_ai.usage.output_tokens"), "800");
    assert.deepEqual(attrVal(chat, "gen_ai.response.finish_reasons"), ["end_turn"]);
});

test("execute_tool span records the tool name and error status", () => {
    const otlp = eventsToOtlp(sampleEvents());
    const tool = findSpan(otlp, (s) => s.name === "execute_tool grep");
    assert.ok(tool);
    assert.equal(attrVal(tool, "gen_ai.operation.name"), "execute_tool");
    assert.equal(attrVal(tool, "gen_ai.tool.name"), "grep");
    assert.equal(tool.status?.code, 2); // STATUS_ERROR
});

test("times are decimal-string nanoseconds with end >= start", () => {
    const otlp = eventsToOtlp(sampleEvents());
    const orc = findSpan(otlp, (s) => s.name === "invoke_agent orchestrator");
    assert.equal(typeof orc.startTimeUnixNano, "string");
    assert.equal(orc.startTimeUnixNano, "1000000000"); // 1000 ms → ns
    assert.ok(BigInt(orc.endTimeUnixNano) >= BigInt(orc.startTimeUnixNano));
});

test("runId option scopes the export to a single run", () => {
    const evs = sampleEvents();
    // add a second run's event
    evs.push({
        v: 2,
        seq: 0,
        ts: 50000,
        sessionId: "other",
        agent: "planner",
        runId: "run-2",
        type: "session_start",
        payload: {},
    });
    const all = eventsToOtlp(evs);
    const scoped = eventsToOtlp(evs, { runId: "run-1" });
    const names = (o: any) =>
        o.resourceSpans[0].scopeSpans[0].spans.map((s: any) => s.name);
    assert.ok(names(all).includes("invoke_agent planner"));
    assert.equal(names(scoped).includes("invoke_agent planner"), false);
    assert.ok(names(scoped).includes("invoke_agent scout"));
});

test("legacy events without runId still group into a trace by sessionId", () => {
    const ev: ObsEvent = {
        v: 1,
        seq: 0,
        ts: 1000,
        sessionId: "legacy",
        agent: "solo",
        type: "session_start",
        payload: { model: "anthropic/claude-opus-4-8" },
    };
    const otlp = eventsToOtlp([ev]);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.name, "invoke_agent solo");
    assert.equal(attrVal(span, "gen_ai.provider.name"), "anthropic");
});
