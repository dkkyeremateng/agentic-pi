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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeConfig } from "./obs-bridge-core";
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
if (!cfg.allow.length) {
    console.warn("obs-bridge: PI_OBS_TG_ALLOW is empty — every message will be refused. Message the bot once; it replies with your chat id to add.");
}

console.log(`obs-bridge: Telegram bridge up → ${cfg.apiBase} (${cfg.allow.length} allowed chat${cfg.allow.length === 1 ? "" : "s"}${cfg.apiToken ? ", API token set" : ""}).`);

runBridge(cfg).catch((e) => {
    console.error("obs-bridge: fatal:", e);
    process.exit(1);
});
