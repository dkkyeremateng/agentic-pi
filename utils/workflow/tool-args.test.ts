import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceJsonArrayArg } from "./tool-args";

describe("coerceJsonArrayArg", () => {
    it("parses the shape that actually failed in production", () => {
        // dispatch_parallel died on `agents.0: must be object` twice in a month,
        // because the model sent the whole array as one JSON string.
        const args = {
            agents: '[{"agent":"phase-implementer","task":"Implement Phase 1"}]',
        };
        const out = coerceJsonArrayArg(args, "agents");
        assert.ok(Array.isArray(out.agents));
        assert.deepEqual(out.agents, [
            { agent: "phase-implementer", task: "Implement Phase 1" },
        ]);
    });

    it("handles an array of strings too", () => {
        const out = coerceJsonArrayArg({ agents: '["scout","planner"]' }, "agents");
        assert.deepEqual(out.agents, ["scout", "planner"]);
    });

    it("returns the SAME object when nothing needed coercing", () => {
        // prepareArguments compares its result to the input by identity to decide
        // whether anything changed, so an unnecessary copy is not free.
        const args = { agents: [{ agent: "scout", task: "x" }] };
        assert.equal(coerceJsonArrayArg(args, "agents"), args);
    });

    it("leaves malformed JSON to the schema's own error", () => {
        // A parse error raised here would replace a precise validation message
        // with a worse one.
        const args = { agents: "[{oops" };
        assert.equal(coerceJsonArrayArg(args, "agents"), args);
    });

    it("only coerces to an array, never to an object or scalar", () => {
        const obj = { agents: '{"agent":"scout"}' };
        assert.equal(coerceJsonArrayArg(obj, "agents"), obj);
        const num = { agents: "3" };
        assert.equal(coerceJsonArrayArg(num, "agents"), num);
        const str = { agents: '"scout"' };
        assert.equal(coerceJsonArrayArg(str, "agents"), str);
    });

    it("does not touch other keys", () => {
        const args = { agents: '["a"]', task: '["not","this"]' };
        const out = coerceJsonArrayArg(args, "agents");
        assert.deepEqual(out.agents, ["a"]);
        assert.equal(out.task, '["not","this"]', "task is left as sent");
    });

    it("passes through a missing key, and non-object input", () => {
        const empty = {};
        assert.equal(coerceJsonArrayArg(empty, "agents"), empty);
        assert.equal(coerceJsonArrayArg(null as any, "agents"), null);
        assert.equal(coerceJsonArrayArg(undefined as any, "agents"), undefined);
        assert.equal(coerceJsonArrayArg("nope" as any, "agents"), "nope");
    });

    it("does not validate the array's contents", () => {
        // Schema validation runs immediately after and is better at it; this
        // only fixes the container.
        const out = coerceJsonArrayArg({ agents: "[1,2,3]" }, "agents");
        assert.deepEqual(out.agents, [1, 2, 3]);
    });
});
