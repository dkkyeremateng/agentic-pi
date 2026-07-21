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
//   - OFF BY DEFAULT (the route is gated on PI_OBS_DISPATCH=1). Only a PURE
//     read-only agent (no write/edit AND no bash) may be dispatched with no
//     sandbox; anything with write/edit or bash requires an OS sandbox (see below)
//     — dispatch fails closed otherwise, because cwd-guard does not confine bash.
//   - CONFINED TO THE cwd: cwd-guard is FORCED on (PI_CONFINE_CWD), so the agent's
//     FILE tools (read/write/edit/grep/find/ls) cannot escape the caller-provided
//     cwd. `bash` is NOT confined by cwd-guard, so for real WRITE confinement (bash
//     included) set PI_OBS_DISPATCH_SANDBOX (macOS sandbox-exec) or
//     PI_OBS_DISPATCH_SANDBOX_CMD (a bwrap/firejail/docker wrapper). The macOS
//     sandbox confines BOTH reads and writes to the cwd (+ the tool infra/caches
//     an agent needs — node, this repo, ~/.pi, ~/.config/git, ~/Library/Caches,
//     temp, plus PI_OBS_DISPATCH_{READ,WRITE}_EXTRA); the rest of $HOME (other
//     projects, ~/.ssh, ~/.aws, ~/.npmrc, the rest of ~/.config) is hidden. System
//     reads + network + exec stay open so tools run. Fail-closed.
//   - CWD ALLOWLIST: set PI_OBS_DISPATCH_CWD to a root and every dispatch cwd must
//     resolve inside it (else rejected) — so a raw API caller can't point the
//     confinement root at an arbitrary directory (e.g. ~/.ssh).
//   - The agent runs as its OWN root run, so it shows on the dashboard.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChatLine, promptArg, type ChatEvent } from "./obs-chat";
import { isOutsideCwd } from "../utils/guards/path-guard";
import { badCwd, llmConfig, piSpawnEnv, type LlmConfig, runPlayground } from "./obs-llm";
import { memoryInjection } from "../utils/workflow/memory";
import {
    type AgentDef,
    loadAgents,
    shouldApproveProjectForSpawn,
    spawnModelArg,
    spawnSessionName,
    stripInheritedSecrets,
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

/** Whether an agent can mutate state OUTSIDE the cwd without an OS sandbox — and
 *  therefore must NOT be dispatched unconfined. True if it has `write`/`edit`
 *  (cwd-guard confines those to the cwd, but only the OS sandbox confines the
 *  process fully) OR `bash` (which is NOT confined by cwd-guard at all — the
 *  read-only bash guard only blocks mutating git/gh, so `bash` can still write
 *  anywhere). So a "read-only" agent (no write/edit) with `bash` still needs the
 *  sandbox. Pure. */
export function needsSandbox(def: AgentDef): boolean {
    return !isReadOnlyAgent(def) || /\bbash\b/.test(def.tools || "");
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

// ── auto-select: pick the best agent for a task (the /do command) ────────────

/** Tolerant parse of the selector's reply into a choice: a known agent name, or
 *  "chat" (a question/conversation that needs no tools). Accepts a JSON object,
 *  falls back to the first agent name mentioned, else "chat". Pure. */
export function parseSelection(raw: string, agentNames: string[]): { choice: string; reason: string } {
    const text = (raw || "").trim();
    const byLower = new Map(agentNames.map((n) => [n.toLowerCase(), n]));
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const o = JSON.parse(m[0]) as { choice?: unknown; reason?: unknown };
            const c = typeof o.choice === "string" ? o.choice.trim() : "";
            const reason = typeof o.reason === "string" ? o.reason.trim() : "";
            if (c.toLowerCase() === "chat") return { choice: "chat", reason };
            if (byLower.has(c.toLowerCase())) return { choice: byLower.get(c.toLowerCase())!, reason };
        } catch {
            /* fall through to a name scan */
        }
    }
    for (const n of agentNames) {
        if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return { choice: n, reason: "" };
    }
    return { choice: "chat", reason: "" };
}

/** Route a free-text task to the single best agent, or to "chat". One small pi
 *  completion over the agent roster (their descriptions) — the same signal the
 *  orchestrator's select_agents reasons over, distilled to a one-shot pick. */
export async function selectAgent(cwd: string, task: string, cfg: LlmConfig = llmConfig()): Promise<{ choice: string; reason: string; model: string }> {
    const agents = listAgents(cwd);
    const roster = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n");
    const system =
        "You route a user request to the single best agent for the job, or to plain chat.\n" +
        "Available agents:\n" +
        roster +
        "\n\n" +
        'Reply with ONLY a JSON object {"choice": "<exact agent name>" or "chat", "reason": "<one short clause>"}. ' +
        'Use "chat" when the request is a question or conversation that needs no tools. No prose, no code fences.';
    const r = await runPlayground(system, task, cfg);
    return { ...parseSelection(r.output, agents.map((a) => a.name)), model: r.model };
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
        // Only git's config dir by default — NOT all of ~/.config, which holds
        // credentials (e.g. ~/.config/gh/hosts.yml). An agent that genuinely needs
        // a tool's config/token (gh, cloud CLIs) gets it via PI_OBS_DISPATCH_READ_EXTRA.
        join(home, ".config", "git"),
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
    // git identity/config is needed by git-using agents and is low-sensitivity;
    // ~/.npmrc is NOT allowed by default (it carries the npm `_authToken`) — add it
    // via PI_OBS_DISPATCH_READ_EXTRA only when a private-registry install needs it.
    const readFiles = [join(o.home, ".gitconfig")]; // common config FILES
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

/** When a custom OS-sandbox wrapper (bwrap/firejail/…) RAN but never exec'd pi —
 *  because pi (or the node its shebang needs) isn't visible INSIDE the sandbox
 *  namespace — its stderr is a cryptic `bwrap: execvp <bin>: No such file or
 *  directory`. Turn that into an actionable hint: the wrapper must bind the dir
 *  holding pi + node. Only fires in custom-sandbox mode. Pure. */
export function sandboxBinHint(sb: SandboxConfig, bin: string, stderr: string): string {
    if (sb.mode !== "custom") return "";
    const s = stderr || "";
    const execFail = /\bexecvp\b|exec failed/i.test(s) || (/no such file or directory/i.test(s) && bin.length > 1 && s.includes(bin));
    if (!execFail) return "";
    const dir = bin.includes("/") ? bin.slice(0, bin.lastIndexOf("/")) : "the dir holding pi + node";
    return ` — the OS sandbox (PI_OBS_DISPATCH_SANDBOX_CMD) can't see '${bin}' inside its namespace; bind pi + node into it, e.g. add '--ro-bind ${dir} ${dir}', or bind the whole filesystem read-only with '--ro-bind / /' (see obs/API.md).`;
}

export type SpawnFn = typeof spawn;

/** Spawn the named agent for one task and stream parsed ChatEvents to onEvent.
 *  Fail-closed validation surfaces as an `error` event then resolves (so the SSE
 *  route ends cleanly): unknown agent; a write-capable agent without an OS sandbox;
 *  or a cwd outside PI_OBS_DISPATCH_CWD when that root is set. Resolves when pi
 *  exits. */
export function dispatchStream(
    req: DispatchRequest,
    onEvent: (e: ChatEvent) => void,
    cfg: DispatchConfig = dispatchConfig(),
    spawnImpl: SpawnFn = spawn,
): Promise<void> {
    return new Promise((resolve, reject) => {
        // Resolve the cwd to an absolute path ONCE and use it everywhere (the
        // allowlist check, the spawn cwd, and the sandbox profile) so they can't
        // disagree — a relative req.cwd would otherwise be checked against the root
        // but resolved against the server's cwd at spawn time.
        const cwd = resolvePath(req.cwd || ".");

        const def = resolveAgent(cwd, req.agent);
        if (!def) {
            onEvent({ type: "error", error: `unknown agent "${req.agent}". send /agents for the list.` });
            resolve();
            return;
        }

        // The cwd defines the confinement root, so a raw API caller must not be able
        // to aim it at an arbitrary directory. When PI_OBS_DISPATCH_CWD is set, the
        // request cwd must resolve inside it.
        const cwdRoot = (process.env.PI_OBS_DISPATCH_CWD || "").trim();
        if (cwdRoot && isOutsideCwd(resolvePath(cwdRoot), cwd)) {
            onEvent({ type: "error", error: `cwd "${cwd}" is outside the allowed dispatch root (PI_OBS_DISPATCH_CWD).` });
            resolve();
            return;
        }

        // Agents that can mutate state outside the cwd (write/edit, or bash — which
        // cwd-guard does NOT confine) require an OS sandbox for real confinement.
        // Only a pure read-only agent with no bash may run unconfined.
        const sb = sandboxConfig();
        if (needsSandbox(def) && sb.mode === "off") {
            onEvent({
                type: "error",
                error: `agent "${def.name}" can run bash or write/edit files, which is not confined without an OS sandbox. Set PI_OBS_DISPATCH_SANDBOX=auto (macOS) or PI_OBS_DISPATCH_SANDBOX_CMD (a bwrap/firejail/docker wrapper).`,
            });
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
            // Inject the agent's committed memory so a dispatched agent benefits from
            // its own past lessons (e.g. a research source found to be captcha-walled)
            // — the same injection the workflow spawn path applies. No-op when memory
            // is off or the agent has none.
            def.systemPrompt + TRIVIAL_PING_RULE + memoryInjection(def.name),
            "--name",
            spawnSessionName(cwd, def.name),
        ];
        if (req.sessionId) args.push("--session-id", req.sessionId);
        if (shouldApproveProjectForSpawn(cwd)) args.push("--approve");
        // Force cwd confinement: cwd-guard keeps the agent's FILE tools inside the
        // cwd regardless of the server's own PI_CONFINE_CWD. (bash is not confined
        // in-process — see the header note.)
        args.push(...subagentExtArgs(def.tools, def.readOnlyBash, { obs: true, confineCwd: true }));
        const modelArg = spawnModelArg(req.model || def.model);
        if (modelArg) args.push("--model", modelArg);
        args.push(promptArg(req.text)); // never let a flag-shaped prompt inject pi flags

        // Standalone run: emit to the dashboard as a ROOT run named after the
        // agent (no PI_OBS_PARENT ⇒ obs-live treats it as root). Strip any
        // inherited dispatch/trace linkage so it never looks like a child of a
        // phantom orchestrator.
        const env: NodeJS.ProcessEnv = {
            ...piSpawnEnv(),
            PI_OBS: "1",
            PI_OBS_AGENT: def.name.toLowerCase(),
            PI_SUBAGENT: "1",
            PI_CONFINE_CWD: "1", // confine the agent's file tools to cwd
        };
        delete env.PI_OBS_PARENT;
        delete env.PI_OBS_RUN;
        delete env.PI_OBS_DISPATCH_ID;
        // Least privilege: this agent is spawned BY the obs server (which holds the
        // bridge secrets), often into an OS sandbox — it must not inherit the bot
        // token or the obs API secret. Provider/skill creds are kept.
        stripInheritedSecrets(env);

        // Preflight the cwd: a missing dir would otherwise surface as a cryptic
        // "spawn <pi> ENOENT" that looks like a PATH problem (see badCwd).
        const cwdErr = badCwd(cwd);
        if (cwdErr) {
            onEvent({ type: "error", error: `dispatch: ${cwdErr}` });
            resolve();
            return;
        }

        // Optional OS-level sandbox (real bash confinement). Fail-closed: a
        // requested-but-unusable sandbox errors instead of running unconfined.
        const launch = buildSandboxLaunch(sb, cwd, bin, args);
        if ("error" in launch) {
            onEvent({ type: "error", error: `sandbox: ${launch.error}` });
            resolve();
            return;
        }

        let proc;
        try {
            // detached ⇒ the child leads its own process group, so we can signal the
            // WHOLE tree (sandbox wrapper + pi + its tool children), not just the
            // immediate wrapper, on timeout/abort.
            proc = spawnImpl(launch.cmd, launch.argv, { stdio: ["ignore", "pipe", "pipe"], env, cwd, detached: true });
        } catch (e) {
            onEvent({ type: "error", error: String((e as Error)?.message || e) });
            reject(e);
            return;
        }

        // Kill the whole process group; escalate to SIGKILL if it lingers.
        let killEscalation: ReturnType<typeof setTimeout> | undefined;
        const killTree = (sig: NodeJS.Signals) => {
            try {
                // pid > 0 guard: process.kill(-0) would signal the SERVER's own
                // process group. Real spawns give a positive pid or undefined.
                if (typeof proc.pid === "number" && proc.pid > 0) process.kill(-proc.pid, sig);
                else proc.kill(sig);
            } catch {
                try {
                    proc.kill(sig);
                } catch {}
            }
            if (sig !== "SIGKILL" && !killEscalation) killEscalation = setTimeout(() => killTree("SIGKILL"), 5_000).unref();
        };

        let buf = "";
        let err = "";
        let sawDone = false;
        const timer = setTimeout(() => killTree("SIGTERM"), cfg.timeoutMs);

        if (req.signal) {
            if (req.signal.aborted) killTree("SIGTERM");
            else req.signal.addEventListener("abort", () => killTree("SIGTERM"));
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
            if (killEscalation) clearTimeout(killEscalation);
            const hint = (e as NodeJS.ErrnoException).code === "ENOENT" ? ` — '${bin}' (or the 'node' its shebang needs) not on PATH; set PI_OBS_PI_BIN and ensure node's bin dir is on PATH` : "";
            onEvent({ type: "error", error: `spawn ${bin}: ${e.message}${hint}` });
            reject(e);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            if (killEscalation) clearTimeout(killEscalation);
            const ev = parseChatLine(buf);
            if (ev) {
                if (ev.type === "done") sawDone = true;
                onEvent(ev);
            }
            if (code !== 0 && !sawDone)
                onEvent({ type: "error", error: `agent exited ${code}${err ? `: ${err.slice(-300)}` : ""}${sandboxBinHint(sb, bin, err)}` });
            resolve();
        });
    });
}
