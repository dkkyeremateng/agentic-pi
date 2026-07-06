// pane-mux.ts — OPT-IN terminal-multiplexer panes for dispatched sub-agents.
//
// When the root orchestrator dispatches a sub-agent AND (a) PI_WORKFLOW_PANES is on,
// (b) PI_OBS is on, and (c) we're running inside a supported multiplexer, this opens
// a dedicated pane that live-tails THAT agent's obs lane (obs/obs-watch.ts). The pane
// is a passive VIEWER fed by the existing obs telemetry — it does NOT take over the
// child's stdout, so the orchestrator's capture/kill invariants are untouched. Every
// hook is best-effort and a clean no-op when disabled/unsupported: panes never affect
// whether or how a run succeeds.
//
// Supported: tmux ($TMUX), zellij ($ZELLIJ), WezTerm ($WEZTERM_PANE), kitty
// ($KITTY_WINDOW_ID, needs remote control). Detection + command building are pure and
// unit-tested; the spawn/kill IO is a thin, guarded wrapper.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type MuxKind = "tmux" | "zellij" | "wezterm" | "kitty";
export interface Mux {
    kind: MuxKind;
}

const truthy = (v: string | undefined) => {
    const s = (v || "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "on";
};

/** Detect the surrounding multiplexer from env (tmux → zellij → wezterm → kitty). */
export function detectMux(env: NodeJS.ProcessEnv = process.env): Mux | null {
    if (env.TMUX) return { kind: "tmux" };
    if (env.ZELLIJ || env.ZELLIJ_SESSION_NAME) return { kind: "zellij" };
    if (env.WEZTERM_PANE) return { kind: "wezterm" };
    if (env.KITTY_WINDOW_ID) return { kind: "kitty" };
    return null;
}

/** Panes are opened only when explicitly enabled, obs is on (the viewer reads the
 *  sink), a multiplexer exists, AND this process is the ROOT orchestrator (depth 0) —
 *  so a nested sub-orchestrator doesn't spawn panes-of-panes. */
export function panesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (!truthy(env.PI_WORKFLOW_PANES)) return false;
    if (!truthy(env.PI_OBS)) return false;
    if ((parseInt(env.PI_DISPATCH_DEPTH || "0", 10) || 0) !== 0) return false;
    return detectMux(env) !== null;
}

/** POSIX single-quote a token so an argv can be embedded in a shell-command string
 *  (tmux's split-window takes one shell string, unlike the other muxes). */
export function shquote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
const shjoin = (argv: string[]) => argv.map(shquote).join(" ");

/** Build the mux command that opens a pane running `cmd` (an argv). `idFromStdout`
 *  says whether the mux prints the new pane/window id on stdout (so we can kill it
 *  later). Pure. */
export function paneOpenCommand(
    mux: Mux,
    cmd: string[],
    title: string,
): { file: string; argv: string[]; idFromStdout: boolean } {
    switch (mux.kind) {
        case "tmux":
            // -d: don't steal focus from the orchestrator; -PF: print the new pane id.
            return { file: "tmux", argv: ["split-window", "-d", "-P", "-F", "#{pane_id}", shjoin(cmd)], idFromStdout: true };
        case "wezterm":
            // Splits the current pane; prints the new pane id on stdout.
            return { file: "wezterm", argv: ["cli", "split-pane", "--", ...cmd], idFromStdout: true };
        case "zellij":
            // No reliable kill-by-id, so lean on --close-on-exit + the viewer self-exiting.
            return { file: "zellij", argv: ["run", "--close-on-exit", "--name", title, "--", ...cmd], idFromStdout: false };
        case "kitty":
            // Needs allow_remote_control; prints the new window id on stdout.
            return { file: "kitty", argv: ["@", "launch", "--type=window", "--title", title, ...cmd], idFromStdout: true };
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
    opts: { sink?: string; execPath?: string; script?: string } = {},
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
        ...(opts.sink ? ["--sink", opts.sink] : []),
    ];
}

export interface PaneHandle {
    close(): void;
}

/** Open a viewer pane for a dispatched sub-agent's obs lane. Returns a handle whose
 *  close() best-effort kills the pane, or null when panes are disabled/unsupported or
 *  anything goes wrong. Never throws. */
export function openAgentPane(agent: string, env: NodeJS.ProcessEnv = process.env): PaneHandle | null {
    try {
        if (!panesEnabled(env)) return null;
        const mux = detectMux(env);
        const runId = env.PI_OBS_RUN;
        if (!mux || !runId) return null;
        const open = paneOpenCommand(mux, viewerArgv(runId, agent, { sink: env.PI_OBS_SINK }), agent.toLowerCase());
        const r = spawnSync(open.file, open.argv, { encoding: "utf-8", timeout: 3000 });
        if (r.error || (typeof r.status === "number" && r.status !== 0)) return null;
        const paneId = open.idFromStdout ? (r.stdout || "").trim().split("\n")[0]?.trim() || "" : "";
        let closed = false;
        return {
            close() {
                if (closed) return;
                closed = true;
                try {
                    const c = paneCloseCommand(mux, paneId);
                    if (c) spawn(c.file, c.argv, { stdio: "ignore" }).unref();
                } catch {
                    /* best-effort */
                }
            },
        };
    } catch {
        return null;
    }
}
