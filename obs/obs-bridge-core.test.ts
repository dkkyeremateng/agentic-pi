import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BOT_COMMANDS,
    bridgeConfig,
    chatSessionId,
    chunk,
    evalBridgeLock,
    helpText,
    dispatchSessionId,
    formatAgents,
    formatAttachable,
    formatLive,
    formatRuns,
    initStreamState,
    isAllowed,
    orchestrators,
    parseBareDispatch,
    parseCommand,
    reduceChatEvent,
    renderStream,
    resolveAttachTarget,
    shortId,
    telegramCommands,
    TG_LIMIT,
} from "./obs-bridge-core";

// ── config ───────────────────────────────────────────────────────────────────

test("bridgeConfig is disabled without a bot token", () => {
    const cfg = bridgeConfig({});
    assert.equal(cfg.enabled, false);
    assert.deepEqual(cfg.allow, []);
});

test("bridgeConfig parses token, allowlist, and builds the loopback API base", () => {
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "abc:123", PI_OBS_TG_ALLOW: "111, 222 333" });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.token, "abc:123");
    assert.deepEqual(cfg.allow, [111, 222, 333]);
    assert.equal(cfg.apiBase, "http://127.0.0.1:7616");
});

test("bridgeConfig dials loopback when the server binds 0.0.0.0, honours port", () => {
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_HOST: "0.0.0.0", PI_OBS_PORT: "8000" });
    assert.equal(cfg.apiBase, "http://127.0.0.1:8000");
});

test("bridgeConfig PI_OBS_BRIDGE_API overrides host/port and trims trailing slash", () => {
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_BRIDGE_API: "http://obs.example:9000/" });
    assert.equal(cfg.apiBase, "http://obs.example:9000");
});

test("bridgeConfig ignores non-integer allowlist entries", () => {
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_TG_ALLOW: "111, notanid, 4.5, 222" });
    assert.deepEqual(cfg.allow, [111, 222]);
});

// ── allowlist (fail closed) ──────────────────────────────────────────────────

test("bridgeConfig reads cwd and the opt-in bare-dispatch flag", () => {
    assert.equal(bridgeConfig({ PI_OBS_TG_TOKEN: "t" }).dispatchBare, false);
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_TG_CWD: "/proj", PI_OBS_TG_BARE_DISPATCH: "1" });
    assert.equal(cfg.cwd, "/proj");
    assert.equal(cfg.dispatchBare, true);
});

test("bridgeConfig typing interval defaults under Telegram's ~5s expiry and floors bad overrides", () => {
    assert.equal(bridgeConfig({ PI_OBS_TG_TOKEN: "t" }).typingIntervalMs, 4000); // default
    assert.equal(bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_TG_TYPING_MS: "2500" }).typingIntervalMs, 2500);
    assert.equal(bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_TG_TYPING_MS: "50" }).typingIntervalMs, 1000); // floored
    assert.equal(bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_TG_TYPING_MS: "junk" }).typingIntervalMs, 4000); // NaN → default
});

test("isAllowed fails closed on an empty allowlist", () => {
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "t" });
    assert.equal(isAllowed(cfg, 111), false);
});
test("isAllowed permits only listed chat ids", () => {
    const cfg = bridgeConfig({ PI_OBS_TG_TOKEN: "t", PI_OBS_TG_ALLOW: "111,222" });
    assert.equal(isAllowed(cfg, 111), true);
    assert.equal(isAllowed(cfg, 333), false);
});

// ── session mapping ──────────────────────────────────────────────────────────

test("chatSessionId is stable and rotates with the salt", () => {
    assert.equal(chatSessionId(123), "tg-123");
    assert.equal(chatSessionId(123, 0), "tg-123");
    assert.equal(chatSessionId(123, 2), "tg-123-2");
    // must satisfy the server's ^[\w.-]{1,64}$ rule
    assert.match(chatSessionId(-100123, 5), /^[\w.-]{1,64}$/);
});

// ── command parsing ──────────────────────────────────────────────────────────

test("plain text routes to chat", () => {
    assert.deepEqual(parseCommand("how much did today cost?"), { kind: "chat", text: "how much did today cost?" });
});

test("/help and /start map to help", () => {
    assert.deepEqual(parseCommand("/help"), { kind: "help" });
    assert.deepEqual(parseCommand("/start"), { kind: "help" });
});

test("group-style @botname suffix is stripped", () => {
    assert.deepEqual(parseCommand("/help@MyObsBot"), { kind: "help" });
});

test("/runs parses and clamps the limit", () => {
    assert.deepEqual(parseCommand("/runs"), { kind: "runs", limit: 5 });
    assert.deepEqual(parseCommand("/runs 3"), { kind: "runs", limit: 3 });
    assert.deepEqual(parseCommand("/runs 999"), { kind: "runs", limit: 20 });
    assert.deepEqual(parseCommand("/runs abc"), { kind: "runs", limit: 5 });
});

test("/digest and /search require an arg, else usage", () => {
    assert.deepEqual(parseCommand("/digest run-abc"), { kind: "digest", id: "run-abc" });
    assert.deepEqual(parseCommand("/digest"), { kind: "usage", cmd: "digest" });
    assert.deepEqual(parseCommand("/search obs-server"), { kind: "search", q: "obs-server" });
    assert.deepEqual(parseCommand("/search"), { kind: "usage", cmd: "search" });
});

test("verdict commands carry status, id, and an optional note", () => {
    assert.deepEqual(parseCommand("/pass run-abc"), { kind: "verdict", status: "pass", id: "run-abc", note: "" });
    assert.deepEqual(parseCommand("/fail run-abc flaky test"), { kind: "verdict", status: "fail", id: "run-abc", note: "flaky test" });
    assert.deepEqual(parseCommand("/open run-abc needs eyes"), { kind: "verdict", status: "open", id: "run-abc", note: "needs eyes" });
    assert.deepEqual(parseCommand("/pass"), { kind: "usage", cmd: "pass" });
});

test("/dispatch parses agent + prompt (comma or space); /agents has no args", () => {
    assert.deepEqual(parseCommand("/dispatch seeker, ping https://x.com"), { kind: "dispatch", agent: "seeker", text: "ping https://x.com" });
    assert.deepEqual(parseCommand("/dispatch seeker ping https://x.com"), { kind: "dispatch", agent: "seeker", text: "ping https://x.com" });
    assert.deepEqual(parseCommand("/dispatch seeker:do it"), { kind: "dispatch", agent: "seeker", text: "do it" });
    assert.deepEqual(parseCommand("/dispatch seeker"), { kind: "usage", cmd: "dispatch" });
    assert.deepEqual(parseCommand("/dispatch"), { kind: "usage", cmd: "dispatch" });
    assert.deepEqual(parseCommand("/agents"), { kind: "agents" });
});

test("/do parses a free-text task, else usage", () => {
    assert.deepEqual(parseCommand("/do ping https://x.com and check it's up"), { kind: "do", text: "ping https://x.com and check it's up" });
    assert.deepEqual(parseCommand("/do"), { kind: "usage", cmd: "do" });
});

test("parseBareDispatch needs a comma/colon AND a known agent", () => {
    const names = ["seeker", "scout"];
    assert.deepEqual(parseBareDispatch("seeker, ping https://x.com", names), { agent: "seeker", text: "ping https://x.com" });
    assert.deepEqual(parseBareDispatch("Seeker: look it up", names), { agent: "Seeker", text: "look it up" });
    assert.equal(parseBareDispatch("scout the area for me", names), null); // no separator -> normal chat
    assert.equal(parseBareDispatch("nobody, do this", names), null); // unknown agent -> normal chat
    assert.equal(parseBareDispatch("hello there", names), null);
});

test("dispatchSessionId is stable, agent-scoped, salt-rotated, and id-safe", () => {
    assert.equal(dispatchSessionId(123, "seeker"), "tg-d-123-seeker");
    assert.equal(dispatchSessionId(123, "Seeker", 2), "tg-d-123-seeker-2");
    assert.match(dispatchSessionId(-100, "weird name!", 1), /^[\w.-]{1,64}$/);
});

test("formatAgents lists every agent and tags writers", () => {
    const out = formatAgents([
        { name: "scout", description: "recon", readOnly: true },
        { name: "implementer", description: "writes code", readOnly: false },
    ]);
    assert.match(out, /scout/);
    assert.match(out, /implementer \(writes\)/);
    assert.ok(!/scout \(writes\)/.test(out)); // read-only agents aren't tagged
});

test("/attach takes a run id (else usage); /detach has no args", () => {
    assert.deepEqual(parseCommand("/attach run-abc"), { kind: "attach", runArg: "run-abc" });
    assert.deepEqual(parseCommand("/attach abc extra ignored"), { kind: "attach", runArg: "abc" });
    assert.deepEqual(parseCommand("/attach"), { kind: "usage", cmd: "attach" });
    assert.deepEqual(parseCommand("/detach"), { kind: "detach" });
});

test("/reset and /new map to reset; unknown slash → usage", () => {
    assert.deepEqual(parseCommand("/reset"), { kind: "reset" });
    assert.deepEqual(parseCommand("/new"), { kind: "reset" });
    assert.deepEqual(parseCommand("/wat"), { kind: "usage", cmd: "wat" });
});

// ── command menu (setMyCommands / autocomplete) ──────────────────────────────

test("telegramCommands satisfy Telegram's setMyCommands constraints", () => {
    const cmds = telegramCommands();
    assert.ok(cmds.length > 0);
    for (const c of cmds) {
        assert.match(c.command, /^[a-z0-9_]{1,32}$/, `bad command name: ${c.command}`);
        assert.ok(c.description.length >= 1 && c.description.length <= 256, `bad description for /${c.command}`);
    }
    const names = cmds.map((c) => c.command);
    assert.equal(new Set(names).size, names.length, "duplicate command names");
});

test("telegramCommands use the plain description (no arg hint — Telegram adds its own separator)", () => {
    const runs = telegramCommands().find((c) => c.command === "runs");
    assert.equal(runs?.description, "recent runs (default 5)"); // no "[n] —" prefix
    const help = telegramCommands().find((c) => c.command === "help");
    assert.equal(help?.description, "show the command list");
    // arg syntax still lives in /help, where there's room for it
    assert.ok(helpText().includes("/runs [n]"));
});

test("helpText lists every registered bot command with its arg hint", () => {
    const h = helpText();
    for (const c of BOT_COMMANDS) {
        assert.ok(h.includes(`/${c.command}`), `help missing /${c.command}`);
        if (c.args) assert.ok(h.includes(`/${c.command} ${c.args}`), `help missing args for /${c.command}`);
    }
});

test("every menu command is recognised by parseCommand (none fall through to unknown)", () => {
    for (const c of BOT_COMMANDS) {
        const parsed = parseCommand(`/${c.command}`);
        // Arg-required commands resolve to a usage prompt for THAT command; the
        // rest resolve to their own kind. Either way it's never plain chat, and
        // a usage result must name this same command (proving the switch matched
        // its case, not the generic unknown fallthrough for a different name).
        assert.notEqual(parsed.kind, "chat", `/${c.command} routed to chat`);
        if (parsed.kind === "usage") assert.equal(parsed.cmd, c.command);
    }
});

// ── single-instance lock ─────────────────────────────────────────────────────

test("evalBridgeLock claims a free lock (no pidfile)", () => {
    assert.deepEqual(evalBridgeLock(null, 100, () => true), { claim: true });
});

test("evalBridgeLock blocks when a live foreign bridge holds the lock", () => {
    const r = evalBridgeLock("222", 100, (pid) => pid === 222); // 222 alive
    assert.equal(r.claim, false);
    assert.equal(r.heldByPid, 222);
});

test("evalBridgeLock reclaims a stale pidfile (dead holder)", () => {
    assert.deepEqual(evalBridgeLock("222", 100, () => false), { claim: true });
});

test("evalBridgeLock reclaims our own pid and ignores garbage/empty files", () => {
    assert.deepEqual(evalBridgeLock("100", 100, () => true), { claim: true }); // ours
    assert.deepEqual(evalBridgeLock("  100\n", 100, () => true), { claim: true }); // trimmed
    assert.deepEqual(evalBridgeLock("not-a-pid", 100, () => true), { claim: true });
    assert.deepEqual(evalBridgeLock("", 100, () => true), { claim: true });
    assert.deepEqual(evalBridgeLock("0", 100, () => true), { claim: true }); // non-positive
});

// ── streaming reduce / render ────────────────────────────────────────────────

test("tokens accumulate; tool start/end drive the status line", () => {
    const s = initStreamState();
    reduceChatEvent(s, { type: "token", text: "Hel" });
    reduceChatEvent(s, { type: "token", text: "lo" });
    assert.equal(s.text, "Hello");
    reduceChatEvent(s, { type: "tool", phase: "start", name: "search" });
    assert.equal(s.activeTool, "search");
    assert.match(renderStream(s), /running search/);
    reduceChatEvent(s, { type: "tool", phase: "end", name: "search" });
    assert.equal(s.activeTool, undefined);
});

test("thinking frames are not surfaced", () => {
    const s = initStreamState();
    reduceChatEvent(s, { type: "thinking", text: "secret reasoning" });
    assert.equal(s.text, "");
    assert.ok(!renderStream(s).includes("secret"));
});

test("done sets final text + appends a cost footer", () => {
    const s = initStreamState();
    reduceChatEvent(s, { type: "token", text: "partial" });
    reduceChatEvent(s, { type: "done", text: "the full answer", costUsd: 0.0123, tokens: 4200, model: "anthropic/claude-x" });
    assert.equal(s.done, true);
    const out = renderStream(s);
    assert.match(out, /the full answer/);
    assert.match(out, /\$0\.0123/);
    assert.match(out, /4\.2k tok/);
    assert.match(out, /anthropic\/claude-x/);
});

test("footer shows cached context separately from billable tokens", () => {
    const s = initStreamState();
    reduceChatEvent(s, {
        type: "done",
        text: "pong!",
        costUsd: 0.0003,
        tokens: 12,
        cachedTokens: 69500,
        model: "gemini-3-5-flash",
    });
    const out = renderStream(s);
    // headline count is the billable input+output, not the cached reuse
    assert.match(out, /12 tok/);
    assert.match(out, /\(\+69\.5k cached\)/);
    // the cached figure must not masquerade as the headline token count
    assert.ok(!out.includes("69.5k tok"));
});

test("footer omits the cached parenthetical when there is no cache reuse", () => {
    const s = initStreamState();
    reduceChatEvent(s, { type: "done", text: "hi", costUsd: 0.001, tokens: 30, model: "m" });
    assert.ok(!renderStream(s).includes("cached"));
});

test("error before any text renders an error line", () => {
    const s = initStreamState();
    reduceChatEvent(s, { type: "error", error: "set PI_OBS_LLM=1" });
    assert.equal(renderStream(s), "error: set PI_OBS_LLM=1");
});

test("approval frame ends the turn with an actionable note", () => {
    const s = initStreamState();
    reduceChatEvent(s, { type: "approval", toolCallId: "t1", name: "Bash" });
    assert.equal(s.done, true);
    assert.match(renderStream(s), /approval/i);
});

// ── formatting ───────────────────────────────────────────────────────────────

test("formatRuns renders one entry per run with id, project, cost and verdict", () => {
    const now = 1_000_000;
    const out = formatRuns(
        [{ runId: "run-abc123", cwd: "/home/me/projects/plp", costUsd: 1.85, tokens: 41280, toolCalls: 36, errors: 0, lastTs: now - 5000, verdict: { status: "pass" } }],
        now,
    );
    assert.match(out, /abc123/);
    assert.match(out, /plp/);
    assert.match(out, /\$1\.85/);
    assert.match(out, /pass/);
    assert.match(out, /5s ago/);
});

test("formatRuns and formatLive handle the empty case", () => {
    assert.match(formatRuns([], Date.now()), /no runs/);
    assert.match(formatLive([], Date.now()), /no agents/);
});

test("formatLive lists agent, project, and session id", () => {
    const now = 2_000_000;
    const out = formatLive([{ sessionId: "sess-9", agent: "implementer", cwd: "/x/proj", model: "m", startedTs: now - 120000 }], now);
    assert.match(out, /implementer/);
    assert.match(out, /proj/);
    assert.match(out, /sess-9/);
    assert.match(out, /2m ago/);
});

test("shortId drops the run- prefix", () => {
    assert.equal(shortId("run-mqa9m2kb-z027y"), "mqa9m2kb-z027y");
    assert.equal(shortId("no-prefix"), "no-prefix");
});

// ── attach target resolution ─────────────────────────────────────────────────

const orch = (sessionId: string, runId: string): any => ({ sessionId, agent: "orchestrator", runId, cwd: "/x/proj", model: "m", startedTs: 1 });
const sub = (sessionId: string, runId: string): any => ({ sessionId, agent: "implementer", runId, cwd: "/x/proj", startedTs: 1 });

test("orchestrators() keeps only root orchestrator sessions", () => {
    assert.deepEqual(orchestrators([orch("s1", "run-a"), sub("s2", "run-a"), orch("s3", "run-b")]).map((s) => s.sessionId), ["s1", "s3"]);
});

test("resolveAttachTarget matches a live run by id (with or without run- prefix)", () => {
    const live = [orch("sess-1", "run-alpha"), sub("sess-2", "run-alpha")];
    for (const arg of ["run-alpha", "alpha", "alph"]) {
        const r = resolveAttachTarget(live, arg);
        assert.equal(r.kind, "ok");
        if (r.kind === "ok") assert.equal(r.target.sessionId, "sess-1");
    }
});

test("resolveAttachTarget: none when no live orchestrator matches", () => {
    assert.deepEqual(resolveAttachTarget([orch("s1", "run-a")], "run-zzz"), { kind: "none" });
    assert.deepEqual(resolveAttachTarget([sub("s2", "run-a")], "run-a"), { kind: "none" }); // sub-agent isn't attachable
    assert.deepEqual(resolveAttachTarget([], "run-a"), { kind: "none" });
});

test("resolveAttachTarget: ambiguous when a prefix matches several runs", () => {
    const r = resolveAttachTarget([orch("s1", "run-ab12"), orch("s2", "run-ab34")], "ab");
    assert.equal(r.kind, "ambiguous");
    if (r.kind === "ambiguous") assert.equal(r.options.length, 2);
});

test("formatAttachable lists runs by short id, empty case handled", () => {
    assert.match(formatAttachable([], Date.now()), /no live runs/);
    const out = formatAttachable([orch("s1", "run-alpha")], Date.now());
    assert.match(out, /alpha/);
    assert.match(out, /proj/);
});

// ── chunking ─────────────────────────────────────────────────────────────────

test("chunk keeps short text in one piece", () => {
    assert.deepEqual(chunk("hello"), ["hello"]);
});

test("chunk splits on line boundaries under the limit", () => {
    const parts = chunk("a\nb\nc", 3);
    for (const p of parts) assert.ok(p.length <= 3);
    assert.equal(parts.join("\n"), "a\nb\nc");
});

test("chunk hard-splits a single over-long line", () => {
    const parts = chunk("x".repeat(10), 4);
    assert.deepEqual(parts, ["xxxx", "xxxx", "xx"]);
});

test("chunk respects the real Telegram limit", () => {
    const parts = chunk("y".repeat(TG_LIMIT * 2 + 5));
    for (const p of parts) assert.ok(p.length <= TG_LIMIT);
    assert.equal(parts.join("").length, TG_LIMIT * 2 + 5);
});
