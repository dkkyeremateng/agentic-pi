// obs-watch.ts — a tiny live viewer for ONE agent's obs lane, meant to run inside a
// multiplexer pane the orchestrator opens (utils/workflow/pane-mux.ts). It tails the
// obs sink FILE (no server, no auth needed), filters to a run + agent, locks onto the
// first matching session, and prints a compact colored line per event. It exits when
// that session ends. Purely cosmetic — nothing here is required for a run to work.
//
//   node --experimental-strip-types obs/obs-watch.ts --run <id> --agent <name> [--sink <file>]

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
// Type-only (erased at runtime): this file runs standalone under
// `node --experimental-strip-types`, which does NOT resolve the repo's
// extensionless imports — so it deliberately has NO runtime repo imports.
import type { ObsEvent } from "./obs-events";

// ── formatting (pure) ────────────────────────────────────────────────────────

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const C = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => C("2", s);
const red = (s: string) => C("31", s);
const green = (s: string) => C("32", s);
const yellow = (s: string) => C("33", s);
const cyan = (s: string) => C("36", s);
const bold = (s: string) => C("1", s);

function tok(n: number): string {
    if (!n) return "0";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}
function clock(ts: number): string {
    try {
        return new Date(ts).toISOString().slice(11, 19);
    } catch {
        return "--:--:--";
    }
}

/** Render one obs event as a compact viewer line, or null to skip it. Pure. */
export function formatWatchEvent(ev: ObsEvent): string | null {
    const p = (ev.payload ?? {}) as Record<string, any>;
    const t = dim(clock(ev.ts));
    switch (ev.type) {
        case "session_start":
            return `${t} ${green("▶ start")}${p.model ? " · " + dim(String(p.model)) : ""}`;
        case "turn_end": {
            const total = Number(p.tokens?.total ?? 0);
            const cost = Number(p.costUsd ?? 0);
            const pct = p.context?.percent;
            const bits = [
                cyan(`● turn ${p.turnIndex ?? "?"}`),
                `${tok(total)} tok`,
                `$${cost.toFixed(cost < 1 ? 4 : 2)}`,
            ];
            if (pct != null) bits.push(dim(`ctx ${Math.round(Number(pct))}%`));
            if (p.stopReason === "length" || p.stopReason === "max_tokens") bits.push(red("TRUNCATED"));
            return `${t} ${bits.join(" · ")}`;
        }
        case "tool_start": {
            // The command / call detail — the most useful "what is it doing" line.
            const name = String(p.toolName || "tool");
            const arg = String(p.arg || "").replace(/\s+/g, " ").trim();
            return `${t}   ${yellow("→ " + name)}${arg ? " " + dim(arg) : ""}`;
        }
        case "tool_end": {
            const name = String(p.toolName || "tool");
            const ms = Number(p.durationMs ?? 0);
            const mark = p.isError ? red("✖") : green("✓");
            const dur = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
            let line = `${t}   ${mark} ${name} ${dim(dur)}`;
            // Tool output — the other half of the detail (result preview is single-line).
            const result = String(p.result || "").replace(/\s+/g, " ").trim();
            if (result) line += `\n           ${(p.isError ? red : dim)(result)}`;
            return line;
        }
        case "message": {
            // The agent's own prose (reasoning / report). Only present when the
            // sub-agent runs with PI_OBS_CONTENT=1; otherwise these events never emit.
            const text = String(p.text || "").replace(/\s+$/, "");
            if (!text.trim()) return null;
            const thinking = p.kind === "thinking";
            const head = `${t} ${thinking ? dim("… thinking") : cyan("„ assistant")}`;
            const body = text
                .split("\n")
                .map((l) => "     " + (thinking ? dim(l) : l))
                .join("\n");
            return `${head}\n${body}`;
        }
        case "error":
            return `${t} ${red("✖ provider error")}${p.status ? dim(` (status ${p.status})`) : ""}`;
        case "compaction":
            return `${t} ${yellow("↻ compaction")}${p.reason ? dim(` (${p.reason})`) : ""}`;
        case "dispatch_error":
            return `${t} ${red("✖ dispatch error")}${p.reason ? dim(` (${p.reason})`) : ""}`;
        case "session_end":
            return `${t} ${bold("■ done")}`;
        default:
            return null;
    }
}

// ── args + sink ──────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { run?: string; agent?: string; sink?: string; dispatch?: string } {
    const out: { run?: string; agent?: string; sink?: string; dispatch?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--run") out.run = argv[++i];
        else if (a === "--agent") out.agent = (argv[++i] || "").toLowerCase();
        else if (a === "--sink") out.sink = argv[++i];
        else if (a === "--dispatch") out.dispatch = argv[++i];
    }
    return out;
}

export function sinkPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.PI_OBS_SINK) return resolvePath(env.PI_OBS_SINK.replace(/^~(?=$|\/)/, homedir()));
    return join(homedir(), ".pi", "agent", "obs", "events.jsonl");
}

// ── tail loop (IO) ───────────────────────────────────────────────────────────

function run(): void {
    const { run: runId, agent, sink: sinkArg, dispatch } = parseArgs(process.argv.slice(2));
    if (!runId || !agent) {
        process.stderr.write("obs-watch: --run <id> and --agent <name> are required\n");
        process.exit(2);
    }
    const sink = sinkArg ? resolvePath(sinkArg) : sinkPath();

    process.stdout.write(`${bold(cyan(`⧉ ${agent}`))} ${dim(`· run ${runId} · tailing obs lane`)}\n`);

    let locked: string | null = null; // sessionId we've pinned to
    let pos = existsSync(sink) ? statSync(sink).size : 0; // start at EOF: only new events
    let leftover = ""; // partial trailing line held until its newline arrives

    const onLine = (line: string) => {
        const s = line.trim();
        if (!s) return;
        let ev: ObsEvent;
        try {
            ev = JSON.parse(s) as ObsEvent;
        } catch {
            return;
        }
        if (!ev || ev.runId !== runId || ev.agent !== agent) return;
        if (locked === null) {
            if (dispatch) {
                // Concurrent same-agent instances share run+agent; lock precisely onto
                // the one carrying our dispatch id (its session_start payload). Ignore
                // everything until that session_start arrives.
                if (ev.type === "session_start" && (ev.payload as any)?.dispatchId === dispatch) locked = ev.sessionId;
                else return;
            } else {
                locked = ev.sessionId; // no dispatch id (single dispatch): first match wins
            }
        }
        if (ev.sessionId !== locked) return; // ignore other concurrent instances
        const out = formatWatchEvent(ev);
        if (out) process.stdout.write(out + "\n");
        if (ev.type === "session_end") {
            // let the pane linger briefly so the last lines are readable, then exit
            setTimeout(() => process.exit(0), 1500);
        }
    };

    const CHUNK = 1 << 16;
    const buf = Buffer.alloc(CHUNK);
    const poll = () => {
        try {
            if (!existsSync(sink)) return;
            const size = statSync(sink).size;
            if (size <= pos) return;
            const fd = openSync(sink, "r");
            try {
                let p = pos;
                while (p < size) {
                    const n = readSync(fd, buf, 0, Math.min(CHUNK, size - p), p);
                    if (n <= 0) break;
                    leftover += buf.toString("utf-8", 0, n);
                    let nl: number;
                    while ((nl = leftover.indexOf("\n")) >= 0) {
                        onLine(leftover.slice(0, nl));
                        leftover = leftover.slice(nl + 1);
                    }
                    p += n;
                }
                pos = p;
            } finally {
                closeSync(fd);
            }
        } catch {
            /* transient read races are fine — try again next tick */
        }
    };

    const timer = setInterval(poll, 200);
    // A run should never leave a pane tailing forever; cap the viewer's lifetime.
    const maxMs = Number(process.env.PI_WORKFLOW_PANE_MAX_MS) || 60 * 60_000;
    setTimeout(() => process.exit(0), maxMs);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
        process.on(sig, () => {
            clearInterval(timer);
            process.exit(0);
        });
    poll();
}

// Only run the tail loop when executed directly (not when imported by tests).
if (process.argv[1] && /obs-watch\.ts$/.test(process.argv[1])) run();
