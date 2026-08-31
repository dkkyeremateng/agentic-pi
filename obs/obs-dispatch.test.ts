import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxLaunch, isReadOnlyAgent, listAgents, macSandboxProfile, needsSandbox, parseSelection, resolveAgent, sandboxBinHint, sandboxConfig } from "./obs-dispatch";
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
    // implementer edits code; seeker has the `write` tool (browser screenshots) ->
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

test("buildSandboxLaunch: custom substitutes {home} (so ~/.pi can be bound writable)", () => {
    const r = buildSandboxLaunch(
        { mode: "custom", customCmd: "bwrap --ro-bind / / --bind {cwd} {cwd} --bind {home}/.pi {home}/.pi" },
        "/home/me/proj",
        "/opt/pi",
        ["-p"],
        { HOME: "/home/me" },
    );
    assert.deepEqual(r, {
        cmd: "bwrap",
        argv: ["--ro-bind", "/", "/", "--bind", "/home/me/proj", "/home/me/proj", "--bind", "/home/me/.pi", "/home/me/.pi", "/opt/pi", "-p"],
    });
});

test("buildSandboxLaunch: custom tokenises before substituting, so a cwd with a space survives", () => {
    // Substituting first split "/Users/me/My Projects/app" across two argv entries,
    // so the wrapper bound "/Users/me/My" and "Projects/app".
    const r = buildSandboxLaunch(
        { mode: "custom", customCmd: "bwrap --bind {cwd} {cwd} --" },
        "/Users/me/My Projects/app",
        "/usr/bin/pi",
        ["-p", "hi"],
    );
    assert.deepEqual(r, {
        cmd: "bwrap",
        argv: ["--bind", "/Users/me/My Projects/app", "/Users/me/My Projects/app", "--", "/usr/bin/pi", "-p", "hi"],
    });
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

test("macSandboxProfile keeps ~/.pi writable but not its code-loading paths", () => {
    const p = macSandboxProfile({ cwd: "/Users/me/proj", home: "/Users/me", tmp: "/tmp", env: {} });
    // ~/.pi stays writable -- pi needs it for session logs and the settings lock.
    assert.match(p, /allow file-write\*[^\n]*"\/Users\/me\/\.pi"/);
    // ...but the paths pi loads code or trust from on a LATER, unsandboxed run are
    // carved back out. The deny must come AFTER the allow: SBPL is last-match-wins.
    const allowAt = p.indexOf("(allow file-write*");
    const denyAt = p.indexOf('(deny file-write* (subpath "/Users/me/.pi/agent/extensions"');
    assert.ok(denyAt > allowAt, "the write deny must follow the write allow");
    for (const denied of [
        "/Users/me/.pi/agent/extensions",
        "/Users/me/.pi/agent/skills",
        "/Users/me/.pi/agent/prompts",
        "/Users/me/.pi/agent/npm",
        "/Users/me/.pi/skills",
    ]) {
        assert.match(p.slice(denyAt), new RegExp(`\\(subpath "${denied}"\\)`), denied);
    }
    for (const denied of [
        "/Users/me/.pi/agent/settings.json",
        "/Users/me/.pi/agent/trust.json",
        "/Users/me/.pi/agent/SYSTEM.md",
    ]) {
        assert.match(p.slice(denyAt), new RegExp(`\\(literal "${denied}"\\)`), denied);
    }
});

test("macSandboxProfile follows PI_CODING_AGENT_DIR when carving out the code paths", () => {
    const p = macSandboxProfile({
        cwd: "/p",
        home: "/h",
        tmp: "/tmp",
        env: { PI_CODING_AGENT_DIR: "~/custom-pi" },
    });
    assert.match(p, /\(deny file-write\*[^\n]*\(subpath "\/h\/custom-pi\/extensions"\)/);
    assert.match(p, /\(deny file-write\*[^\n]*\(literal "\/h\/custom-pi\/settings\.json"\)/);
});

test("sandboxBinHint: turns a bwrap exec-fail into an actionable bind hint", () => {
    const sb = { mode: "custom" as const, customCmd: "bwrap --ro-bind /usr /usr --bind {cwd} {cwd}" };
    const bin = "/home/linuxbrew/.linuxbrew/bin/pi";
    const hint = sandboxBinHint(sb, bin, `bwrap: execvp ${bin}: No such file or directory`);
    assert.match(hint, /can't see '\/home\/linuxbrew\/\.linuxbrew\/bin\/pi'/);
    assert.match(hint, /--ro-bind \/home\/linuxbrew\/\.linuxbrew\/bin \/home\/linuxbrew\/\.linuxbrew\/bin/);
    assert.match(hint, /--ro-bind \/ \//);
    // bare "No such file or directory" that names the bin also triggers (firejail-style)
    assert.notEqual(sandboxBinHint(sb, bin, `Error: ${bin}: No such file or directory`), "");
});

test("sandboxBinHint: silent for non-custom mode and unrelated failures", () => {
    const sb = { mode: "custom" as const, customCmd: "bwrap {cwd}" };
    // a normal agent nonzero exit (task error) must NOT get the sandbox hint
    assert.equal(sandboxBinHint(sb, "/x/pi", "Error: the task failed because the test suite is red"), "");
    // off / built-in modes never emit it
    assert.equal(sandboxBinHint({ mode: "off", customCmd: "" }, "/x/pi", "bwrap: execvp /x/pi: No such file or directory"), "");
    assert.equal(sandboxBinHint({ mode: "sandbox-exec", customCmd: "" }, "/x/pi", "execvp failed"), "");
});

test("macSandboxProfile honors PI_OBS_DISPATCH_{READ,WRITE}_EXTRA", () => {
    const p = macSandboxProfile({ cwd: "/p", home: "/h", tmp: "/tmp", env: { PI_OBS_DISPATCH_WRITE_EXTRA: "/data/out", PI_OBS_DISPATCH_READ_EXTRA: "/refs:/more" } });
    assert.match(p, /allow file-write\*[^\n]*"\/data\/out"/);
    assert.match(p, /allow file-read-data[^\n]*"\/refs"/);
    assert.match(p, /allow file-read-data[^\n]*"\/more"/);
});
