// ABOUTME: Confines an agent's FILE tools to the working directory. Registers a
// blocking `tool_call` hook that rejects read/edit/write/grep/find/ls calls whose
// path escapes the cwd. Loaded into sub-agent processes by the spawn when
// PI_CONFINE_CWD=1 (see workflow-core.subagentExtArgs).
//
// READ-ONLY tools (read/grep/find/ls) may ALSO reach the bundled skills directory,
// which lives in this repo (outside the user's cwd) — otherwise a skill-using agent
// (e.g. seeker + the bowser skill) can't read its own skill files and falls back to
// guessing/exploring. WRITE tools (edit/write) stay confined to the cwd.
//
// LIMITATION: `bash` is NOT confined — a shell command can read/write anywhere and
// can't be reliably parsed. True bash confinement needs OS-level sandboxing, which
// pi does not provide. The agent prompts also instruct staying within the cwd as a
// backstop for bash.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { isOutsideCwd, isWithinAny } from "../utils/path-guard";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOLS = ["edit", "write"] as const;

// The repo's skills directory (extensions/ and skills/ are siblings). Prefer the
// path the spawn passes via PI_SKILLS_DIR (resolved reliably in the parent); fall
// back to resolving from this file's own location.
let skillsDir: string | undefined = process.env.PI_SKILLS_DIR || undefined;
if (!skillsDir) {
    try {
        skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    } catch {
        skillsDir = undefined; // no exemption if we can't locate ourselves
    }
}

export default function (pi: ExtensionAPI) {
    let cwd = process.cwd();
    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx?.cwd || process.cwd();
    });

    pi.on("tool_call", (event) => {
        const pathOf = (e: typeof event): string | undefined => {
            const input = e.input as { path?: string; file_path?: string };
            return input.path ?? input.file_path;
        };

        // Read-only tools: allowed inside the cwd OR the bundled skills dir.
        for (const tool of READ_ONLY_TOOLS) {
            if (isToolCallEventType(tool, event)) {
                const p = pathOf(event);
                if (typeof p === "string" && !isWithinAny([cwd, skillsDir], p)) {
                    return {
                        block: true,
                        reason: `Blocked: "${p}" is outside the working directory (${cwd}) and the skills directory. This agent may only read files within the cwd (plus its bundled skills).`,
                    };
                }
                return undefined;
            }
        }

        // Write tools: confined strictly to the cwd.
        for (const tool of WRITE_TOOLS) {
            if (isToolCallEventType(tool, event)) {
                const p = pathOf(event);
                if (typeof p === "string" && isOutsideCwd(cwd, p)) {
                    return {
                        block: true,
                        reason: `Blocked: "${p}" is outside the working directory (${cwd}). This agent may only write files within the cwd.`,
                    };
                }
                return undefined;
            }
        }
        return undefined;
    });
}
