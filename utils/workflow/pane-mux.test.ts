import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
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
    openAgentPane,
    herdrSockPath,
    herdrSplitParams,
    herdrRunAttempts,
    extractPaneIds,
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
    // herdr: the immediate surface when pi runs inside a herdr pane
    assert.equal(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" })?.kind, "herdr");
    assert.equal(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TERM_PROGRAM: "iTerm.app" })?.kind, "herdr"); // beats leaked iTerm2 env
    assert.equal(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TMUX: "x" })?.kind, "tmux"); // tmux still closer
    assert.equal(detectMux({ HERDR_ENV: "1" }), null); // no pane id → can't split → not herdr
});

test("herdr request builders (sock path, split params, run attempts, pane-id extraction)", () => {
    assert.equal(herdrSockPath({ HERDR_SOCKET_PATH: "/x/h.sock" }), "/x/h.sock");
    assert.match(herdrSockPath({}), /\.config\/herdr\/herdr\.sock$/);

    assert.deepEqual(herdrSplitParams("w1:p1", "right"), { pane_id: "w1:p1", direction: "right", ratio: 0.4 });
    assert.equal(herdrSplitParams("w1:p1", "down").direction, "down");

    const attempts = herdrRunAttempts("w1:p2", ["/n", "--agent", "scout"]);
    assert.equal(attempts[0].method, "pane.run");
    assert.equal(attempts[0].params.pane_id, "w1:p2");
    assert.match(String(attempts[0].params.command), /'--agent' 'scout'/);
    assert.deepEqual(attempts[1].params.argv, ["/n", "--agent", "scout"]); // argv fallback
    assert.equal(attempts[2].method, "pane.send_input"); // send-input fallback
    assert.match(String(attempts[2].params.text), /\n$/); // ends with enter

    assert.deepEqual(extractPaneIds({ panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }] }), ["w1:p1", "w1:p2"]);
    assert.deepEqual(extractPaneIds({ workspace: { tabs: [{ panes: [{ pane_id: "w2:p9" }] }] } }), ["w2:p9"]);
    assert.deepEqual(extractPaneIds(null), []);
});

test("herdr backend end-to-end against a mock socket: split → run viewer in new pane → close", async () => {
    const sockPath = `/tmp/pi-herdr-${process.pid}.sock`;
    try {
        unlinkSync(sockPath);
    } catch {}
    const seen: { method: string; params: any }[] = [];
    let panes = ["w1:p1"]; // grows to include the new pane after pane.split
    const server = createServer((sock) => {
        sock.setEncoding("utf8");
        let buf = "";
        sock.on("data", (d: string) => {
            buf += d;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                const msg = JSON.parse(line);
                seen.push({ method: msg.method, params: msg.params });
                let result: any = { ok: true };
                if (msg.method === "pane.list") result = { panes: panes.map((pane_id) => ({ pane_id })) };
                if (msg.method === "pane.split") panes = ["w1:p1", "w1:p2"];
                sock.write(JSON.stringify({ id: msg.id, result }) + "\n");
            }
        });
    });
    await new Promise<void>((res) => server.listen(sockPath, res));
    publishHasUi(() => true); // interactive so the gates pass
    try {
        const env = {
            PI_WORKFLOW_PANES: "1",
            PI_OBS: "1",
            PI_OBS_RUN: "run-1",
            HERDR_ENV: "1",
            HERDR_PANE_ID: "w1:p1",
            HERDR_SOCKET_PATH: sockPath,
        };
        let resolveActive: (v: boolean) => void;
        const active = new Promise<boolean>((r) => (resolveActive = r));
        const handle = openAgentPane("scout", "scout-1", env, (ok) => resolveActive(ok));
        assert.ok(handle, "herdr returns a handle");
        assert.equal(await active, true, "paneActive flipped true on socket success");

        assert.ok(seen.some((e) => e.method === "pane.split"), "sent pane.split");
        const run = seen.find((e) => e.method === "pane.run");
        assert.ok(run, "ran the viewer");
        assert.equal(run!.params.pane_id, "w1:p2", "ran in the NEW pane, not the orchestrator's");
        assert.match(String(run!.params.command), /obs-watch/, "ran the obs-watch viewer");

        handle!.close();
        await new Promise((r) => setTimeout(r, 80));
        const close = seen.find((e) => e.method === "pane.close");
        assert.ok(close && close.params.pane_id === "w1:p2", "closed the new pane by id");
    } finally {
        publishHasUi(() => process.stdout.isTTY === true);
        server.close();
        try {
            unlinkSync(sockPath);
        } catch {}
    }
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
