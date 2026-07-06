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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type MuxKind = "tmux" | "zellij" | "wezterm" | "kitty" | "iterm2";
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
            return null;
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

/** Open a viewer pane for a dispatched sub-agent's obs lane. Returns a handle whose
 *  close() best-effort kills the pane, or null when panes are disabled/unsupported or
 *  anything goes wrong. Never throws. */
export function openAgentPane(agent: string, dispatchId?: string, env: NodeJS.ProcessEnv = process.env): PaneHandle | null {
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
        const open = paneOpenCommand(mux, viewerArgv(runId, agent, { sink: env.PI_OBS_SINK, dispatchId }), agent.toLowerCase(), paneSplitDir(env));
        const r = spawnSync(open.file, open.argv, { encoding: "utf-8", timeout: 3000 });
        if (r.error || (typeof r.status === "number" && r.status !== 0)) {
            log(`skip — ${mux.kind} open failed: ${r.error?.message || `exit ${r.status}`}${r.stderr ? ` — ${String(r.stderr).trim()}` : ""}`);
            return null;
        }
        const paneId = open.idFromStdout ? (r.stdout || "").trim().split("\n")[0]?.trim() || "" : "";
        log(`opened ${mux.kind} pane${paneId ? ` ${paneId}` : ""}`);
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
