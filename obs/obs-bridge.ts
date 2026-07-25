// obs-bridge.ts — entry point for the messaging bridge: talk to your agent
// observability from a chat app. Telegram first (long-polling, no inbound
// webhook). Reads config from the environment / repo .env (same as obs-server),
// then runs the poll loop.
//
//   npm run obs:bridge            # or: tsx obs/obs-bridge.ts
//
// Requires PI_OBS_TG_TOKEN (a @BotFather bot token) and PI_OBS_TG_ALLOW (the
// chat ids allowed to use it). Talks to the obs-server at PI_OBS_BRIDGE_API (or
// http://<PI_OBS_HOST>:<PI_OBS_PORT>); the chat assistant needs PI_OBS_LLM=1 on
// that server. See example.env for the full list.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBridgeLock, bridgeConfig, type LockIO } from "./obs-bridge-core";
import { runBridge } from "./obs-bridge-telegram";
import { loadRepoEnv } from "./obs-llm";

const HERE = dirname(fileURLToPath(import.meta.url));
// The bridge is a separate process from pi, so load the repo .env like the
// server does — that's where PI_OBS_TG_*, PI_OBS_TOKEN, etc. typically live.
loadRepoEnv(join(HERE, "..", ".env"));

const cfg = bridgeConfig();

if (!cfg.enabled) {
    console.error("obs-bridge: set PI_OBS_TG_TOKEN (a Telegram bot token from @BotFather) to start the bridge.");
    process.exit(1);
}
if (!cfg.cwd) {
    console.error("obs-bridge: set PI_OBS_TG_CWD to the project directory the bridge operates in (required — no fallback). It scopes chat sessions and is the working directory for /dispatch.");
    process.exit(1);
}
if (!cfg.allow.length) {
    console.warn("obs-bridge: PI_OBS_TG_ALLOW is empty — every message will be refused. Message the bot once; it replies with your chat id to add.");
}

// Single-instance guard. Two bridges on the same bot token double-reply to every
// message, so refuse to start when a live one already holds the pidfile lock.
// A stale pidfile (holder no longer running, e.g. after a SIGKILL) is reclaimed.
const pidfile = join(HERE, "..", ".obs-bridge.pid");
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
    }
};
// fs-backed pidfile I/O. The O_EXCL (`wx`) create in writeNew is the atomic
// arbiter that makes the acquisition race-free (see acquireBridgeLock).
const lockIO: LockIO = {
    writeNew(content) {
        try {
            writeFileSync(pidfile, content, { flag: "wx" });
            return "created";
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error";
        }
    },
    read() {
        try {
            return readFileSync(pidfile, "utf8");
        } catch {
            return null;
        }
    },
    removeIfMatches(expect) {
        try {
            if (readFileSync(pidfile, "utf8").trim() === expect.trim()) unlinkSync(pidfile);
        } catch {
            /* already gone / unreadable → nothing to reclaim */
        }
    },
};
const lock = acquireBridgeLock(lockIO, process.pid, alive);
if (!lock.claim) {
    console.error(`obs-bridge: another bridge is already running (pid ${lock.heldByPid}). Stop it first with: ./run.sh --bridge-stop`);
    process.exit(1);
}
process.on("exit", () => {
    try {
        unlinkSync(pidfile);
    } catch {}
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

console.log(`obs-bridge: Telegram bridge up → ${cfg.apiBase} (${cfg.allow.length} allowed chat${cfg.allow.length === 1 ? "" : "s"}${cfg.apiToken ? ", API token set" : ""}).`);

runBridge(cfg).catch((e) => {
    console.error("obs-bridge: fatal:", e);
    process.exit(1);
});
