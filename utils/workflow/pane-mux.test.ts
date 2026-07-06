import { test } from "node:test";
import assert from "node:assert/strict";
import {
    detectMux,
    panesEnabled,
    shquote,
    paneOpenCommand,
    paneCloseCommand,
    viewerArgv,
    publishExternalSteer,
    externalSteerActive,
    panesReason,
    publishHasUi,
    interactivePi,
    paneSplitDir,
} from "./pane-mux";

test("detectMux picks the split surface from env (tmux → zellij → wezterm → kitty → iTerm2)", () => {
    assert.equal(detectMux({ TMUX: "/tmp/tmux-1/default,123,0" })?.kind, "tmux");
    assert.equal(detectMux({ ZELLIJ: "0" })?.kind, "zellij");
    assert.equal(detectMux({ ZELLIJ_SESSION_NAME: "s" })?.kind, "zellij");
    assert.equal(detectMux({ WEZTERM_PANE: "3" })?.kind, "wezterm");
    assert.equal(detectMux({ KITTY_WINDOW_ID: "7" })?.kind, "kitty");
    assert.equal(detectMux({ TERM_PROGRAM: "iTerm.app" })?.kind, "iterm2"); // GUI terminal, no tmux needed
    assert.equal(detectMux({ ITERM_SESSION_ID: "w0t0p0:UUID" })?.kind, "iterm2");
    assert.equal(detectMux({}), null);
    // tmux wins when nested inside iTerm2 (tmux is the visible surface)
    assert.equal(detectMux({ TMUX: "x", TERM_PROGRAM: "iTerm.app" })?.kind, "tmux");
});

test("panesEnabled requires the flag, obs, an interactive TTY, a mux, AND root depth", () => {
    const base = { PI_WORKFLOW_PANES: "1", PI_OBS: "1", TMUX: "x" };
    const tty = true;
    assert.equal(panesEnabled(base, tty), true);
    assert.equal(panesEnabled({ ...base, PI_WORKFLOW_PANES: "0" }, tty), false); // flag off
    assert.equal(panesEnabled({ ...base, PI_OBS: "" }, tty), false); // obs off
    assert.equal(panesEnabled({ PI_WORKFLOW_PANES: "1", PI_OBS: "1" }, tty), false); // no mux
    assert.equal(panesEnabled({ ...base, PI_DISPATCH_DEPTH: "1" }, tty), false); // nested, not root
    assert.equal(panesEnabled({ ...base, PI_WORKFLOW_PANES: "true" }, tty), true); // truthy variants
    // no interactive terminal (Telegram / pi-obs chat drive the agent headless) → no panes,
    // even with the flag, obs, a mux, and $TMUX all present (inherited from the bridge).
    assert.equal(panesEnabled(base, false), false);
});

test("panesReason names the failing gate, null when all pass", () => {
    const base = { PI_WORKFLOW_PANES: "1", PI_OBS: "1", TMUX: "x" };
    assert.equal(panesReason(base, true), null);
    assert.match(panesReason({ ...base, PI_WORKFLOW_PANES: "0" }, true)!, /PI_WORKFLOW_PANES/);
    assert.match(panesReason({ ...base, PI_OBS: "" }, true)!, /PI_OBS/);
    assert.match(panesReason(base, false)!, /interactive/); // headless (Telegram/chat)
    assert.match(panesReason({ ...base, PI_DISPATCH_DEPTH: "2" }, true)!, /root orchestrator/);
    assert.match(panesReason({ PI_WORKFLOW_PANES: "1", PI_OBS: "1" }, true)!, /split surface/);
    // iTerm2 alone (no tmux) satisfies the surface gate
    assert.equal(panesReason({ PI_WORKFLOW_PANES: "1", PI_OBS: "1", TERM_PROGRAM: "iTerm.app" }, true), null);
});

test("interactivePi prefers pi's published hasUI over stdout.isTTY", () => {
    publishHasUi(() => true);
    assert.equal(interactivePi(), true);
    publishHasUi(() => false); // pi says headless → not interactive, even under a TTY
    assert.equal(interactivePi(), false);
    publishHasUi(() => process.stdout.isTTY === true); // reset for other tests
});

test("shquote wraps in single quotes and escapes embedded quotes", () => {
    assert.equal(shquote("simple"), "'simple'");
    assert.equal(shquote("with space"), "'with space'");
    assert.equal(shquote("it's"), `'it'\\''s'`);
});

test("paneOpenCommand builds a per-mux open command, horizontal (side-by-side) by default", () => {
    const cmd = ["/usr/bin/node", "--run", "run-1", "--agent", "scout"];
    const tmux = paneOpenCommand({ kind: "tmux" }, cmd, "scout");
    assert.equal(tmux.file, "tmux");
    assert.deepEqual(tmux.argv.slice(0, 6), ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}"]); // -h = horizontal
    assert.equal(tmux.argv[6], cmd.map(shquote).join(" ")); // whole command as ONE arg
    assert.equal(tmux.idFromStdout, true);

    const wt = paneOpenCommand({ kind: "wezterm" }, cmd, "scout");
    assert.deepEqual(wt.argv, ["cli", "split-pane", "--horizontal", "--", ...cmd]);
    assert.equal(wt.idFromStdout, true);

    const zj = paneOpenCommand({ kind: "zellij" }, cmd, "scout");
    assert.deepEqual(zj.argv, ["run", "--close-on-exit", "--direction", "right", "--name", "scout", "--", ...cmd]);
    assert.equal(zj.idFromStdout, false); // no id to capture

    const kt = paneOpenCommand({ kind: "kitty" }, cmd, "scout");
    assert.deepEqual(kt.argv, ["@", "launch", "--type=window", "--location", "vsplit", "--title", "scout", ...cmd]);

    // iTerm2: an osascript split; horizontal (right) = AppleScript "vertically"
    const it = paneOpenCommand({ kind: "iterm2" }, cmd, "scout");
    assert.equal(it.file, "osascript");
    assert.equal(it.argv[0], "-e");
    assert.match(it.argv[1], /split vertically with default profile command/);
    assert.match(it.argv[1], /'--agent' 'scout'/); // the shell command is embedded
    assert.match(it.argv[1], /return id of s/); // prints the new session id
    assert.equal(it.idFromStdout, true);
});

test("paneOpenCommand honors a 'down' (stacked) split", () => {
    const cmd = ["/n", "--run", "r"];
    assert.deepEqual(paneOpenCommand({ kind: "tmux" }, cmd, "s", "down").argv.slice(0, 2), ["split-window", "-v"]);
    assert.deepEqual(paneOpenCommand({ kind: "wezterm" }, cmd, "s", "down").argv, ["cli", "split-pane", "--", ...cmd]); // no --horizontal
    assert.equal(paneOpenCommand({ kind: "zellij" }, cmd, "s", "down").argv[3], "down");
    assert.equal(paneOpenCommand({ kind: "kitty" }, cmd, "s", "down").argv[4], "hsplit");
    assert.match(paneOpenCommand({ kind: "iterm2" }, cmd, "s", "down").argv[1], /split horizontally/); // stacked
});

test("paneSplitDir defaults to horizontal (right); env can stack it", () => {
    assert.equal(paneSplitDir({}), "right");
    assert.equal(paneSplitDir({ PI_WORKFLOW_PANE_SPLIT: "right" }), "right");
    assert.equal(paneSplitDir({ PI_WORKFLOW_PANE_SPLIT: "down" }), "down");
    assert.equal(paneSplitDir({ PI_WORKFLOW_PANE_SPLIT: "vertical" }), "down");
    assert.equal(paneSplitDir({ PI_WORKFLOW_PANE_SPLIT: "stacked" }), "down");
});

test("paneCloseCommand targets a pane by id, or null when unsupported/idless", () => {
    assert.deepEqual(paneCloseCommand({ kind: "tmux" }, "%3"), { file: "tmux", argv: ["kill-pane", "-t", "%3"] });
    assert.deepEqual(paneCloseCommand({ kind: "wezterm" }, "5"), { file: "wezterm", argv: ["cli", "kill-pane", "--pane-id", "5"] });
    assert.deepEqual(paneCloseCommand({ kind: "kitty" }, "9"), { file: "kitty", argv: ["@", "close-window", "--match", "id:9"] });
    const it = paneCloseCommand({ kind: "iterm2" }, "S-42");
    assert.equal(it!.file, "osascript");
    assert.match(it!.argv[1], /if id of s is "S-42" then close s/);
    assert.equal(paneCloseCommand({ kind: "zellij" }, "x"), null); // close-on-exit only
    assert.equal(paneCloseCommand({ kind: "tmux" }, ""), null); // no id captured
});

test("externalSteerActive reflects the published getter (Telegram/chat steer → no panes)", () => {
    assert.equal(externalSteerActive(), false); // nothing published yet
    let busy = false;
    publishExternalSteer(() => busy); // obs-live publishes () => control.busy()
    assert.equal(externalSteerActive(), false); // idle: local terminal dispatch
    busy = true;
    assert.equal(externalSteerActive(), true); // servicing an injected Telegram/chat prompt
    publishExternalSteer(() => false); // reset so we don't leak into other tests
    assert.equal(externalSteerActive(), false);
});

test("viewerArgv runs this node over obs-watch scoped to run + agent (+ optional sink)", () => {
    const argv = viewerArgv("run-9", "Scout", { execPath: "/n", script: "/w.ts" });
    assert.deepEqual(argv, ["/n", "--no-warnings", "--experimental-strip-types", "/w.ts", "--run", "run-9", "--agent", "scout"]);
    const withSink = viewerArgv("run-9", "scout", { execPath: "/n", script: "/w.ts", sink: "/s.jsonl" });
    assert.deepEqual(withSink.slice(-2), ["--sink", "/s.jsonl"]);
    const withDispatch = viewerArgv("run-9", "scout", { execPath: "/n", script: "/w.ts", dispatchId: "scout-42" });
    assert.equal(withDispatch[withDispatch.indexOf("--dispatch") + 1], "scout-42");
});
