import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyAgent, listAgents, resolveAgent } from "./obs-dispatch";
import type { AgentDef } from "../utils/workflow/workflow-core";

const def = (over: Partial<AgentDef>): AgentDef => ({
    name: "x",
    description: "",
    tools: "",
    model: "",
    contextWindow: 0,
    systemPrompt: "",
    ...over,
});

test("isReadOnlyAgent: no write/edit tool ⇒ read-only", () => {
    assert.equal(isReadOnlyAgent(def({ tools: "read,grep,find,bash,web" })), true);
    assert.equal(isReadOnlyAgent(def({ tools: "read" })), true);
    assert.equal(isReadOnlyAgent(def({ tools: "" })), true);
});

test("isReadOnlyAgent: a write or edit tool ⇒ not read-only", () => {
    assert.equal(isReadOnlyAgent(def({ tools: "read,write,bash" })), false);
    assert.equal(isReadOnlyAgent(def({ tools: "read,edit" })), false);
});

// Against the real bundled agents/ definitions.
test("the bundled agents classify by their actual tools", () => {
    const byName = new Map(listAgents(process.cwd()).map((a) => [a.name, a]));
    // scout/reviewer/validator have no write/edit tool -> read-only -> dispatchable.
    assert.equal(byName.get("scout")?.readOnly, true);
    assert.equal(byName.get("reviewer")?.readOnly, true);
    // implementer edits code; seeker has the `write` tool (bowser screenshots) ->
    // both are write-capable, so NOT dispatchable under the strict heuristic.
    if (byName.has("implementer")) assert.equal(byName.get("implementer")?.readOnly, false);
    assert.equal(byName.get("seeker")?.readOnly, false);
});

test("resolveAgent finds by name (case-insensitive) and returns null for unknown", () => {
    assert.equal(resolveAgent(process.cwd(), "seeker")?.name, "seeker");
    assert.equal(resolveAgent(process.cwd(), "SEEKER")?.name, "seeker");
    assert.equal(resolveAgent(process.cwd(), "definitely-not-an-agent"), null);
    assert.equal(resolveAgent(process.cwd(), ""), null);
});
