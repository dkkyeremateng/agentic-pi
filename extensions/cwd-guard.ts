// ABOUTME: Confines an agent's FILE tools to the working directory. Registers a
// blocking `tool_call` hook that rejects read/edit/write/grep/find/ls calls whose
// path escapes the cwd. Loaded into sub-agent processes by the spawn when
// PI_CONFINE_CWD=1 (see workflow-core.subagentExtArgs).
//
// READ-ONLY tools (read/grep/find/ls) may ALSO reach the skill roots — the bundled
// skills in this repo AND pi's global skills (getAgentDir()/skills) — which live
// outside the user's cwd. Otherwise a skill-using agent (e.g. seeker + the bowser
// skill) can't read its own skill files and falls back to guessing/exploring. The
// parent passes these roots via PI_SKILLS_DIR (a path-delimited list). WRITE tools
// (edit/write) stay confined to the cwd.
//
// LIMITATION: `bash` is NOT confined — a shell command can read/write anywhere and
// can't be reliably parsed. True bash confinement needs OS-level sandboxing, which
// pi does not provide. The agent prompts also instruct staying within the cwd as a
// backstop for bash.
//
// That limitation has a PERVERSE EFFECT worth knowing: confining the write tools
// while leaving bash open FUNNELS out-of-cwd work into bash. Observed live — an
// implementer spiking in /tmp could not use `write` there, so it built the whole
// spike with `cat >`/`sed -i`, producing no write events, no path checks, and
// nothing the run could see. Turning confinement on made that work less visible,
// not more. The mitigation is prompt-side and deliberate: the implementer prompts
// point spikes at `.agent/scratch/` INSIDE the cwd, so the legal path is also the
// convenient one (see workflow-core.implementTask).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "url";
import { dirname, resolve, delimiter as pathDelimiter } from "path";
import {
    isOutsideCwd,
    isWithinAny,
    defaultSkillRoots,
} from "../utils/guards/path-guard";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOLS = ["edit", "write"] as const;

// Skill roots read-only tools may reach even outside the cwd. Prefer the list the
// spawn passes via PI_SKILLS_DIR (path-delimited: bundled skills + pi's global
// skills, resolved reliably in the parent). When run standalone (`pi -e cwd-guard.ts`,
// no PI_SKILLS_DIR) fall back to resolving the same roots ourselves — the bundled
// skills (sibling of extensions/) plus pi's global skills — so an exclusively-loaded
// guard exempts exactly what the spawned one does.
const skillRoots: string[] = (process.env.PI_SKILLS_DIR || "")
    .split(pathDelimiter)
    .map((p) => p.trim())
    .filter(Boolean);
if (skillRoots.length === 0) {
    try {
        const bundled = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "skills",
        );
        skillRoots.push(...defaultSkillRoots(bundled));
    } catch {
        // no exemption if we can't locate ourselves
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

        // Read-only tools: allowed inside the cwd OR any skill root.
        for (const tool of READ_ONLY_TOOLS) {
            if (isToolCallEventType(tool, event)) {
                const p = pathOf(event);
                if (typeof p === "string" && !isWithinAny([cwd, ...skillRoots], p)) {
                    return {
                        block: true,
                        reason: `Blocked: "${p}" is outside the working directory (${cwd}) and the skill directories. This agent may only read files within the cwd (plus bundled and global skills).`,
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
