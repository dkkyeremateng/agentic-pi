// pane-mux.ts — OPT-IN terminal-multiplexer panes for dispatched sub-agents.
//
// When the root orchestrator dispatches a sub-agent AND (a) PI_WORKFLOW_PANES is on,
// (b) PI_OBS is on, (c) the run is driven from an INTERACTIVE pi terminal, and (d)
// we're inside a supported multiplexer, this opens a dedicated pane that live-tails
// THAT agent's obs lane (obs/obs-watch.ts). The pane is a passive VIEWER fed by the
// existing obs telemetry — it does NOT take over the child's stdout, so the
// orchestrator's capture/kill invariants are untouched. Every hook is best-effort and
// a clean no-op when disabled/unsupported: panes never affect whether or how a run
// succeeds.
//
// Condition (c) — an interactive TTY — is deliberate: dispatches initiated through
// Telegram or the pi-obs chat run the agent HEADLESS (no TTY), so they never get
// panes even if the bridge/server runs inside a multiplexer. Panes are for the pi
// session a human is actually sitting in front of.
//
// Supported: tmux ($TMUX), zellij ($ZELLIJ), WezTerm ($WEZTERM_PANE), kitty
// ($KITTY_WINDOW_ID, needs remote control). Detection + command building are pure and
// unit-tested; the spawn/kill IO is a thin, guarded wrapper.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// "herdr" (herdr.dev) is not a CLI-split surface like the others — it's driven over a
// newline-delimited JSON socket (a multi-step split → find-new-pane → run sequence),
// so it bypasses paneOpenCommand/paneCloseCommand and uses openHerdrPane() below.
export type MuxKind = "tmux" | "zellij" | "wezterm" | "kitty" | "iterm2" | "herdr";
export interface Mux {
    kind: MuxKind;
}

const truthy = (v: string | undefined) => {
    const s = (v || "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "on";
};

/** Escape a string for embedding inside an AppleScript "…" literal (iTerm2 path). */
const asEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Detect the surrounding split surface (tmux → zellij → wezterm → kitty → iTerm2).
 *  tmux/zellij come first so tmux-inside-iTerm2 correctly targets tmux. WezTerm, kitty
 *  and iTerm2 are GUI terminals whose OWN split works with no multiplexer — which is
 *  how panes work outside tmux. */
export function detectMux(env: NodeJS.ProcessEnv = process.env): Mux | null {
    if (env.TMUX) return { kind: "tmux" };
    if (env.ZELLIJ || env.ZELLIJ_SESSION_NAME) return { kind: "zellij" };
    // herdr is the immediate surface when pi runs inside a herdr pane. It must beat
    // wezterm/kitty/iTerm2 because the terminal UNDER herdr leaks its own env (e.g.
    // TERM_PROGRAM=iTerm.app) into herdr panes; but stay below tmux/zellij so
    // tmux-inside-herdr still targets tmux. Needs HERDR_PANE_ID to know which pane to split.
    if (truthy(env.HERDR_ENV) && env.HERDR_PANE_ID) return { kind: "herdr" };
    if (env.WEZTERM_PANE) return { kind: "wezterm" };
    if (env.KITTY_WINDOW_ID) return { kind: "kitty" };
    if (env.TERM_PROGRAM === "iTerm.app" || env.ITERM_SESSION_ID) return { kind: "iterm2" };
    return null;
}

// pi's authoritative "is this an interactive session" flag (ctx.hasUI), published
// by obs-live at session_start. Preferred over process.stdout.isTTY, which pi's TUI
// does not reliably keep as a TTY. Falls back to isTTY when obs-live hasn't published
// (e.g. obs off — but then panes are disabled anyway).
const HAS_UI_GLOBAL = "__pi_hasUiGetter__";

/** Publish pi's hasUI flag (called by obs-live with () => ctx.hasUI). */
export function publishHasUi(fn: () => boolean): void {
    (globalThis as any)[HAS_UI_GLOBAL] = fn;
}

/** Whether this is an interactive pi session a human is attached to. Prefers pi's
 *  ctx.hasUI (published by obs-live); falls back to process.stdout.isTTY. */
export function interactivePi(): boolean {
    try {
        const fn = (globalThis as any)[HAS_UI_GLOBAL];
        if (typeof fn === "function") return fn() === true;
    } catch {
        /* fall through */
    }
    return process.stdout.isTTY === true;
}

/** The reason panes are NOT enabled for this env, or null when they ARE. Powers both
 *  panesEnabled and openAgentPane's debug log. `isTty` is injectable for tests. */
export function panesReason(
    env: NodeJS.ProcessEnv = process.env,
    isTty: boolean = interactivePi(),
): string | null {
    if (!truthy(env.PI_WORKFLOW_PANES)) return "disabled — PI_WORKFLOW_PANES not set";
    if (!truthy(env.PI_OBS)) return "PI_OBS not set (the pane viewer reads the obs sink)";
    // Interactive pi ONLY: Telegram / pi-obs-chat dispatches run the agent HEADLESS
    // (hasUI false), so they never get panes even when the bridge/server sits inside a
    // multiplexer (which would leak $TMUX/$ZELLIJ into the child).
    if (!isTty) return "not an interactive pi session (headless — e.g. Telegram / pi-obs chat)";
    if ((parseInt(env.PI_DISPATCH_DEPTH || "0", 10) || 0) !== 0) return "not the root orchestrator (nested dispatch)";
    if (detectMux(env) === null) return "no supported split surface (tmux/zellij/WezTerm/kitty/iTerm2)";
    return null;
}

/** Panes are opened only when panesReason() is null. */
export function panesEnabled(
    env: NodeJS.ProcessEnv = process.env,
    isTty: boolean = interactivePi(),
): boolean {
    return panesReason(env, isTty) === null;
}

/** POSIX single-quote a token so an argv can be embedded in a shell-command string
 *  (tmux's split-window takes one shell string, unlike the other muxes). */
export function shquote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
const shjoin = (argv: string[]) => argv.map(shquote).join(" ");

/** Where the new pane goes relative to the orchestrator: "right" is a horizontal
 *  (side-by-side) split; "down" is a vertical (stacked) split. */
export type PaneSplit = "right" | "down";

/** Read the desired split orientation. Default "right" (horizontal / side-by-side);
 *  PI_WORKFLOW_PANE_SPLIT=down (or v/vertical/stacked/below) stacks it instead. */
export function paneSplitDir(env: NodeJS.ProcessEnv = process.env): PaneSplit {
    const v = (env.PI_WORKFLOW_PANE_SPLIT || "").trim().toLowerCase();
    if (["down", "v", "vertical", "stacked", "below", "bottom"].includes(v)) return "down";
    return "right";
}

/** Build the mux command that opens a pane running `cmd` (an argv), split `dir`.
 *  `idFromStdout` says whether the mux prints the new pane/window id on stdout (so
 *  we can kill it later). Pure. */
export function paneOpenCommand(
    mux: Mux,
    cmd: string[],
    title: string,
    dir: PaneSplit = "right",
): { file: string; argv: string[]; idFromStdout: boolean } {
    const right = dir === "right";
    switch (mux.kind) {
        case "tmux":
            // -h horizontal (side-by-side) / -v vertical (stacked); -d: don't steal
            // focus from the orchestrator; -PF: print the new pane id.
            return { file: "tmux", argv: ["split-window", right ? "-h" : "-v", "-d", "-P", "-F", "#{pane_id}", shjoin(cmd)], idFromStdout: true };
        case "wezterm":
            // --horizontal → new pane to the right; default (omitted) → below.
            return { file: "wezterm", argv: ["cli", "split-pane", ...(right ? ["--horizontal"] : []), "--", ...cmd], idFromStdout: true };
        case "zellij":
            // No reliable kill-by-id, so lean on --close-on-exit + the viewer self-exiting.
            return { file: "zellij", argv: ["run", "--close-on-exit", "--direction", right ? "right" : "down", "--name", title, "--", ...cmd], idFromStdout: false };
        case "kitty":
            // Needs allow_remote_control; vsplit → side-by-side, hsplit → stacked.
            return { file: "kitty", argv: ["@", "launch", "--type=window", "--location", right ? "vsplit" : "hsplit", "--title", title, ...cmd], idFromStdout: true };
        case "iterm2": {
            // iTerm2 has no split CLI — drive it via AppleScript. "vertically" = side
            // by side, "horizontally" = stacked. The shell command is embedded as the
            // pane's `command`; the script returns the new session id (stdout) so we
            // can close it. Needs macOS Automation permission (prompts on first use).
            const verb = right ? "vertically" : "horizontally";
            const asCmd = asEscape(shjoin(cmd));
            const script =
                `tell application "iTerm2"\n` +
                `  tell current session of current tab of current window\n` +
                `    set s to (split ${verb} with default profile command "${asCmd}")\n` +
                `  end tell\n` +
                `  return id of s\n` +
                `end tell`;
            return { file: "osascript", argv: ["-e", script], idFromStdout: true };
        }
        case "herdr":
            // Unreachable: herdr is handled by openHerdrPane over the socket.
            throw new Error("herdr panes use the socket, not paneOpenCommand");
    }
}

/** Build the mux command that closes a previously-opened pane by id, or null when the
 *  mux can't target one (zellij → rely on close-on-exit). Pure. */
export function paneCloseCommand(mux: Mux, paneId: string): { file: string; argv: string[] } | null {
    if (!paneId) return null;
    switch (mux.kind) {
        case "tmux":
            return { file: "tmux", argv: ["kill-pane", "-t", paneId] };
        case "wezterm":
            return { file: "wezterm", argv: ["cli", "kill-pane", "--pane-id", paneId] };
        case "kitty":
            return { file: "kitty", argv: ["@", "close-window", "--match", `id:${paneId}`] };
        case "iterm2": {
            // Find the session by the id captured at open and close it.
            const id = asEscape(paneId);
            const script =
                `tell application "iTerm2"\n` +
                `  repeat with w in windows\n` +
                `    repeat with t in tabs of w\n` +
                `      repeat with s in sessions of t\n` +
                `        if id of s is "${id}" then close s\n` +
                `      end repeat\n` +
                `    end repeat\n` +
                `  end repeat\n` +
                `end tell`;
            return { file: "osascript", argv: ["-e", script] };
        }
        case "zellij":
        case "herdr":
            return null; // zellij: close-on-exit; herdr: closed over the socket
    }
}

/** Absolute path to the viewer script, resolved like the bundled agent defs. */
function watchScript(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "obs", "obs-watch.ts");
}

/** The argv for the pane's viewer process: this same Node running obs-watch.ts over
 *  the sink, scoped to one run + agent. Pure (given execPath/script). */
export function viewerArgv(
    runId: string,
    agent: string,
    opts: { sink?: string; execPath?: string; script?: string; dispatchId?: string } = {},
): string[] {
    return [
        opts.execPath ?? process.execPath,
        "--no-warnings",
        "--experimental-strip-types",
        opts.script ?? watchScript(),
        "--run",
        runId,
        "--agent",
        agent.toLowerCase(),
        // Disambiguates concurrent instances of the SAME agent (dispatch_parallel): the
        // viewer locks onto the session whose session_start carries this dispatch id.
        ...(opts.dispatchId ? ["--dispatch", opts.dispatchId] : []),
        ...(opts.sink ? ["--sink", opts.sink] : []),
    ];
}

// ── external-steer signal (same-process, cross-module) ───────────────────────
// A getter published by obs-live that returns true while the orchestrator is
// servicing an externally-INJECTED prompt — a Telegram /attach or a pi-obs chat
// message, both of which drive the live run through LiveChatControl. Local terminal
// typing never goes through that path, so it never sets this. openAgentPane
// suppresses panes while it's true: even an INTERACTIVE orchestrator that a Telegram
// user has /attached to and is steering gets no panes for those dispatches — only
// dispatches the human initiated at the pi terminal do.
const EXTERNAL_STEER_GLOBAL = "__pi_externalSteerActive__";

/** Publish the external-steer getter (called by obs-live with () => control.busy()). */
export function publishExternalSteer(fn: () => boolean): void {
    (globalThis as any)[EXTERNAL_STEER_GLOBAL] = fn;
}

/** True while an externally-injected (Telegram / pi-obs chat) prompt is being
 *  serviced. False when no getter was published (obs-live absent → no control
 *  server → no external steer possible). Never throws. */
export function externalSteerActive(): boolean {
    try {
        const fn = (globalThis as any)[EXTERNAL_STEER_GLOBAL];
        return typeof fn === "function" && fn() === true;
    } catch {
        return false;
    }
}

export interface PaneHandle {
    close(): void;
}

// ── herdr backend (JSON socket) ──────────────────────────────────────────────
// pi inside a herdr pane drives herdr's newline-delimited JSON socket to open the
// viewer beside itself (persistent + remotely attachable, unlike a tmux split).
// The pure request-builders below are unit-tested; the socket IO can only be
// verified against a live herdr, so every call is wrapped + debug-logged.

const errMsg = (e: unknown) => (e as Error)?.message || String(e);

/** The herdr control socket: HERDR_SOCKET_PATH (injected into managed panes) else the
 *  default per-user socket. */
export function herdrSockPath(env: NodeJS.ProcessEnv = process.env): string {
    return env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

/** pane.split params: split the orchestrator's own pane (HERDR_PANE_ID) the chosen way. */
export function herdrSplitParams(parentPaneId: string, dir: PaneSplit): { pane_id: string; direction: string; ratio: number } {
    return { pane_id: parentPaneId, direction: dir === "right" ? "right" : "down", ratio: 0.4 };
}

/** Ordered attempts to launch the viewer in a pane — pane.split takes no command, so
 *  this is a separate step. herdr's exact "run in pane" schema is unconfirmed, so try
 *  the likely shapes in order (first success wins): pane.run{command} → pane.run{argv}
 *  → pane.send_input{text+enter}. */
export function herdrRunAttempts(paneId: string, cmd: string[]): { method: string; params: Record<string, unknown> }[] {
    const cmdStr = shjoin(cmd);
    return [
        { method: "pane.run", params: { pane_id: paneId, command: cmdStr } },
        { method: "pane.run", params: { pane_id: paneId, argv: cmd } },
        { method: "pane.send_input", params: { pane_id: paneId, text: cmdStr + "\n" } },
    ];
}

/** Recursively collect every `pane_id` string from a layout/list result — robust to the
 *  exact nesting. Used to find the NEW pane (the one not present before the split). */
export function extractPaneIds(result: unknown): string[] {
    const out: string[] = [];
    const walk = (v: unknown) => {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) return void v.forEach(walk);
        for (const [k, val] of Object.entries(v)) {
            if (k === "pane_id" && typeof val === "string") out.push(val);
            else walk(val);
        }
    };
    walk(result);
    return out;
}

interface HerdrClient {
    call(method: string, params: Record<string, unknown>): Promise<unknown>;
    end(): void;
}

/** Connect to herdr's Unix socket and speak newline-delimited JSON-RPC. Resolves once
 *  connected; each call() writes one request line and matches its response by id. */
function herdrConnect(sockPath: string, timeoutMs = 3000): Promise<HerdrClient> {
    return new Promise((resolve, reject) => {
        const sock = netConnect(sockPath);
        sock.setEncoding("utf8");
        let nextId = 1;
        const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
        let buf = "";
        const connectTimer = setTimeout(() => {
            sock.destroy();
            reject(new Error("herdr connect timeout"));
        }, timeoutMs);
        sock.on("connect", () => {
            clearTimeout(connectTimer);
            resolve(client);
        });
        sock.on("error", (e) => {
            clearTimeout(connectTimer);
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.reject(e);
            }
            pending.clear();
            reject(e);
        });
        sock.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                let msg: any;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                const p = msg && pending.get(msg.id);
                if (!p) continue;
                clearTimeout(p.timer);
                pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message || msg.error.code || "herdr error"));
                else p.resolve(msg.result);
            }
        });
        const client: HerdrClient = {
            call(method, params) {
                return new Promise((res, rej) => {
                    const id = "pi-" + nextId++;
                    const timer = setTimeout(() => {
                        if (pending.delete(id)) rej(new Error("herdr call timeout: " + method));
                    }, timeoutMs);
                    pending.set(id, { resolve: res, reject: rej, timer });
                    sock.write(JSON.stringify({ id, method, params }) + "\n");
                });
            },
            end() {
                try {
                    sock.end();
                } catch {
                    /* best-effort */
                }
            },
        };
    });
}

/** Open a viewer pane inside herdr: split our pane, find the new pane by diffing the
 *  pane list, run the viewer in it. Returns the new pane_id or null. Best-effort. */
async function openHerdrPane(
    sockPath: string,
    parentPaneId: string,
    dir: PaneSplit,
    cmd: string[],
    log: (m: string) => void,
): Promise<string | null> {
    let client: HerdrClient;
    try {
        client = await herdrConnect(sockPath);
    } catch (e) {
        log(`skip — herdr connect failed: ${errMsg(e)}`);
        return null;
    }
    try {
        const before = extractPaneIds(await client.call("pane.list", {}));
        await client.call("pane.split", herdrSplitParams(parentPaneId, dir));
        const after = extractPaneIds(await client.call("pane.list", {}));
        const newId = after.find((id) => !before.includes(id));
        if (!newId) {
            log("skip — herdr split produced no new pane id");
            return null;
        }
        let ran = false;
        for (const a of herdrRunAttempts(newId, cmd)) {
            try {
                await client.call(a.method, a.params);
                ran = true;
                break;
            } catch (e) {
                log(`herdr ${a.method} failed: ${errMsg(e)}`);
            }
        }
        if (!ran) {
            try {
                await client.call("pane.close", { pane_id: newId });
            } catch {
                /* best-effort */
            }
            log("skip — herdr could not run the viewer in the new pane");
            return null;
        }
        log(`opened herdr pane ${newId}`);
        return newId;
    } catch (e) {
        log(`skip — herdr open failed: ${errMsg(e)}`);
        return null;
    } finally {
        client.end();
    }
}

// Serialize herdr opens so the pane.list diff can't race across concurrent dispatches
// (dispatch_parallel) — two simultaneous splits would make "the new pane" ambiguous.
let herdrChain: Promise<unknown> = Promise.resolve();
function serializeHerdr<T>(fn: () => Promise<T>): Promise<T> {
    const p = herdrChain.then(fn, fn);
    herdrChain = p.then(
        () => {},
        () => {},
    );
    return p;
}

/** The herdr branch of openAgentPane: kick off the async socket open (serialized),
 *  flip paneActive on success, and return a handle whose close() pane.close's it. */
function openHerdrAgentPane(
    runId: string,
    agent: string,
    dispatchId: string | undefined,
    env: NodeJS.ProcessEnv,
    setActive: ((v: boolean) => void) | undefined,
    log: (m: string) => void,
): PaneHandle | null {
    const parentPaneId = env.HERDR_PANE_ID;
    if (!parentPaneId) {
        log("skip — herdr: no HERDR_PANE_ID");
        return null;
    }
    const sockPath = herdrSockPath(env);
    const cmd = viewerArgv(runId, agent, { sink: env.PI_OBS_SINK, dispatchId });
    let paneId: string | null = null;
    let closed = false;
    const opened = serializeHerdr(() => openHerdrPane(sockPath, parentPaneId, paneSplitDir(env), cmd, log))
        .then((id) => {
            paneId = id;
            if (id) setActive?.(true);
        })
        .catch(() => {});
    return {
        close() {
            if (closed) return;
            closed = true;
            void opened.then(async () => {
                if (!paneId) return;
                try {
                    const c = await herdrConnect(sockPath);
                    try {
                        await c.call("pane.close", { pane_id: paneId });
                    } finally {
                        c.end();
                    }
                } catch (e) {
                    log(`herdr close failed: ${errMsg(e)}`);
                }
            });
        },
    };
}

/** Open a viewer pane for a dispatched sub-agent's obs lane. Returns a handle whose
 *  close() best-effort kills the pane, or null when panes are disabled/unsupported or
 *  anything goes wrong. `setActive(true)` is called once a pane is actually shown (sync
 *  for CLI muxes; async for herdr, whose socket open confirms later). Never throws. */
export function openAgentPane(
    agent: string,
    dispatchId?: string,
    env: NodeJS.ProcessEnv = process.env,
    setActive?: (v: boolean) => void,
): PaneHandle | null {
    // Opt-in debug trace: when PI_WORKFLOW_PANES_DEBUG is set, record why each dispatch
    // did or didn't open a pane to ~/.pi/agent/obs/pane-debug.log (stderr would corrupt
    // the TUI). Makes this otherwise-silent, best-effort feature diagnosable.
    const debug = truthy(env.PI_WORKFLOW_PANES_DEBUG);
    const log = (msg: string) => {
        if (!debug) return;
        try {
            appendFileSync(join(homedir(), ".pi", "agent", "obs", "pane-debug.log"), `${new Date().toISOString()} ${agent}: ${msg}\n`);
        } catch {
            /* best-effort */
        }
    };
    try {
        const reason = panesReason(env);
        if (reason) {
            log(`skip — ${reason}`);
            return null;
        }
        // Suppress panes for a dispatch initiated by an injected Telegram / pi-obs
        // chat prompt, even on an interactive orchestrator (see externalSteerActive).
        if (externalSteerActive()) {
            log("skip — external steer (Telegram / pi-obs chat prompt)");
            return null;
        }
        const mux = detectMux(env)!;
        const runId = env.PI_OBS_RUN;
        if (!runId) {
            log("skip — no PI_OBS_RUN (obs collector hasn't minted a run id yet)");
            return null;
        }
        // herdr is driven over its JSON socket (async, multi-step), not a spawnSync CLI.
        if (mux.kind === "herdr") return openHerdrAgentPane(runId, agent, dispatchId, env, setActive, log);
        const open = paneOpenCommand(mux, viewerArgv(runId, agent, { sink: env.PI_OBS_SINK, dispatchId }), agent.toLowerCase(), paneSplitDir(env));
        const r = spawnSync(open.file, open.argv, { encoding: "utf-8", timeout: 3000 });
        if (r.error || (typeof r.status === "number" && r.status !== 0)) {
            log(`skip — ${mux.kind} open failed: ${r.error?.message || `exit ${r.status}`}${r.stderr ? ` — ${String(r.stderr).trim()}` : ""}`);
            return null;
        }
        const paneId = open.idFromStdout ? (r.stdout || "").trim().split("\n")[0]?.trim() || "" : "";
        log(`opened ${mux.kind} pane${paneId ? ` ${paneId}` : ""}`);
        setActive?.(true); // CLI muxes confirm synchronously
        let closed = false;
        return {
            close() {
                if (closed) return;
                closed = true;
                try {
                    const c = paneCloseCommand(mux, paneId);
                    if (c) {
                        // MUST attach an error listener: spawn reports a missing/gone
                        // binary via an ASYNC 'error' event (ENOENT), and an unhandled
                        // 'error' event crashes the whole orchestrator process — the
                        // try/catch here only guards synchronous throws.
                        const killer = spawn(c.file, c.argv, { stdio: "ignore" });
                        killer.on("error", () => {});
                        killer.unref();
                    }
                } catch {
                    /* best-effort */
                }
            },
        };
    } catch (e) {
        log(`skip — exception: ${(e as Error)?.message || e}`);
        return null;
    }
}
