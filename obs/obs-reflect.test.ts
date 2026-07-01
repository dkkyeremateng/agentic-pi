import { test } from "node:test";
import assert from "node:assert/strict";
import { reflectSystem, reflectInputText, parseAgentLessons, reflectSinkPath } from "./obs-reflect";

test("reflectSystem lists the run's agents and constrains output", () => {
    const s = reflectSystem(["validator", "seeker"]);
    assert.match(s, /FAILED/);
    assert.match(s, /validator, seeker/);
    assert.match(s, /JSON array/);
});

test("reflectInputText clamps a huge digest", () => {
    const big = "x".repeat(20_000);
    const out = reflectInputText(big);
    assert.ok(out.length < big.length);
    assert.match(out, /truncated/);
    assert.equal(reflectInputText("small"), "small");
});

test("parseAgentLessons keeps only known-agent, valid lessons; dedups; caps", () => {
    const raw = JSON.stringify([
        { agent: "validator", lesson: "Check the project is a git repo before running git-based checks." },
        { agent: "Validator", lesson: "check the project is a git repo before running git-based checks" }, // dup (case)
        { agent: "seeker", lesson: "Confirm the browser binary path is allowed before launching it." },
        { agent: "ghost", lesson: "should be dropped (unknown agent)" },
        { agent: "validator", lesson: "" }, // empty dropped
        { agent: "validator", lesson: "x".repeat(500) }, // overlong dropped
    ]);
    const out = parseAgentLessons(raw, ["validator", "seeker", "implementer"]);
    assert.deepEqual(out, [
        { agent: "validator", text: "Check the project is a git repo before running git-based checks." },
        { agent: "seeker", text: "Confirm the browser binary path is allowed before launching it." },
    ]);
});

test("parseAgentLessons tolerates prose around the array and bad JSON", () => {
    assert.deepEqual(parseAgentLessons('here you go: [{"agent":"validator","lesson":"prefer the app test command"}] done', ["validator"]), [
        { agent: "validator", text: "prefer the app test command" },
    ]);
    assert.deepEqual(parseAgentLessons("not json at all", ["validator"]), []);
    assert.deepEqual(parseAgentLessons("[]", ["validator"]), []);
});

test("reflectSinkPath honors PI_OBS_SINK (tilde) else the global sink", () => {
    assert.match(reflectSinkPath({ PI_OBS_SINK: "/tmp/x/events.jsonl" }), /^\/tmp\/x\/events\.jsonl$/);
    assert.match(reflectSinkPath({}), /\.pi\/agent\/obs\/events\.jsonl$/);
});
