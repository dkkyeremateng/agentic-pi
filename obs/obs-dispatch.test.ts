import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxLaunch, isReadOnlyAgent, listAgents, macSandboxProfile, resolveAgent, sandboxConfig } from "./obs-dispatch";
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

// ── sandbox ──────────────────────────────────────────────────────────────────

test("sandboxConfig: off by default, custom wins, named modes parse", () => {
    assert.deepEqual(sandboxConfig({}), { mode: "off", customCmd: "" });
    assert.equal(sandboxConfig({ PI_OBS_DISPATCH_SANDBOX: "auto" }).mode, "auto");
    assert.equal(sandboxConfig({ PI_OBS_DISPATCH_SANDBOX: "sandbox-exec" }).mode, "sandbox-exec");
    assert.equal(sandboxConfig({ PI_OBS_DISPATCH_SANDBOX: "nonsense" }).mode, "off");
    const c = sandboxConfig({ PI_OBS_DISPATCH_SANDBOX: "off", PI_OBS_DISPATCH_SANDBOX_CMD: "bwrap {cwd}" });
    assert.equal(c.mode, "custom");
});

test("buildSandboxLaunch: off runs the bin directly", () => {
    const r = buildSandboxLaunch({ mode: "off", customCmd: "" }, "/proj", "pi", ["-p", "hi"]);
    assert.deepEqual(r, { cmd: "pi", argv: ["-p", "hi"] });
});

test("buildSandboxLaunch: custom substitutes {cwd} and wraps the bin", () => {
    const r = buildSandboxLaunch({ mode: "custom", customCmd: "bwrap --bind {cwd} {cwd}" }, "/proj", "pi", ["x"]);
    assert.deepEqual(r, { cmd: "bwrap", argv: ["--bind", "/proj", "/proj", "pi", "x"] });
});

test("buildSandboxLaunch: fail-closed when the platform has no built-in", () => {
    assert.ok("error" in buildSandboxLaunch({ mode: "auto", customCmd: "" }, "/proj", "pi", [], {}, "linux"));
    assert.ok("error" in buildSandboxLaunch({ mode: "sandbox-exec", customCmd: "" }, "/proj", "pi", [], {}, "linux"));
});

test("buildSandboxLaunch: sandbox-exec on darwin wraps with a generated profile", () => {
    const r = buildSandboxLaunch({ mode: "sandbox-exec", customCmd: "" }, "/proj", "pi", ["go"], { HOME: "/Users/me" }, "darwin");
    if ("error" in r) {
        // Only valid reason on a darwin CI without the binary.
        assert.match(r.error, /sandbox-exec/);
        return;
    }
    assert.equal(r.cmd, "/usr/bin/sandbox-exec");
    assert.equal(r.argv[0], "-p");
    assert.equal(r.argv[2], "pi");
    assert.deepEqual(r.argv.slice(3), ["go"]);
    assert.match(r.argv[1], /\(version 1\)/);
});

test("macSandboxProfile confines writes to cwd (+ caches) and leaves reads open", () => {
    const p = macSandboxProfile({ cwd: "/Users/me/proj", home: "/Users/me", tmp: "/tmp" });
    assert.match(p, /\(deny file-write\*\)/);
    assert.match(p, /allow file-write\*[^\n]*"\/Users\/me\/proj"/);
    assert.match(p, /"\/Users\/me\/Library\/Caches"/); // Playwright/tool caches writable
    assert.ok(!/file-read/.test(p)); // reads are open — no read restriction
});
