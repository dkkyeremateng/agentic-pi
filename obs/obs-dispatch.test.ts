import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxLaunch, isReadOnlyAgent, listAgents, macSandboxProfile, needsSandbox, parseSelection, resolveAgent, sandboxConfig } from "./obs-dispatch";
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

test("needsSandbox: write/edit OR bash requires a sandbox (bash isn't confined by cwd-guard)", () => {
    // bash-only "read-only" agents still need it — bash can write anywhere unconfined
    assert.equal(needsSandbox(def({ tools: "read,grep,find,bash,web" })), true);
    assert.equal(needsSandbox(def({ tools: "read,write" })), true);
    assert.equal(needsSandbox(def({ tools: "read,edit" })), true);
    // only a pure read-only agent with NO bash may run unconfined
    assert.equal(needsSandbox(def({ tools: "read,grep,find,web" })), false);
    assert.equal(needsSandbox(def({ tools: "read" })), false);
    assert.equal(needsSandbox(def({ tools: "" })), false);
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

// ── auto-select (/do) ────────────────────────────────────────────────────────

test("parseSelection reads a JSON choice (agent or chat), case-insensitive", () => {
    const names = ["seeker", "scout"];
    assert.deepEqual(parseSelection('{"choice":"seeker","reason":"web check"}', names), { choice: "seeker", reason: "web check" });
    assert.deepEqual(parseSelection('{"choice":"SCOUT","reason":"recon"}', names), { choice: "scout", reason: "recon" });
    assert.deepEqual(parseSelection('{"choice":"chat","reason":"just a question"}', names), { choice: "chat", reason: "just a question" });
});

test("parseSelection tolerates prose/fences and falls back to a named agent", () => {
    assert.equal(parseSelection("I think seeker is best here.", ["seeker", "scout"]).choice, "seeker");
    assert.equal(parseSelection("```json\n{\"choice\":\"scout\"}\n```", ["seeker", "scout"]).choice, "scout");
});

test("parseSelection defaults to chat when nothing matches", () => {
    assert.equal(parseSelection("no idea", ["seeker"]).choice, "chat");
    assert.equal(parseSelection("", ["seeker"]).choice, "chat");
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

test("macSandboxProfile confines reads+writes to cwd + tool infra, hides the rest of $HOME", () => {
    const p = macSandboxProfile({ cwd: "/Users/me/proj", home: "/Users/me", tmp: "/tmp", env: {} });
    // writes: cwd + caches, denied elsewhere
    assert.match(p, /\(deny file-write\*\)/);
    assert.match(p, /allow file-write\*[^\n]*"\/Users\/me\/proj"/);
    assert.match(p, /"\/Users\/me\/Library\/Caches"/);
    // reads: $HOME data denied, cwd + tool infra re-allowed (explicit file-read-data)
    assert.match(p, /\(deny file-read-data \(subpath "\/Users\/me"\)\)/);
    assert.match(p, /allow file-read-data[^\n]*"\/Users\/me\/proj"/);
    assert.match(p, /allow file-read-data[^\n]*"\/Users\/me\/\.config\/git"/); // only git config readable
    // credentials are NOT exposed by default: no blanket ~/.config, no ~/.npmrc
    assert.ok(!/"\/Users\/me\/\.config"/.test(p), "blanket ~/.config must not be readable");
    assert.ok(!p.includes(".npmrc"), "~/.npmrc (npm _authToken) must not be readable by default");
});

test("macSandboxProfile honors PI_OBS_DISPATCH_{READ,WRITE}_EXTRA", () => {
    const p = macSandboxProfile({ cwd: "/p", home: "/h", tmp: "/tmp", env: { PI_OBS_DISPATCH_WRITE_EXTRA: "/data/out", PI_OBS_DISPATCH_READ_EXTRA: "/refs:/more" } });
    assert.match(p, /allow file-write\*[^\n]*"\/data\/out"/);
    assert.match(p, /allow file-read-data[^\n]*"\/refs"/);
    assert.match(p, /allow file-read-data[^\n]*"\/more"/);
});
