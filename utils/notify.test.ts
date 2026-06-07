import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    notifyEscape,
    notificationsEnabled,
    emitNotification,
} from "./notify";

describe("notifyEscape", () => {
    it("wraps text in an OSC 9 sequence", () => {
        assert.equal(notifyEscape("done"), "\x1b]9;done\x07");
    });
    it("strips control chars and trims", () => {
        assert.equal(notifyEscape("  a\tb\nc\r  "), "\x1b]9;a b c\x07");
    });
    it("caps length to 200 chars", () => {
        const out = notifyEscape("x".repeat(500));
        // 200 x's between the OSC intro and the BEL
        assert.equal(out, `\x1b]9;${"x".repeat(200)}\x07`);
    });
    it("returns empty string for blank input", () => {
        assert.equal(notifyEscape(""), "");
        assert.equal(notifyEscape("   "), "");
    });
});

describe("notificationsEnabled", () => {
    it("is on by default and off when PI_NOTIFY=0", () => {
        assert.equal(notificationsEnabled({} as NodeJS.ProcessEnv), true);
        assert.equal(
            notificationsEnabled({ PI_NOTIFY: "1" } as any),
            true,
        );
        assert.equal(notificationsEnabled({ PI_NOTIFY: "0" } as any), false);
    });
});

describe("emitNotification", () => {
    it("writes the escape when enabled + TTY", () => {
        let written = "";
        const ok = emitNotification("hi", {
            write: (s) => (written += s),
            isTTY: true,
            env: {} as NodeJS.ProcessEnv,
        });
        assert.equal(ok, true);
        assert.equal(written, "\x1b]9;hi\x07");
    });
    it("no-ops when disabled", () => {
        let written = "";
        const ok = emitNotification("hi", {
            write: (s) => (written += s),
            isTTY: true,
            env: { PI_NOTIFY: "0" } as any,
        });
        assert.equal(ok, false);
        assert.equal(written, "");
    });
    it("no-ops when not a TTY", () => {
        let written = "";
        const ok = emitNotification("hi", {
            write: (s) => (written += s),
            isTTY: false,
            env: {} as NodeJS.ProcessEnv,
        });
        assert.equal(ok, false);
        assert.equal(written, "");
    });
    it("no-ops for a blank message", () => {
        const ok = emitNotification("   ", {
            write: () => {},
            isTTY: true,
            env: {} as NodeJS.ProcessEnv,
        });
        assert.equal(ok, false);
    });
});
