// Phase 2 (live observability) — the tailing server.
//
// Tails the sink file that pi processes append ObsEvent lines to, keeps a
// bounded in-memory store, and serves a vanilla dashboard that streams events
// over SSE. The sink file doubles as the archive: a byte-range run index backs
// /runs (every run ever recorded) and /events?run=<id> (one run's full
// history), so the dashboard is live + archive while memory stays bounded.
// Node stdlib only — no deps, no SQLite, no Bun.
//
// Usage:
//   tsx utils/obs/obs-server.ts [projectPath] [--sink <file>] [--port <n>]
//
//   projectPath  defaults to cwd; sink is <projectPath>/.agent/obs/events.jsonl
//   --sink       tail an explicit sink file instead
//   --port       listen port (default PI_OBS_PORT or 7616)

import { createServer } from "http";
import {
    existsSync,
    statSync,
    openSync,
    readSync,
    closeSync,
    readFileSync,
} from "fs";
import { join, resolve as resolvePath, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { EventStore, sseFrame, sseComment } from "./obs-server-core";
import { parseEventLine, type ObsEvent } from "./obs-events";
import { eventsToOtlp } from "./obs-otel";
import { LineScanner, RunIndexer } from "./obs-run-index";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "obs-ui");

function parseArgs(argv: string[]) {
    const o: { project?: string; sink?: string; port: number } = {
        port: Number(process.env.PI_OBS_PORT) || 7616,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--sink") o.sink = argv[++i];
        else if (a === "--port") o.port = Number(argv[++i]);
        else if (!a.startsWith("--") && !o.project) o.project = a;
    }
    return o;
}

function resolveSink(o: ReturnType<typeof parseArgs>): string {
    if (o.sink) return resolvePath(o.sink.replace(/^~(?=$|\/)/, homedir()));
    if (process.env.PI_OBS_SINK)
        return resolvePath(
            process.env.PI_OBS_SINK.replace(/^~(?=$|\/)/, homedir()),
        );
    // A positional project path tails just that project; with no args, tail the
    // shared global sink (all instances). Matches the collector's default.
    if (o.project)
        return join(resolvePath(o.project), ".agent", "obs", "events.jsonl");
    return join(homedir(), ".pi", "agent", "obs", "events.jsonl");
}

const opts = parseArgs(process.argv.slice(2));
const SINK = resolveSink(opts);
const store = new EventStore();
const clients = new Set<import("http").ServerResponse>();

// ── file tailing (poll-based; robust for appends across platforms) ───────────

let offset = 0;
let leftover = "";

// On startup, don't replay an unbounded historical file (the shared sink grows
// across runs). Start near the end; the first partial line is discarded by the
// JSON parse. Recent events still populate the ring buffer.
const PRIME_TAIL_BYTES = 2 * 1024 * 1024;
function primeOffset(): void {
    if (!existsSync(SINK)) return;
    try {
        const size = statSync(SINK).size;
        if (size > PRIME_TAIL_BYTES) offset = size - PRIME_TAIL_BYTES;
    } catch {
        /* ignore */
    }
}

function ingest(line: string): void {
    const ev = parseEventLine(line);
    if (!ev) return;
    if (store.add(ev)) broadcast(ev);
}

function readDelta(): void {
    if (!existsSync(SINK)) return;
    let size: number;
    try {
        size = statSync(SINK).size;
    } catch {
        return;
    }
    if (size < offset) {
        // truncated/rotated — restart from the top (dedupe guards repeats)
        offset = 0;
        leftover = "";
    }
    if (size === offset) return;
    const fd = openSync(SINK, "r");
    try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        offset += n;
        leftover += buf.toString("utf-8", 0, n);
    } finally {
        closeSync(fd);
    }
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? ""; // keep trailing partial line
    for (const line of lines) ingest(line);
}

// ── run history (index over the WHOLE sink, not just the in-memory tail) ─────
// The ring buffer + tail priming bound live memory, so older runs fall out of
// /events and the SSE replay. The run index makes the JSONL file itself the
// archive: it remembers every run's time bounds and byte range, and /runs +
// /events?run=<id> serve history straight from the file.

const runIndex = new RunIndexer();
const SCAN_CHUNK = 1 << 20;

// Bring the index up to date with the file — full scan on the first call, then
// just the appended delta; rebuild from the top after truncation/rotation.
function ensureRunIndex(): void {
    if (!existsSync(SINK)) return;
    let size: number;
    try {
        size = statSync(SINK).size;
    } catch {
        return;
    }
    if (size < runIndex.scannedTo) runIndex.reset();
    if (size === runIndex.scannedTo) return;
    const fd = openSync(SINK, "r");
    try {
        const buf = Buffer.alloc(SCAN_CHUNK);
        let pos = runIndex.scannedTo;
        while (pos < size) {
            const n = readSync(fd, buf, 0, Math.min(SCAN_CHUNK, size - pos), pos);
            if (n <= 0) break;
            runIndex.feed(buf.subarray(0, n));
            pos += n;
        }
    } finally {
        closeSync(fd);
    }
}

// One run's events, read straight from the sink via its indexed byte range.
// Runs interleave in a shared sink, so the range is filtered by runId.
function readRunEvents(runId: string): ObsEvent[] {
    ensureRunIndex();
    const run = runIndex.get(runId);
    if (!run) return [];
    const events: ObsEvent[] = [];
    const scanner = new LineScanner((line) => {
        const ev = parseEventLine(line);
        if (ev && ev.runId === runId) events.push(ev);
    }, run.startOffset);
    let fd: number;
    try {
        fd = openSync(SINK, "r");
    } catch {
        return [];
    }
    try {
        const buf = Buffer.alloc(SCAN_CHUNK);
        let pos = run.startOffset;
        while (pos < run.endOffset) {
            const n = readSync(
                fd,
                buf,
                0,
                Math.min(SCAN_CHUNK, run.endOffset - pos),
                pos,
            );
            if (n <= 0) break;
            scanner.push(buf.subarray(0, n));
            pos += n;
        }
    } finally {
        closeSync(fd);
    }
    return events;
}

// ── OTLP push (optional live forwarder) ──────────────────────────────────────
// With PI_OBS_OTLP_ENDPOINT set (an OTLP/HTTP traces URL, e.g.
// http://127.0.0.1:4318/v1/traces), each run's trace is POSTed once when the
// run goes quiet — so Langfuse / Phoenix / Honeycomb / Datadog become optional
// heavyweight backends with one env var. PI_OBS_OTLP_HEADERS adds auth
// ("k1=v1,k2=v2"). This is a live forwarder, not a backfill: runs already
// finished at startup are skipped (backfill via `curl /otel?run=…` instead).

const OTLP_ENDPOINT = process.env.PI_OBS_OTLP_ENDPOINT || "";
// A run this quiet is considered finished (override: PI_OBS_OTLP_QUIET_MS).
const OTLP_QUIET_MS = Number(process.env.PI_OBS_OTLP_QUIET_MS) || 60_000;
const OTLP_MAX_ATTEMPTS = 3;
const otlpDone = new Set<string>(); // pushed (or given up on) runIds
const otlpAttempts = new Map<string, number>();
let otlpSeeded = false;

function otlpHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of (process.env.PI_OBS_OTLP_HEADERS || "").split(",")) {
        const i = pair.indexOf("=");
        if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    return out;
}

async function otlpTick(): Promise<void> {
    ensureRunIndex();
    const now = Date.now();
    if (!otlpSeeded) {
        // First tick: everything already quiet predates this server — skip it.
        otlpSeeded = true;
        for (const r of runIndex.runs())
            if (now - r.lastTs > OTLP_QUIET_MS) otlpDone.add(r.runId);
        return;
    }
    for (const r of runIndex.runs()) {
        if (otlpDone.has(r.runId)) continue;
        if (now - r.lastTs < OTLP_QUIET_MS) continue; // still running
        const events = readRunEvents(r.runId);
        if (!events.length) {
            otlpDone.add(r.runId);
            continue;
        }
        const body = JSON.stringify(
            eventsToOtlp(events, {
                runId: r.runId,
                serviceName: "pi-agent-workflow",
            }),
        );
        const attempt = (otlpAttempts.get(r.runId) ?? 0) + 1;
        otlpAttempts.set(r.runId, attempt);
        try {
            const resp = await fetch(OTLP_ENDPOINT, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...otlpHeaders(),
                },
                body,
            });
            if (resp.ok) {
                otlpDone.add(r.runId);
                process.stdout.write(`otlp push ${r.runId}: ${resp.status}\n`);
            } else if (attempt >= OTLP_MAX_ATTEMPTS) {
                otlpDone.add(r.runId);
                process.stdout.write(
                    `otlp push ${r.runId}: giving up after ${attempt}× (last ${resp.status})\n`,
                );
            }
        } catch (e: any) {
            if (attempt >= OTLP_MAX_ATTEMPTS) {
                otlpDone.add(r.runId);
                process.stdout.write(
                    `otlp push ${r.runId}: giving up after ${attempt}× (${e?.message})\n`,
                );
            }
        }
    }
}

if (OTLP_ENDPOINT) {
    otlpTick().catch(() => {}); // seed immediately
    setInterval(
        () => {
            otlpTick().catch(() => {});
        },
        Math.max(2_000, Math.min(30_000, OTLP_QUIET_MS / 2)),
    ).unref();
}

// ── SSE broadcast ────────────────────────────────────────────────────────────

function broadcast(ev: ObsEvent): void {
    const frame = sseFrame(ev);
    for (const res of clients) {
        try {
            res.write(frame);
        } catch {
            /* dropped on next close */
        }
    }
}

// ── http ──────────────────────────────────────────────────────────────────────

const CONTENT: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

function serveStatic(res: import("http").ServerResponse, file: string): void {
    if (!existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
    }
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": CONTENT[ext] ?? "text/plain" });
    res.end(readFileSync(file));
}

const server = createServer((req, res) => {
    const raw = req.url ?? "/";
    const qIdx = raw.indexOf("?");
    const url = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : "");
    if (url === "/" || url === "/index.html") {
        serveStatic(res, join(UI_DIR, "index.html"));
        return;
    }
    // Dashboard client scripts (vanilla, no bundler) live under obs-ui/scripts/,
    // stylesheets under obs-ui/styles/. Serve only flat names — no traversal.
    if (url.startsWith("/scripts/")) {
        const name = url.slice("/scripts/".length);
        if (/^[a-zA-Z0-9_-]+\.js$/.test(name)) {
            serveStatic(res, join(UI_DIR, "scripts", name));
        } else {
            res.writeHead(404).end("not found");
        }
        return;
    }
    if (url.startsWith("/styles/")) {
        const name = url.slice("/styles/".length);
        if (/^[a-zA-Z0-9_-]+\.css$/.test(name)) {
            serveStatic(res, join(UI_DIR, "styles", name));
        } else {
            res.writeHead(404).end("not found");
        }
        return;
    }
    if (url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
    }
    if (url === "/summary") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(store.summary()));
        return;
    }
    // Every run ever recorded in the sink (latest-first), with time bounds,
    // agents, cost, and event counts — the dashboard's archive picker.
    if (url === "/runs") {
        ensureRunIndex();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(runIndex.runs()));
        return;
    }
    // Full-sink substring search (case-insensitive, raw lines) — answers
    // "which run touched X" across every run ever recorded. A full scan per
    // query; local disk makes that cheap. Returns the most recent matches.
    if (url === "/search") {
        const q = (query.get("q") || "").toLowerCase();
        const limit = Math.min(500, Number(query.get("limit")) || 200);
        res.writeHead(200, { "content-type": "application/json" });
        if (!q || !existsSync(SINK)) {
            res.end("[]");
            return;
        }
        const matches: ObsEvent[] = [];
        const scanner = new LineScanner((line) => {
            if (!line.toLowerCase().includes(q)) return;
            const ev = parseEventLine(line);
            if (!ev) return;
            matches.push(ev);
            if (matches.length > limit) matches.shift(); // keep the newest
        });
        try {
            const fd = openSync(SINK, "r");
            try {
                const size = statSync(SINK).size;
                const buf = Buffer.alloc(SCAN_CHUNK);
                let pos = 0;
                while (pos < size) {
                    const n = readSync(
                        fd,
                        buf,
                        0,
                        Math.min(SCAN_CHUNK, size - pos),
                        pos,
                    );
                    if (n <= 0) break;
                    scanner.push(buf.subarray(0, n));
                    pos += n;
                }
            } finally {
                closeSync(fd);
            }
        } catch {
            /* partial results are fine */
        }
        res.end(JSON.stringify(matches));
        return;
    }
    // ?run=<id> serves that run's full history from the sink file (beyond the
    // in-memory ring); without it, the recent live buffer as before.
    if (url === "/events") {
        const runId = query.get("run");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(runId ? readRunEvents(runId) : store.recent()));
        return;
    }
    // OTLP/JSON trace export (OpenTelemetry GenAI conventions). ?run=<id> scopes
    // to one run; ?download=1 prompts a file download. Pipe this into any
    // OTel-aware backend, or `curl … > trace.json`.
    if (url === "/otel") {
        const runId = query.get("run") || undefined;
        // For a specific run, prefer the sink-file archive (complete even when
        // the run has scrolled out of the ring); fall back to the live buffer.
        let events = store.recent();
        if (runId) {
            const archived = readRunEvents(runId);
            if (archived.length) events = archived;
        }
        const otlp = eventsToOtlp(events, {
            runId,
            serviceName: "pi-agent-workflow",
        });
        const headers: Record<string, string> = {
            "content-type": "application/json",
        };
        if (query.get("download") === "1") {
            const tag = runId ? runId : "all-runs";
            headers["content-disposition"] =
                `attachment; filename="otel-${tag}.json"`;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify(otlp));
        return;
    }
    if (url === "/stream") {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        res.write(sseComment("connected"));
        // Replay the buffer so a late-joining dashboard sees the whole run.
        for (const ev of store.recent()) res.write(sseFrame(ev));
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
    }
    res.writeHead(404).end("not found");
});

// Heartbeat keeps SSE connections alive through proxies/idle timeouts.
setInterval(() => {
    for (const res of clients) {
        try {
            res.write(sseComment("hb"));
        } catch {
            /* ignore */
        }
    }
}, 15_000).unref();

primeOffset(); // bound the startup replay to the file's tail
readDelta(); // prime from recent events
setInterval(readDelta, 250).unref();

server.listen(opts.port, "127.0.0.1", () => {
    process.stdout.write(
        `\nAgent observability — live\n` +
            `  dashboard  http://127.0.0.1:${opts.port}/\n` +
            `  tailing    ${SINK}\n` +
            `  history    /runs · /events?run=<id> · /otel?run=<id>\n` +
            (OTLP_ENDPOINT ? `  otlp push  ${OTLP_ENDPOINT}\n` : "") +
            `  (run a workflow with PI_OBS=1 to see events; Ctrl-C to stop)\n\n`,
    );
});
