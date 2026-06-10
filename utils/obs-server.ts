// Phase 2 (live observability) — the tailing server.
//
// Tails the sink file that pi processes append ObsEvent lines to, keeps a
// bounded in-memory store, and serves a vanilla dashboard that streams events
// over SSE. Node stdlib only — no deps, no SQLite, no Bun.
//
// Usage:
//   tsx utils/obs-server.ts [projectPath] [--sink <file>] [--port <n>]
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
    const project = resolvePath(o.project ?? process.cwd());
    return join(project, ".agent", "obs", "events.jsonl");
}

const opts = parseArgs(process.argv.slice(2));
const SINK = resolveSink(opts);
const store = new EventStore();
const clients = new Set<import("http").ServerResponse>();

// ── file tailing (poll-based; robust for appends across platforms) ───────────

let offset = 0;
let leftover = "";

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
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
        serveStatic(res, join(UI_DIR, "index.html"));
        return;
    }
    if (url === "/app.js") {
        serveStatic(res, join(UI_DIR, "app.js"));
        return;
    }
    if (url === "/summary") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(store.summary()));
        return;
    }
    if (url === "/events") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(store.recent()));
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

readDelta(); // prime from any existing events
setInterval(readDelta, 250).unref();

server.listen(opts.port, "127.0.0.1", () => {
    process.stdout.write(
        `\nAgent observability — live\n` +
            `  dashboard  http://127.0.0.1:${opts.port}/\n` +
            `  tailing    ${SINK}\n` +
            `  (run a workflow with PI_OBS=1 to see events; Ctrl-C to stop)\n\n`,
    );
});
