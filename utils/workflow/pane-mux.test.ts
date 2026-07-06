import { test } from "node:test";
import assert from "node:assert/strict";
import {
    detectMux,
    panesEnabled,
    shquote,
    paneOpenCommand,
    paneCloseCommand,
    viewerArgv,
} from "./pane-mux";

test("detectMux picks the multiplexer from env (tmux → zellij → wezterm → kitty)", () => {
    assert.equal(detectMux({ TMUX: "/tmp/tmux-1/default,123,0" })?.kind, "tmux");
    assert.equal(detectMux({ ZELLIJ: "0" })?.kind, "zellij");
    assert.equal(detectMux({ ZELLIJ_SESSION_NAME: "s" })?.kind, "zellij");
    assert.equal(detectMux({ WEZTERM_PANE: "3" })?.kind, "wezterm");
    assert.equal(detectMux({ KITTY_WINDOW_ID: "7" })?.kind, "kitty");
    assert.equal(detectMux({}), null);
    // tmux wins when nested
    assert.equal(detectMux({ TMUX: "x", ZELLIJ: "0" })?.kind, "tmux");
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

test("shquote wraps in single quotes and escapes embedded quotes", () => {
    assert.equal(shquote("simple"), "'simple'");
    assert.equal(shquote("with space"), "'with space'");
    assert.equal(shquote("it's"), `'it'\\''s'`);
});

test("paneOpenCommand builds a per-mux open command; tmux gets one shell-quoted string, others get argv", () => {
    const cmd = ["/usr/bin/node", "--run", "run-1", "--agent", "scout"];
    const tmux = paneOpenCommand({ kind: "tmux" }, cmd, "scout");
    assert.equal(tmux.file, "tmux");
    assert.deepEqual(tmux.argv.slice(0, 5), ["split-window", "-d", "-P", "-F", "#{pane_id}"]);
    assert.equal(tmux.argv[5], cmd.map(shquote).join(" ")); // whole command as ONE arg
    assert.equal(tmux.idFromStdout, true);

    const wt = paneOpenCommand({ kind: "wezterm" }, cmd, "scout");
    assert.deepEqual(wt.argv, ["cli", "split-pane", "--", ...cmd]); // argv passed through
    assert.equal(wt.idFromStdout, true);

    const zj = paneOpenCommand({ kind: "zellij" }, cmd, "scout");
    assert.deepEqual(zj.argv, ["run", "--close-on-exit", "--name", "scout", "--", ...cmd]);
    assert.equal(zj.idFromStdout, false); // no id to capture

    const kt = paneOpenCommand({ kind: "kitty" }, cmd, "scout");
    assert.deepEqual(kt.argv, ["@", "launch", "--type=window", "--title", "scout", ...cmd]);
});

test("paneCloseCommand targets a pane by id, or null when unsupported/idless", () => {
    assert.deepEqual(paneCloseCommand({ kind: "tmux" }, "%3"), { file: "tmux", argv: ["kill-pane", "-t", "%3"] });
    assert.deepEqual(paneCloseCommand({ kind: "wezterm" }, "5"), { file: "wezterm", argv: ["cli", "kill-pane", "--pane-id", "5"] });
    assert.deepEqual(paneCloseCommand({ kind: "kitty" }, "9"), { file: "kitty", argv: ["@", "close-window", "--match", "id:9"] });
    assert.equal(paneCloseCommand({ kind: "zellij" }, "x"), null); // close-on-exit only
    assert.equal(paneCloseCommand({ kind: "tmux" }, ""), null); // no id captured
});

test("viewerArgv runs this node over obs-watch scoped to run + agent (+ optional sink)", () => {
    const argv = viewerArgv("run-9", "Scout", { execPath: "/n", script: "/w.ts" });
    assert.deepEqual(argv, ["/n", "--no-warnings", "--experimental-strip-types", "/w.ts", "--run", "run-9", "--agent", "scout"]);
    const withSink = viewerArgv("run-9", "scout", { execPath: "/n", script: "/w.ts", sink: "/s.jsonl" });
    assert.deepEqual(withSink.slice(-2), ["--sink", "/s.jsonl"]);
});
