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
//   tsx obs/obs-server.ts [projectPath] [--sink <file>] [--port <n>]
//
//   projectPath  defaults to cwd; sink is <projectPath>/.agent/obs/events.jsonl
//   --sink       tail an explicit sink file instead
//   --port       listen port (default PI_OBS_PORT or 7616)

import { createServer } from "http";
import {
    statSync,
    openSync,
    readSync,
    closeSync,
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
    readdirSync,
} from "fs";
import { join, resolve as resolvePath, dirname } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import {
    EventStore,
    sseFrame,
    sseComment,
    filterRuns,
    isEmptyFinishedRun,
    RUN_QUIET_MS,
} from "./obs-server-core";
import {
    parseEventLine,
    makeFactory,
    serializeEvent,
    OBS_SCHEMA,
    type ObsEvent,
} from "./obs-events";
import { eventsToOtlp } from "./obs-otel";
import { LineScanner, RunIndexer, type RunSummary } from "./obs-run-index";
import { buildRunDigest, formatRunDigest, runAutoVerdict } from "./obs-explain";
import {
    llmConfig,
    explainRun,
    judgeRun,
    summarizeText,
    runPlayground,
    loadRepoEnv,
} from "./obs-llm";
import { streamChat } from "./obs-chat";
import { dispatchStream, listAgents, selectAgent } from "./obs-dispatch";
import { listLiveSessions } from "./obs-chat-control";
import { connect as netConnect } from "node:net";
import { buildPromptRegistry } from "./obs-prompts";
import { configuredToken, isAuthorized } from "./obs-auth";

const HERE = dirname(fileURLToPath(import.meta.url));
// pi's extensions load the repo .env into the pi process; the server is a sibling
// process that doesn't, so load it here too (real env wins). Lets PI_OBS_LLM* live
// in .env like every other setting. HERE = <repo>/obs → repo root is ...
loadRepoEnv(join(HERE, "..", ".env"));
const UI_DIR = join(HERE, "obs-ui");

// Shared-secret auth (read after loadRepoEnv so PI_OBS_TOKEN can live in .env).
// Empty => auth disabled: the server stays open, matching the loopback default.
// When set, every data/control route requires the token (Authorization: Bearer,
// or ?token= for EventSource); only the static dashboard shell stays open so the
// browser can bootstrap and present a token. See obs-auth.ts / obs/API.md.
const OBS_TOKEN = configuredToken();
function authorized(req: Req, query: URLSearchParams): boolean {
    return isAuthorized(OBS_TOKEN, req.headers, query);
}
function sendUnauthorized(res: Res): void {
    res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="obs"',
        ...API_CORS,
    });
    res.end(
        JSON.stringify({
            error: "unauthorized",
            detail: "missing or invalid token — send Authorization: Bearer <PI_OBS_TOKEN>, or ?token=<PI_OBS_TOKEN> for SSE",
        }),
    );
}

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
// When tailing the shared global sink, also aggregate every per-project sink
// (sibling <dir>/*/events.jsonl). Auto-on for the global sink; force with
// PI_OBS_AGGREGATE=1, disable with PI_OBS_AGGREGATE=0.
const IS_GLOBAL = !opts.sink && !process.env.PI_OBS_SINK && !opts.project;
const AGGREGATE =
    process.env.PI_OBS_AGGREGATE === "1" ||
    (process.env.PI_OBS_AGGREGATE !== "0" && IS_GLOBAL);

const store = new EventStore();
// SSE clients; the value carries an optional runId filter (/api/stream?run=).
const clients = new Map<import("http").ServerResponse, { run?: string }>();
const STARTED_AT = Date.now();
const SCAN_CHUNK = 1 << 20;
const PRIME_TAIL_BYTES = 2 * 1024 * 1024;

// ── multi-sink tailing + indexing ────────────────────────────────────────────
// Each sink file has its own live-tail cursor and its own RunIndexer (byte
// offsets are per-file). A run's events live entirely in one file, so the merged
// view just unions per-sink run summaries and remembers which file holds each.

interface Sink {
    path: string;
    index: RunIndexer;
    offset: number; // live-tail byte cursor
    leftover: string;
}
const sinks = new Map<string, Sink>();
function getSink(path: string): Sink {
    let s = sinks.get(path);
    if (!s) {
        s = { path, index: new RunIndexer(), offset: 0, leftover: "" };
        sinks.set(path, s);
    }
    return s;
}

// The sink files to read: the primary sink + (when aggregating) every
// events.jsonl one directory deep beside it. Re-scanned each tick so new
// project folders are picked up live.
function discoverSinks(): string[] {
    const out = [SINK];
    if (AGGREGATE) {
        const dir = dirname(SINK);
        try {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                const f = join(dir, e.name, "events.jsonl");
                if (f !== SINK && existsSync(f)) out.push(f);
            }
        } catch {
            /* ignore */
        }
    }
    return out;
}

function ingest(line: string): void {
    const ev = parseEventLine(line);
    if (!ev) return;
    if (store.add(ev)) broadcast(ev); // store dedupes by sessionId#seq across sinks
}

// On startup, bound the replay to each file's tail (the shared sink grows large).
function primeOffset(): void {
    for (const path of discoverSinks()) {
        const s = getSink(path);
        try {
            const size = statSync(path).size;
            if (size > PRIME_TAIL_BYTES) s.offset = size - PRIME_TAIL_BYTES;
        } catch {
            /* ignore */
        }
    }
}

function readDeltaOne(s: Sink): void {
    if (!existsSync(s.path)) return;
    let size: number;
    try {
        size = statSync(s.path).size;
    } catch {
        return;
    }
    if (size < s.offset) {
        s.offset = 0;
        s.leftover = "";
    }
    if (size === s.offset) return;
    const fd = openSync(s.path, "r");
    try {
        const len = size - s.offset;
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, s.offset);
        s.offset += n;
        s.leftover += buf.toString("utf-8", 0, n);
    } finally {
        closeSync(fd);
    }
    const lines = s.leftover.split("\n");
    s.leftover = lines.pop() ?? "";
    for (const line of lines) ingest(line);
}
function readDelta(): void {
    for (const path of discoverSinks()) readDeltaOne(getSink(path));
}

// ── run history index (per-sink, merged by runId) ────────────────────────────
let mergedRuns: RunSummary[] = [];
const runSink = new Map<string, string>(); // runId -> sink path holding its events

function laterVerdict(a: RunSummary["verdict"], b: RunSummary["verdict"]) {
    if (!a) return b;
    if (!b) return a;
    return (a.ts ?? 0) >= (b.ts ?? 0) ? a : b;
}

// Update each sink's index from its file delta, then merge into one run list.
function ensureRunIndex(): void {
    for (const path of discoverSinks()) {
        const s = getSink(path);
        if (!existsSync(path)) continue;
        let size: number;
        try {
            size = statSync(path).size;
        } catch {
            continue;
        }
        if (size < s.index.scannedTo) s.index.reset();
        if (size === s.index.scannedTo) continue;
        const fd = openSync(path, "r");
        try {
            const buf = Buffer.alloc(SCAN_CHUNK);
            let pos = s.index.scannedTo;
            while (pos < size) {
                const n = readSync(
                    fd,
                    buf,
                    0,
                    Math.min(SCAN_CHUNK, size - pos),
                    pos,
                );
                if (n <= 0) break;
                s.index.feed(buf.subarray(0, n));
                pos += n;
            }
        } finally {
            closeSync(fd);
        }
    }
    const byId = new Map<string, RunSummary>();
    runSink.clear();
    for (const s of sinks.values()) {
        for (const r of s.index.runs()) {
            const prev = byId.get(r.runId);
            if (!prev) {
                byId.set(r.runId, r);
                runSink.set(r.runId, s.path);
                continue;
            }
            // same runId in two files: keep the record with more events for the
            // time bounds/totals, but take the most recent verdict from either.
            const main = r.events >= prev.events ? r : prev;
            const verdict = laterVerdict(r.verdict, prev.verdict);
            byId.set(
                r.runId,
                verdict === main.verdict ? main : { ...main, verdict },
            );
            if (r.events >= prev.events) runSink.set(r.runId, s.path);
        }
    }
    mergedRuns = [...byId.values()].sort((a, b) => b.firstTs - a.firstTs);
}

function allRuns(): RunSummary[] {
    ensureRunIndex();
    return mergedRuns;
}

// the sink file that holds a run's events (for reads + verdict appends)
function sinkForRun(runId: string): string {
    return runSink.get(runId) ?? SINK;
}

// One run's events, read from the sink file that holds it (its indexed range).
function readRunEvents(runId: string): ObsEvent[] {
    ensureRunIndex();
    const s = sinks.get(sinkForRun(runId));
    const run = s?.index.get(runId);
    if (!s || !run) return [];
    const events: ObsEvent[] = [];
    const scanner = new LineScanner((line) => {
        const ev = parseEventLine(line);
        if (ev && ev.runId === runId) events.push(ev);
    }, run.startOffset);
    let fd: number;
    try {
        fd = openSync(s.path, "r");
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

// ── auto-verdict backfill ─────────────────────────────────────────────────────
// Resolve runs that ENDED (quiet > RUN_QUIET_MS) but never got a verdict by
// scoring them from their digest (source "auto"; a manual/CLI score overrides
// later). Skips runs already scored, runs a workflow deliberately left "open"
// (needs-review), and empty no-op sessions. Idempotent — once scored a run has a
// verdict and is no longer a candidate; the per-run lastTs guard avoids redoing
// the digest each tick for runs we already inspected.
const AUTO_VERDICT_ENABLED =
    process.env.PI_OBS_AUTO_VERDICT !== "0" &&
    process.env.PI_OBS_AUTO_VERDICT !== "false";
const autoInspected = new Map<string, number>(); // runId -> lastTs we last checked

function backfillVerdicts(now = Date.now()): number {
    if (!AUTO_VERDICT_ENABLED) return 0;
    ensureRunIndex();
    let scored = 0;
    for (const run of allRuns()) {
        // already decided, or a workflow left it open on purpose → leave it
        const v = run.verdict;
        if (v && (v.status !== "open" || v.source === "workflow")) continue;
        if (now - run.lastTs <= RUN_QUIET_MS) continue; // not ended yet
        if (autoInspected.get(run.runId) === run.lastTs) continue; // unchanged since last look
        autoInspected.set(run.runId, run.lastTs);

        const verdict = runAutoVerdict(
            buildRunDigest(readRunEvents(run.runId)),
        );
        if (!verdict) continue; // empty session — nothing to judge

        const f = makeFactory({
            sessionId: `auto-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            agent: "auto",
            cwd: run.cwd,
            runId: run.runId,
        });
        const ev = f.next("verdict", { status: verdict, source: "auto" });
        try {
            appendFileSync(
                sinkForRun(run.runId),
                serializeEvent(ev) + "\n",
                "utf-8",
            );
            scored++;
        } catch {
            /* sink not writable — try again next tick */
            autoInspected.delete(run.runId);
        }
    }
    return scored;
}

// Case-insensitive substring scan over the whole sink's raw lines, newest
// `limit` matches kept. Shared by /search (dashboard) and /api/search.
function searchSink(q: string, limit: number): ObsEvent[] {
    if (!q) return [];
    const matches: ObsEvent[] = [];
    for (const path of discoverSinks()) {
        if (!existsSync(path)) continue;
        const scanner = new LineScanner((line) => {
            if (!line.toLowerCase().includes(q)) return;
            const ev = parseEventLine(line);
            if (!ev) return;
            matches.push(ev);
        });
        try {
            const fd = openSync(path, "r");
            try {
                const size = statSync(path).size;
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
    }
    // newest across all sinks, capped
    matches.sort((a, b) => a.ts - b.ts);
    return matches.slice(-limit);
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
        for (const r of allRuns())
            if (now - r.lastTs > OTLP_QUIET_MS) otlpDone.add(r.runId);
        return;
    }
    for (const r of allRuns()) {
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
    for (const [res, f] of clients) {
        if (f.run && ev.runId !== f.run) continue;
        try {
            res.write(frame);
        } catch {
            /* dropped on next close */
        }
    }
}

// ── public JSON API (/api/*) ─────────────────────────────────────────────────
// A stable, CORS-open surface for external UIs and other integrations; the
// bundled dashboard keeps using the legacy unprefixed routes (same data). The
// server binds to 127.0.0.1, so open CORS only exposes it to local pages and
// apps. Documented in obs/API.md.

const API_CORS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
};

type Res = import("http").ServerResponse;
type Req = import("http").IncomingMessage;

function apiJson(res: Res, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json", ...API_CORS });
    res.end(JSON.stringify(data));
}
function apiError(res: Res, status: number, message: string): void {
    apiJson(res, status, { error: message });
}

// ── Image attachment uploads (chat) ──────────────────
const UPLOAD_EXT_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
};
function uploadsDir(): string {
    return join(homedir(), ".pi", "agent", "obs", "uploads");
}
// A safe upload id is `<hex>.<ext>` — no path separators, known image ext.
function validUploadId(id: string): boolean {
    return /^[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/.test(id);
}
function uploadMime(id: string): string {
    return (
        UPLOAD_EXT_MIME[id.split(".").pop()!.toLowerCase()] ||
        "application/octet-stream"
    );
}
/** Resolve a comma-list of upload ids to existing files (path + mimeType). */
function resolveUploads(
    idsCsv: unknown,
): { id: string; path: string; mimeType: string }[] {
    if (typeof idsCsv !== "string" || !idsCsv) return [];
    const out: { id: string; path: string; mimeType: string }[] = [];
    for (const id of idsCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (!validUploadId(id)) continue;
        const p = join(uploadsDir(), id);
        if (existsSync(p)) out.push({ id, path: p, mimeType: uploadMime(id) });
    }
    return out;
}

// Exact runId, or a unique prefix (friendly for hand-typed ids).
function findRun(id: string): RunSummary | { ambiguous: number } | undefined {
    ensureRunIndex();
    const runs = allRuns();
    const exact = runs.find((r) => r.runId === id);
    if (exact) return exact;
    const pre = runs.filter((r) => r.runId.startsWith(id));
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) return { ambiguous: pre.length };
    return undefined;
}

function handleApi(
    req: Req,
    res: Res,
    path: string,
    query: URLSearchParams,
): void {
    if (req.method === "OPTIONS") {
        // CORS preflight carries no credentials by design — never gate it.
        res.writeHead(204, API_CORS);
        res.end();
        return;
    }
    // Every /api route (data + control) requires the token when one is set.
    if (!authorized(req, query)) {
        sendUnauthorized(res);
        return;
    }
    const seg = path.split("/").filter(Boolean); // ["api", ...]

    // The machine-readable contract (obs/openapi.yaml, served as-is).
    if (path === "/api/openapi.yaml" && req.method === "GET") {
        const file = join(HERE, "openapi.yaml");
        if (!existsSync(file)) {
            apiError(res, 404, "openapi.yaml not found");
            return;
        }
        res.writeHead(200, {
            "content-type": "application/yaml; charset=utf-8",
            ...API_CORS,
        });
        res.end(readFileSync(file));
        return;
    }

    // GET /api — discovery + server meta
    if (seg.length === 1 && req.method === "GET") {
        apiJson(res, 200, {
            name: "pi-agent-obs",
            schema: OBS_SCHEMA,
            sink: SINK,
            ...(AGGREGATE ? { aggregate: true, sinks: discoverSinks() } : {}),
            bufferedEvents: store.size(),
            uptimeMs: Date.now() - STARTED_AT,
            endpoints: [
                "GET  /api",
                "GET  /api/openapi.yaml",
                "GET  /api/summary",
                "GET  /api/events?limit=",
                "GET  /api/runs?project=&since=&limit=&includeEmpty=  (hides finished no-op runs unless includeEmpty=1)",
                "GET  /api/runs/:id",
                "GET  /api/runs/:id/events",
                "GET  /api/runs/:id/digest?format=json|text",
                "GET  /api/runs/:id/explain  (LLM narrative; opt-in PI_OBS_LLM=1)",
                "GET  /api/runs/:id/judge  (LLM-as-judge rubric score; opt-in PI_OBS_LLM=1)",
                "GET  /api/runs/:id/otel",
                "POST /api/runs/:id/verdict  {status, note?, agent?}  (agent scopes it to one agent's run)",
                "GET  /api/search?q=&limit=",
                "GET  /api/prompts  (per-agent boot-config registry, versioned)",
                "POST /api/summarize  {text, kind?}  (LLM; opt-in PI_OBS_LLM=1)",
                "POST /api/notify  {url, payload}  (relay monitor alerts to a webhook)",
                "POST /api/playground  {system, input, model?}  (safe one-shot prompt sandbox; opt-in PI_OBS_LLM=1)",
                "POST /api/chat  {sessionId, text, model?, cwd?, tools?, forkFrom?}  (SSE stream of reply tokens; forkFrom attaches to a run's session; opt-in PI_OBS_LLM=1)",
                "GET  /api/agents  ?cwd=  (known workflow agents; readOnly flag)",
                "POST /api/select  {task, cwd}  (auto-pick the best agent for a task, or \"chat\"; opt-in PI_OBS_LLM=1)",
                "POST /api/dispatch  {agent, text, cwd, model?, sessionId?}  (SSE; run any agent standalone, file tools confined to cwd, no run needed; opt-in PI_OBS_DISPATCH=1)",
                "GET  /api/live-sessions  (agents running right now with a control channel — attachable)",
                "GET  /api/chat-live  ?sessionId=&text=&deliverAs=&approve=  (SSE; steer a LIVE agent and stream its reply)",
                "GET  /api/chat-approve  ?sessionId=&toolCallId=&decision=  (allow/deny a paused tool on a live agent)",
                "GET/PUT /api/chats  (server-side chat persistence; {chats:[...]})",
                "POST /api/chat-upload  {name, mimeType, dataB64}  (image attachment → returns {id}); GET /api/uploads/:id serves it",
                "POST /api/verdicts/backfill  (auto-score ended, still-open runs)",
                "GET  /api/stream  (SSE; ?run= filters)",
            ],
        });
        return;
    }

    const a = seg[1];

    if (a === "summary" && req.method === "GET") {
        apiJson(res, 200, store.summary());
        return;
    }
    // Manually trigger the auto-verdict backfill for ended, still-open runs.
    if (a === "verdicts" && seg[2] === "backfill" && req.method === "POST") {
        if (!AUTO_VERDICT_ENABLED) {
            apiJson(res, 200, {
                enabled: false,
                scored: 0,
                hint: "set PI_OBS_AUTO_VERDICT=1 to enable",
            });
            return;
        }
        apiJson(res, 200, { enabled: true, scored: backfillVerdicts() });
        return;
    }
    if (a === "events" && seg.length === 2 && req.method === "GET") {
        apiJson(
            res,
            200,
            store.recent(Number(query.get("limit")) || undefined),
        );
        return;
    }
    if (a === "search" && req.method === "GET") {
        const q = (query.get("q") || "").toLowerCase();
        if (!q) {
            apiError(res, 400, "missing ?q=");
            return;
        }
        const limit = Math.min(500, Number(query.get("limit")) || 200);
        apiJson(res, 200, searchSink(q, limit));
        return;
    }
    // Prompt/config registry — per-agent boot snapshots (system-prompt hash/size,
    // model, tools, skills) versioned across every run on the sink.
    if (a === "prompts" && req.method === "GET") {
        ensureRunIndex();
        const boots: ObsEvent[] = [];
        for (const r of allRuns()) {
            for (const e of readRunEvents(r.runId)) {
                if (e.type === "boot" || e.type === "session_start")
                    boots.push(e);
            }
        }
        apiJson(res, 200, buildPromptRegistry(boots));
        return;
    }
    // Webhook forwarder for monitor alerts — the dashboard evaluates monitors
    // client-side, then POSTs new alerts here; the server relays them to the
    // user's webhook (server-side fetch avoids browser CORS). Local tool: only
    // http/https targets are allowed.
    if (a === "notify" && req.method === "POST") {
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
            let parsed: { url?: unknown; payload?: unknown };
            try {
                parsed = JSON.parse(body || "{}");
            } catch {
                apiError(res, 400, "invalid JSON body");
                return;
            }
            const url = typeof parsed.url === "string" ? parsed.url : "";
            if (!/^https?:\/\//i.test(url)) {
                apiError(res, 400, "url must be http(s)");
                return;
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10_000);
            fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(parsed.payload ?? {}),
                signal: ctrl.signal,
            })
                .then((r) => apiJson(res, 200, { ok: r.ok, status: r.status }))
                .catch((e) =>
                    apiJson(res, 200, {
                        ok: false,
                        error: String((e as Error)?.message || e).slice(0, 300),
                    }),
                )
                .finally(() => clearTimeout(timer));
        });
        return;
    }
    // Prompt playground — a safe one-shot completion (no tools/session/skills)
    // for iterating on prompt wording. Opt-in like /explain.
    if (a === "playground" && req.method === "POST") {
        const baseCfg = llmConfig();
        if (!baseCfg.enabled) {
            apiJson(res, 200, {
                enabled: false,
                hint: "set PI_OBS_LLM=1 to enable the prompt playground",
            });
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
            let parsed: { system?: unknown; input?: unknown; model?: unknown };
            try {
                parsed = JSON.parse(body || "{}");
            } catch {
                apiError(res, 400, "invalid JSON body");
                return;
            }
            const system =
                typeof parsed.system === "string" ? parsed.system : "";
            const input = typeof parsed.input === "string" ? parsed.input : "";
            if (!input.trim()) {
                apiError(res, 400, "missing input");
                return;
            }
            const model =
                typeof parsed.model === "string" ? parsed.model.trim() : "";
            const cfg = model ? { ...baseCfg, model } : baseCfg;
            runPlayground(system, input, cfg)
                .then((r) => apiJson(res, 200, { enabled: true, ...r }))
                .catch((e) =>
                    apiJson(res, 200, {
                        enabled: true,
                        error: String((e as Error)?.message || e).slice(0, 400),
                    }),
                );
        });
        return;
    }
    // Chat — spawn pi per message, reusing --session-id for continuity, and
    // stream parsed reply tokens back as SSE. Opt-in like the other LLM routes.
    // GET (EventSource, params in query) is the primary path — it proxies cleanly
    // through the vite dev server, which buffers POST streams. POST is also
    // accepted (direct/prod). All outcomes — including "disabled" / bad input —
    // are delivered as SSE frames so the client gets one stream shape.
    if (a === "chat" && (req.method === "GET" || req.method === "POST")) {
        const stream = (p: Record<string, unknown>) => {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
                ...API_CORS,
            });
            // flush a comment immediately so proxies (vite dev server) start
            // streaming now instead of buffering until pi's first byte
            res.write(": connected\n\n");
            const emit = (ev: unknown) =>
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
            const cfg = llmConfig();
            if (!cfg.enabled) {
                emit({
                    type: "error",
                    error: "set PI_OBS_LLM=1 on the server to enable chat",
                });
                res.end();
                return;
            }
            const sessionId =
                typeof p.sessionId === "string" ? p.sessionId : "";
            const text = typeof p.text === "string" ? p.text : "";
            if (!/^[\w.-]{1,64}$/.test(sessionId)) {
                emit({ type: "error", error: "invalid sessionId" });
                res.end();
                return;
            }
            if (!text.trim()) {
                emit({ type: "error", error: "missing text" });
                res.end();
                return;
            }
            const model = typeof p.model === "string" ? p.model.trim() : "";
            const forkFrom =
                typeof p.forkFrom === "string" &&
                /^[\w.-]{1,64}$/.test(p.forkFrom)
                    ? p.forkFrom
                    : undefined;
            // stop: if the browser disconnects, abort kills the spawned pi (no orphan)
            const ac = new AbortController();
            req.on("close", () => ac.abort());
            const imagePaths = resolveUploads(p.imageIds).map((u) => u.path);
            streamChat(
                {
                    sessionId,
                    text,
                    model,
                    cwd: typeof p.cwd === "string" ? p.cwd : undefined,
                    tools: p.tools === "1" || p.tools === true,
                    forkFrom,
                    signal: ac.signal,
                    imagePaths,
                },
                emit,
                model ? { ...cfg, model } : cfg,
            )
                .catch(() => {
                    /* error already emitted as an event */
                })
                .finally(() => res.end());
        };
        if (req.method === "GET") {
            stream(Object.fromEntries(query));
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
            try {
                stream(JSON.parse(body || "{}"));
            } catch {
                apiError(res, 400, "invalid JSON body");
            }
        });
        return;
    }
    // Known workflow agents (project + bundled), each flagged read-only — the
    // read-only ones are what /api/dispatch will run. cwd scopes project agents.
    if (a === "agents" && req.method === "GET") {
        const cwd = query.get("cwd") || process.cwd();
        try {
            apiJson(res, 200, { dispatchEnabled: process.env.PI_OBS_DISPATCH === "1" || process.env.PI_OBS_DISPATCH === "true", agents: listAgents(cwd) });
        } catch (e) {
            apiError(res, 500, `could not load agents: ${String((e as Error)?.message || e)}`);
        }
        return;
    }
    // Auto-select the best agent for a free-text task (the bridge's /do). Returns
    // a chosen agent name or "chat". Uses the LLM (opt-in PI_OBS_LLM=1).
    if (a === "select" && req.method === "POST") {
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", async () => {
            let p: Record<string, unknown>;
            try {
                p = JSON.parse(body || "{}");
            } catch {
                apiError(res, 400, "invalid JSON body");
                return;
            }
            const task = typeof p.task === "string" ? p.task : "";
            const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : process.cwd();
            if (!task.trim()) {
                apiError(res, 400, "missing task");
                return;
            }
            if (!llmConfig().enabled) {
                apiJson(res, 200, { enabled: false, hint: "set PI_OBS_LLM=1 on the server to enable /do (agent selection)" });
                return;
            }
            try {
                const sel = await selectAgent(cwd, task);
                apiJson(res, 200, { enabled: true, ...sel });
            } catch (e) {
                apiJson(res, 200, { enabled: true, error: String((e as Error)?.message || e) });
            }
        });
        return;
    }
    // Dispatch a single READ-ONLY agent standalone (no orchestrator/run needed)
    // and stream its reply as SSE ChatEvents. Opt-in (PI_OBS_DISPATCH=1) because
    // it executes an agent with its tools; read-only is enforced in dispatchStream.
    if (a === "dispatch" && (req.method === "GET" || req.method === "POST")) {
        const run = (p: Record<string, unknown>) => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...API_CORS });
            res.write(": connected\n\n");
            const emit = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
            if (!(process.env.PI_OBS_DISPATCH === "1" || process.env.PI_OBS_DISPATCH === "true")) {
                emit({ type: "error", error: "set PI_OBS_DISPATCH=1 on the server to enable agent dispatch" });
                res.end();
                return;
            }
            const agent = typeof p.agent === "string" ? p.agent.trim() : "";
            const text = typeof p.text === "string" ? p.text : "";
            const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : process.cwd();
            if (!agent) {
                emit({ type: "error", error: "missing agent" });
                res.end();
                return;
            }
            if (!text.trim()) {
                emit({ type: "error", error: "missing text" });
                res.end();
                return;
            }
            const sessionId = typeof p.sessionId === "string" && /^[\w.-]{1,64}$/.test(p.sessionId) ? p.sessionId : undefined;
            const model = typeof p.model === "string" ? p.model.trim() : undefined;
            const ac = new AbortController();
            req.on("close", () => ac.abort());
            dispatchStream({ agent, text, cwd, model, sessionId, signal: ac.signal }, emit)
                .catch(() => {
                    /* error already emitted as an event */
                })
                .finally(() => res.end());
        };
        if (req.method === "GET") {
            run(Object.fromEntries(query));
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
            try {
                run(JSON.parse(body || "{}"));
            } catch {
                apiError(res, 400, "invalid JSON body");
            }
        });
        return;
    }
    // Live sessions: agents currently running with a control channel open, i.e.
    // the only sessions you can steer/chat into. Pruned to pid-alive processes.
    if (a === "live-sessions" && req.method === "GET") {
        const list = listLiveSessions().map((m) => ({
            sessionId: m.sessionId,
            agent: m.agent,
            runId: m.runId,
            cwd: m.cwd,
            model: m.model,
            tools: m.tools,
            startedTs: m.startedTs,
        }));
        apiJson(res, 200, list);
        return;
    }
    // Steer a LIVE agent: forward a prompt to its control socket and relay the
    // agent's reply back as an SSE stream of ChatEvents. Only works while the
    // target session is alive (enforced by the socket's existence).
    if (a === "chat-live" && (req.method === "GET" || req.method === "POST")) {
        const run = (p: Record<string, unknown>) => {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
                ...API_CORS,
            });
            res.write(": connected\n\n");
            const emit = (ev: unknown) =>
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
            let ended = false;
            const finish = () => {
                if (ended) return;
                ended = true;
                try {
                    res.end();
                } catch {}
            };
            const sessionId =
                typeof p.sessionId === "string" ? p.sessionId : "";
            const text = typeof p.text === "string" ? p.text : "";
            const deliverAs = p.deliverAs === "steer" ? "steer" : "followUp";
            const approve = p.approve === "1" || p.approve === true;
            if (!/^[\w.-]{1,64}$/.test(sessionId)) {
                emit({ type: "error", error: "invalid sessionId" });
                finish();
                return;
            }
            if (!text.trim()) {
                emit({ type: "error", error: "missing text" });
                finish();
                return;
            }
            const live = listLiveSessions().find(
                (m) => m.sessionId === sessionId,
            );
            if (!live) {
                emit({
                    type: "error",
                    error: "that session is no longer live — attach to an active session",
                });
                finish();
                return;
            }
            const images = resolveUploads(p.imageIds).map((u) => ({
                type: "image",
                data: readFileSync(u.path).toString("base64"),
                mimeType: u.mimeType,
            }));
            const sock = netConnect(live.sock);
            let buf = "";
            let sawTerminal = false;
            sock.on("connect", () => {
                try {
                    sock.write(
                        JSON.stringify({
                            text,
                            deliverAs,
                            approve,
                            token: live.token,
                            images,
                        }) + "\n",
                    );
                } catch {}
            });
            sock.on("data", (d: Buffer) => {
                buf += d.toString();
                let nl: number;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line.trim()) continue;
                    let ev: { type?: string };
                    try {
                        ev = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    emit(ev);
                    if (ev.type === "done" || ev.type === "error") {
                        sawTerminal = true;
                        try {
                            sock.end();
                        } catch {}
                        finish();
                    }
                }
            });
            sock.on("error", (e: Error) => {
                if (!sawTerminal)
                    emit({
                        type: "error",
                        error: "control channel error: " + e.message,
                    });
                finish();
            });
            sock.on("close", () => {
                if (!sawTerminal)
                    emit({
                        type: "error",
                        error: "agent closed the channel before replying",
                    });
                finish();
            });
            // stop: when the browser disconnects, tell the agent to abort its
            // current turn (pi's ctx.abort), then drop the socket.
            req.on("close", () => {
                try {
                    if (!sawTerminal)
                        sock.write(
                            JSON.stringify({
                                cmd: "abort",
                                token: live.token,
                            }) + "\n",
                        );
                } catch {}
                setTimeout(() => {
                    try {
                        sock.destroy();
                    } catch {}
                }, 50);
                finish();
            });
        };
        if (req.method === "GET") {
            run(Object.fromEntries(query));
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
            try {
                run(JSON.parse(body || "{}"));
            } catch {
                apiError(res, 400, "invalid JSON body");
            }
        });
        return;
    }
    // Relay a human approve/deny decision for a paused tool to the live agent's
    // control socket (the agent's tool_call handler is awaiting it).
    if (
        a === "chat-approve" &&
        (req.method === "GET" || req.method === "POST")
    ) {
        const decide = (p: Record<string, unknown>) => {
            const sessionId =
                typeof p.sessionId === "string" ? p.sessionId : "";
            const toolCallId =
                typeof p.toolCallId === "string" ? p.toolCallId : "";
            const decision = p.decision === "allow" ? "allow" : "deny";
            if (!/^[\w.-]{1,64}$/.test(sessionId) || !toolCallId) {
                apiError(res, 400, "sessionId and toolCallId required");
                return;
            }
            const live = listLiveSessions().find(
                (m) => m.sessionId === sessionId,
            );
            if (!live) {
                apiError(res, 409, "session no longer live");
                return;
            }
            const sock = netConnect(live.sock);
            const done = (ok: boolean) => {
                try {
                    sock.destroy();
                } catch {}
                if (!res.writableEnded) apiJson(res, ok ? 200 : 502, { ok });
            };
            sock.on("connect", () => {
                try {
                    sock.write(
                        JSON.stringify({
                            cmd: "approve",
                            toolCallId,
                            decision,
                            token: live.token,
                        }) + "\n",
                    );
                } catch {}
                setTimeout(() => done(true), 30); // give the frame time to flush
            });
            sock.on("error", () => done(false));
        };
        if (req.method === "GET") {
            decide(Object.fromEntries(query));
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 64_000) req.destroy();
        });
        req.on("end", () => {
            try {
                decide(JSON.parse(body || "{}"));
            } catch {
                apiError(res, 400, "invalid JSON body");
            }
        });
        return;
    }
    // Chat persistence: store conversations server-side so they survive a cache
    // clear and are shared across browsers (last-write-wins; local-dev scope).
    if (
        a === "chats" &&
        (req.method === "GET" || req.method === "PUT" || req.method === "POST")
    ) {
        const file = join(homedir(), ".pi", "agent", "obs", "chats.json");
        if (req.method === "GET") {
            let chats: unknown = [];
            try {
                if (existsSync(file))
                    chats = JSON.parse(readFileSync(file, "utf-8"));
            } catch {
                chats = [];
            }
            apiJson(res, 200, { chats: Array.isArray(chats) ? chats : [] });
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 8_000_000) req.destroy(); // 8MB cap
        });
        req.on("end", () => {
            try {
                const parsed = JSON.parse(body || "{}");
                const chats = Array.isArray(parsed) ? parsed : parsed.chats;
                if (!Array.isArray(chats)) {
                    apiError(res, 400, "expected { chats: [...] }");
                    return;
                }
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, JSON.stringify(chats), "utf-8");
                apiJson(res, 200, { ok: true, count: chats.length });
            } catch {
                apiError(res, 400, "invalid JSON body");
            }
        });
        return;
    }
    // Upload an image attachment (base64) → temp file under the obs uploads dir.
    if (a === "chat-upload" && req.method === "POST") {
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 12_000_000) req.destroy(); // ~9MB image cap
        });
        req.on("end", () => {
            let p: { name?: string; mimeType?: string; dataB64?: string };
            try {
                p = JSON.parse(body || "{}");
            } catch {
                apiError(res, 400, "invalid JSON body");
                return;
            }
            const mime = typeof p.mimeType === "string" ? p.mimeType : "";
            const ext = Object.keys(UPLOAD_EXT_MIME).find(
                (e) => UPLOAD_EXT_MIME[e] === mime,
            );
            if (!ext || typeof p.dataB64 !== "string" || !p.dataB64) {
                apiError(res, 400, "expected an image {mimeType, dataB64}");
                return;
            }
            try {
                mkdirSync(uploadsDir(), { recursive: true, mode: 0o700 });
                const id = `${randomBytes(12).toString("hex")}.${ext}`;
                writeFileSync(
                    join(uploadsDir(), id),
                    Buffer.from(p.dataB64, "base64"),
                );
                apiJson(res, 200, {
                    id,
                    mimeType: mime,
                    name: typeof p.name === "string" ? p.name : id,
                });
            } catch (e) {
                apiError(
                    res,
                    500,
                    "could not store upload: " +
                        String((e as Error)?.message || e),
                );
            }
        });
        return;
    }
    // Serve an uploaded image (for chat thumbnails).
    if (a === "uploads" && seg[2] && req.method === "GET") {
        const id = seg[2];
        if (!validUploadId(id)) {
            apiError(res, 400, "bad upload id");
            return;
        }
        const p = join(uploadsDir(), id);
        if (!existsSync(p)) {
            apiError(res, 404, "not found");
            return;
        }
        res.writeHead(200, {
            "content-type": uploadMime(id),
            "cache-control": "max-age=3600",
            ...API_CORS,
        });
        res.end(readFileSync(p));
        return;
    }
    // Optional one-sentence LLM summary of an arbitrary chunk (a tool's input
    // args or output result), for the trace I/O panel's raw/AI toggle. Opt-in,
    // runs the pi CLI like /explain; disabled is a 200 with {enabled:false}.
    if (a === "summarize" && req.method === "POST") {
        const cfg = llmConfig();
        if (!cfg.enabled) {
            apiJson(res, 200, {
                enabled: false,
                hint: "set PI_OBS_LLM=1 to enable AI summaries",
            });
            return;
        }
        let body = "";
        req.on("data", (d) => {
            body += d;
            if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
            let parsed: { text?: unknown; kind?: unknown };
            try {
                parsed = JSON.parse(body || "{}");
            } catch {
                apiError(res, 400, "invalid JSON body");
                return;
            }
            const text = typeof parsed.text === "string" ? parsed.text : "";
            const kind = (
                typeof parsed.kind === "string" ? parsed.kind : "content"
            ).slice(0, 40);
            if (!text.trim()) {
                apiError(res, 400, "missing text");
                return;
            }
            summarizeText(text, kind, cfg)
                .then((r) => apiJson(res, 200, { enabled: true, ...r }))
                .catch((e) =>
                    apiJson(res, 200, {
                        enabled: true,
                        error: String((e as Error)?.message || e).slice(0, 400),
                    }),
                );
        });
        return;
    }
    if (a === "stream" && req.method === "GET") {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...API_CORS,
        });
        res.write(sseComment("connected"));
        const run = query.get("run") || undefined;
        // Replay the buffer (scoped if filtered), then go live.
        for (const ev of store.recent())
            if (!run || ev.runId === run) res.write(sseFrame(ev));
        clients.set(res, { run });
        req.on("close", () => clients.delete(res));
        return;
    }
    if (a === "runs") {
        if (seg.length === 2 && req.method === "GET") {
            ensureRunIndex();
            const sinceRaw = query.get("since");
            // since: epoch ms or any Date.parse-able string (ISO recommended)
            let since: number | undefined;
            if (sinceRaw) {
                since = /^\d+$/.test(sinceRaw)
                    ? Number(sinceRaw)
                    : Date.parse(sinceRaw);
                if (Number.isNaN(since)) {
                    apiError(res, 400, "unparseable ?since=");
                    return;
                }
            }
            // Drop finished no-op runs (no cost/tokens/tools, gone quiet) before
            // applying project/since/limit. `?includeEmpty=1` returns them too.
            const includeEmpty = query.get("includeEmpty") === "1";
            const all = includeEmpty
                ? allRuns()
                : allRuns().filter((r) => !isEmptyFinishedRun(r));
            apiJson(
                res,
                200,
                filterRuns(all, {
                    project: query.get("project") || undefined,
                    since,
                    limit: Number(query.get("limit")) || undefined,
                }),
            );
            return;
        }
        const id = decodeURIComponent(seg[2] || "");
        const found = findRun(id);
        if (!found) {
            apiError(res, 404, `no run matching "${id}"`);
            return;
        }
        if ("ambiguous" in found) {
            apiError(
                res,
                404,
                `ambiguous run prefix "${id}" (${found.ambiguous} matches)`,
            );
            return;
        }
        const run = found;
        const sub = seg[3];

        if (!sub && req.method === "GET") {
            apiJson(res, 200, run);
            return;
        }
        if (sub === "events" && req.method === "GET") {
            apiJson(res, 200, readRunEvents(run.runId));
            return;
        }
        // The anomaly digest behind `obs-cli explain` — the highest-leverage
        // endpoint for integrations ("what happened in that run", as JSON).
        if (sub === "digest" && req.method === "GET") {
            const digest = buildRunDigest(readRunEvents(run.runId));
            if (query.get("format") === "text") {
                res.writeHead(200, {
                    "content-type": "text/plain; charset=utf-8",
                    ...API_CORS,
                });
                res.end(formatRunDigest(digest).join("\n") + "\n");
            } else {
                apiJson(res, 200, digest);
            }
            return;
        }
        if (sub === "otel" && req.method === "GET") {
            apiJson(
                res,
                200,
                eventsToOtlp(readRunEvents(run.runId), {
                    runId: run.runId,
                    serviceName: "pi-agent-workflow",
                }),
            );
            return;
        }
        // Optional LLM narrative — opt-in (PI_OBS_LLM=1). Runs the `pi` CLI with
        // the configured model (pi owns provider auth), so no key lives here.
        // Disabled is a 200 with {enabled:false} so the UI can show a hint
        // rather than treating it as an error.
        if (sub === "explain" && req.method === "GET") {
            const cfg = llmConfig();
            if (!cfg.enabled) {
                apiJson(res, 200, {
                    enabled: false,
                    hint: "set PI_OBS_LLM=1 to enable AI summaries (uses the pi CLI + PI_OBS_LLM_MODEL / PI_WORKFLOW_MODEL)",
                });
                return;
            }
            const evs = readRunEvents(run.runId);
            explainRun(run.runId, buildRunDigest(evs), evs, cfg)
                .then((r) => apiJson(res, 200, { enabled: true, ...r }))
                // Best-effort enrichment: a model/usage/spawn failure is surfaced
                // as a 200 with `error` so the UI can show the actionable message
                // (e.g. a provider usage-limit hint) instead of a generic failure.
                .catch((e) =>
                    apiJson(res, 200, {
                        enabled: true,
                        error: String((e as Error)?.message || e).slice(0, 400),
                    }),
                );
            return;
        }
        // LLM-as-judge: score the run on a rubric (goal/efficiency/errors).
        // Opt-in like /explain; disabled is a 200 with {enabled:false}.
        if (sub === "judge" && req.method === "GET") {
            const cfg = llmConfig();
            if (!cfg.enabled) {
                apiJson(res, 200, {
                    enabled: false,
                    hint: "set PI_OBS_LLM=1 to enable the AI judge (uses the pi CLI + PI_OBS_LLM_MODEL / PI_WORKFLOW_MODEL)",
                });
                return;
            }
            const evs = readRunEvents(run.runId);
            judgeRun(run.runId, buildRunDigest(evs), evs, cfg)
                .then((r) => apiJson(res, 200, { enabled: true, ...r }))
                .catch((e) =>
                    apiJson(res, 200, {
                        enabled: true,
                        error: String((e as Error)?.message || e).slice(0, 400),
                    }),
                );
            return;
        }
        // Score a run. Appends a verdict line to the sink — the tailer picks
        // it up, so open dashboards update live; the last verdict wins.
        if (sub === "verdict" && req.method === "POST") {
            let body = "";
            req.on("data", (d) => {
                body += d;
                if (body.length > 64_000) req.destroy();
            });
            req.on("end", () => {
                let parsed: any;
                try {
                    parsed = JSON.parse(body || "{}");
                } catch {
                    apiError(res, 400, "invalid JSON body");
                    return;
                }
                const status = String(parsed.status || "");
                if (!["pass", "fail", "open"].includes(status)) {
                    apiError(
                        res,
                        400,
                        'status must be "pass", "fail", or "open"',
                    );
                    return;
                }
                const f = makeFactory({
                    sessionId: `score-${Date.now().toString(36)}-${Math.random()
                        .toString(36)
                        .slice(2, 7)}`,
                    agent: "user",
                    cwd: run.cwd,
                    runId: run.runId,
                });
                // Optional `agent` scopes the verdict to a single agent's run
                // within this run, instead of the whole run.
                const agent = parsed.agent
                    ? String(parsed.agent).slice(0, 80)
                    : undefined;
                const ev = f.next("verdict", {
                    status,
                    ...(parsed.note
                        ? { note: String(parsed.note).slice(0, 500) }
                        : {}),
                    ...(agent ? { agent } : {}),
                    source: "api",
                });
                try {
                    appendFileSync(
                        sinkForRun(run.runId),
                        serializeEvent(ev) + "\n",
                        "utf-8",
                    );
                } catch (e: any) {
                    apiError(
                        res,
                        500,
                        `could not append verdict: ${e?.message}`,
                    );
                    return;
                }
                apiJson(res, 200, {
                    ok: true,
                    runId: run.runId,
                    ...(agent ? { agent } : {}),
                    verdict: ev.payload,
                    previous: agent ? null : (run.verdict ?? null),
                });
            });
            return;
        }
    }
    apiError(res, 404, "unknown API route");
}

// ── http ──────────────────────────────────────────────────────────────────────

const CONTENT: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
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
    // Public API for external UIs/integrations; legacy routes below serve the
    // bundled dashboard.
    if (url === "/api" || url.startsWith("/api/")) {
        handleApi(req, res, url, query);
        return;
    }
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
    if (url === "/favicon.svg") {
        serveStatic(res, join(UI_DIR, "favicon.svg"));
        return;
    }
    if (url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
    }
    // The static shell above (index.html, /scripts, /styles, favicon) stays open
    // so the browser can load and present a token; everything below serves run
    // data, so it requires the token when one is configured.
    if (!authorized(req, query)) {
        sendUnauthorized(res);
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
        // Hide finished no-op runs (no cost/tokens/tools, gone quiet) — matches
        // /api/runs and the React dashboard. `?includeEmpty=1` returns them too.
        const includeEmpty = query.get("includeEmpty") === "1";
        const runs = includeEmpty
            ? allRuns()
            : allRuns().filter((r) => !isEmptyFinishedRun(r));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(runs));
        return;
    }
    // Full-sink substring search (case-insensitive, raw lines) — answers
    // "which run touched X" across every run ever recorded. A full scan per
    // query; local disk makes that cheap. Returns the most recent matches.
    if (url === "/search") {
        const q = (query.get("q") || "").toLowerCase();
        const limit = Math.min(500, Number(query.get("limit")) || 200);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(searchSink(q, limit)));
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
        clients.set(res, {});
        req.on("close", () => clients.delete(res));
        return;
    }
    res.writeHead(404).end("not found");
});

// Heartbeat keeps SSE connections alive through proxies/idle timeouts.
setInterval(() => {
    for (const res of clients.keys()) {
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

// Auto-score ended-but-unverdicted runs shortly after startup, then periodically.
if (AUTO_VERDICT_ENABLED) {
    setTimeout(backfillVerdicts, 3_000).unref();
    setInterval(backfillVerdicts, 60_000).unref();
}

// Bind 127.0.0.1 by default (the safe local default). PI_OBS_HOST overrides it
// — set PI_OBS_HOST=0.0.0.0 to listen on all interfaces, which a container needs
// since a loopback bind inside a container is unreachable through a published
// port. Pair a non-loopback bind with PI_OBS_TOKEN (and a firewall/proxy).
const HOST = (process.env.PI_OBS_HOST || "127.0.0.1").trim();
const shownHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
server.listen(opts.port, HOST, () => {
    process.stdout.write(
        `\nAgent observability — live\n` +
            `  dashboard  http://${shownHost}:${opts.port}/\n` +
            `  api        http://${shownHost}:${opts.port}/api (see obs/API.md)\n` +
            `  bind       ${HOST}:${opts.port}\n` +
            `  tailing    ${SINK}${AGGREGATE ? ` (+ ${discoverSinks().length - 1} project sink(s))` : ""}\n` +
            `  history    /runs · /events?run=<id> · /otel?run=<id>\n` +
            (OTLP_ENDPOINT ? `  otlp push  ${OTLP_ENDPOINT}\n` : "") +
            `  auth       ${OBS_TOKEN ? "on — token required (PI_OBS_TOKEN)" : "off — no PI_OBS_TOKEN set (open)"}\n` +
            (HOST !== "127.0.0.1" && !OBS_TOKEN
                ? `  WARNING    bound beyond loopback with no PI_OBS_TOKEN — the API is open to the network\n`
                : "") +
            `  (run a workflow with PI_OBS=1 to see events; Ctrl-C to stop)\n\n`,
    );
});
