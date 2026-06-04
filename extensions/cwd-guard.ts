// ABOUTME: Confines an agent's FILE tools to the working directory. Registers a
// blocking `tool_call` hook that rejects read/edit/write/grep/find/ls calls whose
// path escapes the cwd. Loaded into sub-agent processes by the spawn when
// PI_CONFINE_CWD=1 (see workflow-core.subagentExtArgs).
//
// LIMITATION: `bash` is NOT confined — a shell command can read/write anywhere and
// can't be reliably parsed. True bash confinement needs OS-level sandboxing, which
// pi does not provide. The agent prompts also instruct staying within the cwd as a
// backstop for bash.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { isOutsideCwd } from "../utils/path-guard";

const FILE_TOOLS = ["read", "edit", "write", "grep", "find", "ls"] as const;

export default function (pi: ExtensionAPI) {
    let cwd = process.cwd();
    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx?.cwd || process.cwd();
    });

    pi.on("tool_call", (event) => {
        for (const tool of FILE_TOOLS) {
            if (isToolCallEventType(tool, event)) {
                const input = event.input as { path?: string; file_path?: string };
                const p = input.path ?? input.file_path;
                if (typeof p === "string" && isOutsideCwd(cwd, p)) {
                    return {
                        block: true,
                        reason: `Blocked: "${p}" is outside the working directory (${cwd}). This agent may only access files within the cwd.`,
                    };
                }
            }
        }
        return undefined;
    });
}
