// obs-dispatch.ts — spawn a single named workflow agent headless and stream its
// reply, with NO active run/orchestrator required. The obs-server exposes this
// via /api/dispatch + /api/agents; the Telegram bridge drives it (e.g.
// "seeker, ping https://google.com").
//
// Design (mirrors obs-chat/obs-llm):
//   - Reuses the workflow's own spawn recipe (loadAgents, subagentExtArgs,
//     spawnModelArg, …) so a dispatched agent is identical to one the orchestrator
//     would spawn — same prompt, tools, model, guards.
//   - STDLIB + workflow-core only; resolves pi via PI_OBS_PI_BIN.
//   - OFF BY DEFAULT (the route is gated on PI_OBS_DISPATCH=1). ANY agent may be
//     dispatched.
//   - CONFINED TO THE cwd: cwd-guard is FORCED on (PI_CONFINE_CWD), so the agent's
//     FILE tools (read/write/edit/grep/find/ls) cannot escape the caller-provided
//     cwd. `bash` is NOT confined by cwd-guard, so for real WRITE confinement (bash
//     included) set PI_OBS_DISPATCH_SANDBOX (macOS sandbox-exec) or
//     PI_OBS_DISPATCH_SANDBOX_CMD (a bwrap/firejail/docker wrapper). The macOS
//     sandbox confines BOTH reads and writes to the cwd (+ the tool infra/caches
//     an agent needs — node, this repo, ~/.pi, ~/.config, ~/Library/Caches, temp,
//     plus PI_OBS_DISPATCH_{READ,WRITE}_EXTRA); the rest of $HOME (other projects,
//     ~/.ssh, ~/.aws) is hidden. System reads + network + exec stay open so tools
//     run. Fail-closed.
//   - The agent runs as its OWN root run, so it shows on the dashboard.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChatLine, type ChatEvent } from "./obs-chat";
import {
    type AgentDef,
    loadAgents,
    shouldApproveProjectForSpawn,
    spawnModelArg,
    spawnSessionName,
    subagentExtArgs,
    TRIVIAL_PING_RULE,
} from "../utils/workflow/workflow-core";

/** A read-only agent has no file-mutating tool (no `write`/`edit`) — the same
 *  `canWrite` test subagentExtArgs uses. These are the only dispatchable agents:
 *  they read/search/query, never change state. Excludes implementer, shipper, and
 *  the plan-writers (planner/refiner, which write .agent/plan.md). */
export function isReadOnlyAgent(def: AgentDef): boolean {
    return !/\b(write|edit)\b/.test(def.tools || "");
}

export interface AgentInfo {
    name: string;
    description: string;
    model: string;
    readOnly: boolean;
}

/** All known agents (project `.pi/agents/` then bundled), each flagged read-only. */
export function listAgents(cwd: string): AgentInfo[] {
    const out: AgentInfo[] = [];
    for (const def of loadAgents(cwd).values())
        out.push({ name: def.name, description: def.description || "", model: def.model || "", readOnly: isReadOnlyAgent(def) });
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve an agent by name or alias (case-insensitive). */
export function resolveAgent(cwd: string, name: string): AgentDef | null {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    for (const def of loadAgents(cwd).values()) {
        if (def.name.toLowerCase() === want) return def;
        if (def.aliases?.some((a) => a.toLowerCase() === want)) return def;
    }
    return null;
}

export interface DispatchRequest {
    agent: string;
    text: string;
    cwd: string;
    model?: string;
    sessionId?: string; // continuity across follow-ups (per chat+agent)
    signal?: AbortSignal; // abort kills the spawned pi (client disconnect / stop)
}

export interface DispatchConfig {
    timeoutMs: number;
}
export function dispatchConfig(env: NodeJS.ProcessEnv = process.env): DispatchConfig {
    return { timeoutMs: Number(env.PI_OBS_DISPATCH_TIMEOUT_MS) || 300_000 };
}

// ── OS-level sandbox (real bash confinement) ─────────────────────────────────
// cwd-guard confines the agent's FILE TOOLS but not `bash`. For true confinement
// (bash included) we wrap the spawn in an OS sandbox. macOS sandbox-exec is
// supported out of the box; any platform can use a custom wrapper command
// (bwrap/firejail/docker/…). FAIL-CLOSED: if a sandbox is requested but
// unavailable, dispatch errors instead of running unconfined.

export interface SandboxConfig {
    mode: "off" | "auto" | "sandbox-exec" | "custom";
    /** PI_OBS_DISPATCH_SANDBOX_CMD — a wrapper argv ({cwd} is substituted). */
    customCmd: string;
}
export function sandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
    const customCmd = (env.PI_OBS_DISPATCH_SANDBOX_CMD || "").trim();
    const raw = (env.PI_OBS_DISPATCH_SANDBOX || "").trim().toLowerCase();
    const mode: SandboxConfig["mode"] = customCmd ? "custom" : raw === "auto" || raw === "sandbox-exec" ? raw : "off";
    return { mode, customCmd };
}

// This repo's root — agents read their extensions/skills from here, so reads of
// it must be allowed even though it sits outside the request cwd.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function expandHome(p: string, home: string): string {
    return p.startsWith("~") ? join(home, p.slice(1)) : p;
}
/** Split a `:`/`,`-delimited path list (operator extras). */
function extraRoots(v: string | undefined): string[] {
    return (v || "").split(/[:,]/).map((s) => s.trim()).filter(Boolean);
}

/** Write roots a dispatched agent needs beyond the cwd: pi's own state plus the
 *  runtime caches tools require (e.g. Playwright's ~/Library/Caches/ms-playwright,
 *  fontconfig/npm caches), plus operator extras (PI_OBS_DISPATCH_WRITE_EXTRA).
 *  These are throwaway runtime data, not user content. */
function writeRootsFor(cwd: string, home: string, tmp: string, env: NodeJS.ProcessEnv): string[] {
    return [
        cwd,
        join(home, ".pi"),
        join(home, "Library", "Caches"), // macOS tool caches (Playwright, …)
        join(home, ".cache"), // XDG caches (Playwright on Linux, fontconfig, …)
        join(home, ".npm"), // npm cache
        tmp,
        "/private/var/folders",
        "/private/tmp",
        "/private/var/tmp",
        ...extraRoots(env.PI_OBS_DISPATCH_WRITE_EXTRA),
    ];
}

/** $HOME-relative dirs whose CONTENTS the agent may read (everything outside
 *  $HOME is already readable). Covers cwd, pi state, the node/pi install, this
 *  repo (extensions/skills), tool caches + configs, skill roots, and operator
 *  extras (PI_OBS_DISPATCH_READ_EXTRA). */
function readDataDirs(cwd: string, home: string, tmp: string, env: NodeJS.ProcessEnv, bin: string): string[] {
    const roots = [
        ...writeRootsFor(cwd, home, tmp, env), // writable ⇒ readable
        REPO_ROOT,
        join(home, ".nvm"), // node (when installed via nvm, under $HOME)
        join(home, ".config"), // tool config/state (gh, git, …)
    ];
    if (env.PI_CODING_AGENT_DIR) roots.push(expandHome(env.PI_CODING_AGENT_DIR, home));
    if (env.PI_WORKFLOW_SESSION_DIR) roots.push(expandHome(env.PI_WORKFLOW_SESSION_DIR, home));
    for (const p of (env.PI_SKILLS_DIR || "").split(pathDelimiter)) if (p) roots.push(p);
    if (bin && bin.includes("/")) roots.push(dirname(bin));
    roots.push(...extraRoots(env.PI_OBS_DISPATCH_READ_EXTRA));
    return roots;
}

/** Generate a macOS Seatbelt (SBPL) profile confining an agent — bash included —
 *  to the cwd for BOTH reads and writes: writes only under cwd (+ runtime
 *  caches/temp), and reads of the rest of $HOME (other projects, ~/.ssh, ~/.aws,
 *  …) denied except the tool infra it needs. System reads + network + exec stay
 *  allowed so pi/tools work. Pure. */
export function macSandboxProfile(o: { cwd: string; home: string; tmp: string; bin?: string; env?: NodeJS.ProcessEnv }): string {
    const env = o.env || process.env;
    const subs = (ps: string[]) =>
        ps
            .filter(Boolean)
            .map((p) => `(subpath ${JSON.stringify(p)})`)
            .join(" ");
    const lits = (ps: string[]) =>
        ps
            .filter(Boolean)
            .map((p) => `(literal ${JSON.stringify(p)})`)
            .join(" ");
    const writeRoots = writeRootsFor(o.cwd, o.home, o.tmp, env);
    const readDirs = readDataDirs(o.cwd, o.home, o.tmp, env, o.bin || "");
    const readFiles = [join(o.home, ".gitconfig"), join(o.home, ".npmrc")]; // common config FILES
    return [
        "(version 1)",
        "(allow default)", // system reads, network, and exec stay allowed
        "(deny file-write*)",
        `(allow file-write* ${subs(writeRoots)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
        // Hide the CONTENTS of the rest of $HOME (other projects, secrets). Deny
        // only file-read-DATA (not metadata) so lstat/traversal still works — else
        // Node's module loader (lstat on $HOME) breaks. The re-allow must be an
        // explicit `file-read-data` (a wildcard `file-read*` does NOT override a
        // specific `file-read-data` deny in SBPL).
        `(deny file-read-data (subpath ${JSON.stringify(o.home)}))`,
        `(allow file-read-data ${subs(readDirs)} ${lits(readFiles)})`,
    ].join("\n");
}

export type SandboxLaunch = { cmd: string; argv: string[] } | { error: string };

/** Resolve how to actually launch the agent: bare, sandbox-exec (macOS), or a
 *  custom wrapper. Returns the final argv, or an error (fail-closed) when a
 *  requested sandbox isn't usable. Pure given platform + the bin's dir. */
export function buildSandboxLaunch(sb: SandboxConfig, cwd: string, bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): SandboxLaunch {
    if (sb.mode === "off") return { cmd: bin, argv: args };
    if (sb.mode === "custom") {
        const toks = sb.customCmd.replace(/\{cwd\}/g, cwd).split(/\s+/).filter(Boolean);
        if (!toks.length) return { error: "PI_OBS_DISPATCH_SANDBOX_CMD is empty" };
        return { cmd: toks[0], argv: [...toks.slice(1), bin, ...args] };
    }
    if (sb.mode === "auto" && platform !== "darwin")
        return { error: "no built-in sandbox for this platform — set PI_OBS_DISPATCH_SANDBOX_CMD (e.g. a bwrap/firejail/docker invocation) or run the server in a container." };
    // sandbox-exec (explicit, or auto on darwin)
    if (platform !== "darwin") return { error: "PI_OBS_DISPATCH_SANDBOX=sandbox-exec requires macOS." };
    if (!existsSync("/usr/bin/sandbox-exec")) return { error: "sandbox-exec not found at /usr/bin/sandbox-exec." };
    const home = env.HOME || homedir();
    const tmp = env.TMPDIR || "/tmp";
    const profile = macSandboxProfile({ cwd, home, tmp, bin, env });
    return { cmd: "/usr/bin/sandbox-exec", argv: ["-p", profile, bin, ...args] };
}

export type SpawnFn = typeof spawn;

/** Spawn the named agent for one task and stream parsed ChatEvents to onEvent.
 *  Validation failures (unknown agent / not read-only) surface as an `error`
 *  event then resolve (so the SSE route ends cleanly). Resolves when pi exits. */
export function dispatchStream(
    req: DispatchRequest,
    onEvent: (e: ChatEvent) => void,
    cfg: DispatchConfig = dispatchConfig(),
    spawnImpl: SpawnFn = spawn,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const def = resolveAgent(req.cwd, req.agent);
        if (!def) {
            onEvent({ type: "error", error: `unknown agent "${req.agent}". send /agents for the list.` });
            resolve();
            return;
        }

        const bin = process.env.PI_OBS_PI_BIN || "pi";
        const args = [
            "--mode",
            "json",
            "-p",
            "--tools",
            def.tools,
            "--append-system-prompt",
            def.systemPrompt + TRIVIAL_PING_RULE,
            "--name",
            spawnSessionName(req.cwd, def.name),
        ];
        if (req.sessionId) args.push("--session-id", req.sessionId);
        if (shouldApproveProjectForSpawn(req.cwd)) args.push("--approve");
        // Force cwd confinement: cwd-guard keeps the agent's FILE tools inside the
        // cwd regardless of the server's own PI_CONFINE_CWD. (bash is not confined
        // in-process — see the header note.)
        args.push(...subagentExtArgs(def.tools, def.readOnlyBash, { obs: true, confineCwd: true }));
        const modelArg = spawnModelArg(req.model || def.model);
        if (modelArg) args.push("--model", modelArg);
        args.push(req.text);

        // Standalone run: emit to the dashboard as a ROOT run named after the
        // agent (no PI_OBS_PARENT ⇒ obs-live treats it as root). Strip any
        // inherited dispatch/trace linkage so it never looks like a child of a
        // phantom orchestrator.
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PI_OBS: "1",
            PI_OBS_AGENT: def.name.toLowerCase(),
            PI_SUBAGENT: "1",
            PI_CONFINE_CWD: "1", // confine the agent's file tools to req.cwd
        };
        delete env.PI_OBS_PARENT;
        delete env.PI_OBS_RUN;
        delete env.PI_OBS_DISPATCH_ID;

        // Optional OS-level sandbox (real bash confinement). Fail-closed: a
        // requested-but-unusable sandbox errors instead of running unconfined.
        const launch = buildSandboxLaunch(sandboxConfig(), req.cwd, bin, args);
        if ("error" in launch) {
            onEvent({ type: "error", error: `sandbox: ${launch.error}` });
            resolve();
            return;
        }

        let proc;
        try {
            proc = spawnImpl(launch.cmd, launch.argv, { stdio: ["ignore", "pipe", "pipe"], env, cwd: req.cwd });
        } catch (e) {
            onEvent({ type: "error", error: String((e as Error)?.message || e) });
            reject(e);
            return;
        }

        let buf = "";
        let err = "";
        let sawDone = false;
        const timer = setTimeout(() => proc.kill("SIGTERM"), cfg.timeoutMs);

        if (req.signal) {
            if (req.signal.aborted) proc.kill("SIGTERM");
            else
                req.signal.addEventListener("abort", () => {
                    try {
                        proc.kill("SIGTERM");
                    } catch {}
                });
        }

        proc.stdout?.on("data", (d: Buffer) => {
            buf += d.toString();
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const ev = parseChatLine(line);
                if (ev) {
                    if (ev.type === "done") sawDone = true;
                    onEvent(ev);
                }
            }
        });
        proc.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
        proc.on("error", (e) => {
            clearTimeout(timer);
            const hint = (e as NodeJS.ErrnoException).code === "ENOENT" ? ` — '${bin}' not on PATH; set PI_OBS_PI_BIN` : "";
            onEvent({ type: "error", error: `spawn ${bin}: ${e.message}${hint}` });
            reject(e);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            const ev = parseChatLine(buf);
            if (ev) {
                if (ev.type === "done") sawDone = true;
                onEvent(ev);
            }
            if (code !== 0 && !sawDone) onEvent({ type: "error", error: `agent exited ${code}${err ? `: ${err.slice(-300)}` : ""}` });
            resolve();
        });
    });
}
