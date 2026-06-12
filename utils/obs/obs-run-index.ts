// Phase 2.5 (run history) — the sink-file run index.
//
// The shared sink grows without bound across runs, but the live server keeps
// only a bounded in-memory ring (and primes from the file's tail) — older runs
// silently vanish from the dashboard. This module turns the JSONL file itself
// into the archive: a byte-accurate line scanner plus a per-run index (time
// bounds, agents, cost, and the byte range covering the run's lines) so the
// server can list every run ever recorded (/runs) and seek straight to one
// run's slice of the file (/events?run=). Pure — no I/O; obs-server feeds it
// sequential buffers.

import { parseEventLine } from "./obs-events";

// Newline-delimited scanner over sequentially-fed Buffers. Reports each line
// with its absolute byte range [start, end) where `end` is just past the
// newline. Splitting happens on raw bytes (not decoded strings), so UTF-8
// sequences straddling a chunk boundary never mangle and offsets stay exact.
// A trailing partial line is held until its newline arrives.
export class LineScanner {
    private leftover: Buffer = Buffer.alloc(0);
    private base: number; // file offset of leftover[0]

    constructor(
        private onLine: (line: string, start: number, end: number) => void,
        base = 0,
    ) {
        this.base = base;
    }

    // Total bytes consumed so far — the next file offset to read from.
    get offset(): number {
        return this.base + this.leftover.length;
    }

    push(chunk: Buffer): void {
        const buf = this.leftover.length
            ? Buffer.concat([this.leftover, chunk])
            : chunk;
        let start = 0;
        for (;;) {
            const nl = buf.indexOf(0x0a, start);
            if (nl < 0) break;
            this.onLine(
                buf.toString("utf-8", start, nl),
                this.base + start,
                this.base + nl + 1,
            );
            start = nl + 1;
        }
        // Copy the tail — `chunk` is often a reused read buffer.
        this.leftover = Buffer.from(buf.subarray(start));
        this.base += start;
    }

    reset(base = 0): void {
        this.leftover = Buffer.alloc(0);
        this.base = base;
    }
}

export interface RunVerdict {
    status: string; // "pass" | "fail" | "open"
    outcome?: string; // the precise workflow status ("shipped", "error", …)
    note?: string;
    source?: string; // "workflow" | "cli"
    ts: number;
}

export interface RunSummary {
    runId: string;
    firstTs: number;
    lastTs: number;
    events: number;
    agents: string[];
    cwd?: string; // first seen — runs are per-project in practice
    name?: string; // the run's display name (root session name), if it was named
    costUsd: number;
    errors: number; // error events + tool errors
    verdict?: RunVerdict; // last verdict wins (re-scoring overrides)
    // Byte range in the sink covering all of this run's lines. Runs interleave
    // in a shared sink, so the range may contain other runs' lines too — readers
    // filter by runId after seeking.
    startOffset: number;
    endOffset: number;
}

interface RunRec {
    runId: string;
    firstTs: number;
    lastTs: number;
    events: number;
    agents: Set<string>;
    cwd?: string;
    name?: string;
    costUsd: number;
    errors: number;
    verdict?: RunVerdict;
    startOffset: number;
    endOffset: number;
}

// Incremental per-run index over the sink. Feed it the file's bytes in order
// (full scan once, then just the tail deltas); `reset()` after truncation or
// rotation and re-feed from the top. Legacy v1 lines (no runId) are skipped —
// they carry no trace linkage to group by.
export class RunIndexer {
    private byRun = new Map<string, RunRec>();
    private scanner = new LineScanner((line, start, end) =>
        this.line(line, start, end),
    );

    // Next file offset to feed from (everything before it is indexed).
    get scannedTo(): number {
        return this.scanner.offset;
    }

    feed(chunk: Buffer): void {
        this.scanner.push(chunk);
    }

    reset(): void {
        this.byRun.clear();
        this.scanner.reset();
    }

    private line(line: string, start: number, end: number): void {
        const ev = parseEventLine(line);
        if (!ev || !ev.runId) return;
        let r = this.byRun.get(ev.runId);
        if (!r) {
            r = {
                runId: ev.runId,
                firstTs: ev.ts,
                lastTs: ev.ts,
                events: 0,
                agents: new Set(),
                costUsd: 0,
                errors: 0,
                startOffset: start,
                endOffset: end,
            };
            this.byRun.set(ev.runId, r);
        }
        r.events++;
        r.endOffset = end; // lines arrive in file order — the last one wins
        const p = ev.payload as any;
        // Verdicts are run-level annotations, possibly appended LONG after the
        // run (obs-cli score) by a synthetic "user" session — they must not join
        // the agents list or stretch the run's time bounds.
        if (ev.type === "verdict") {
            if (p?.status)
                r.verdict = {
                    status: String(p.status),
                    outcome: p.outcome ? String(p.outcome) : undefined,
                    note: p.note ? String(p.note) : undefined,
                    source: p.source ? String(p.source) : undefined,
                    ts: ev.ts,
                };
            return;
        }
        if (ev.ts < r.firstTs) r.firstTs = ev.ts;
        if (ev.ts > r.lastTs) r.lastTs = ev.ts;
        r.agents.add(ev.agent);
        if (!r.cwd && ev.cwd) r.cwd = ev.cwd;
        if (ev.name) r.name = ev.name; // root-only; last named value wins
        if (ev.type === "turn_end") r.costUsd += Number(p?.costUsd ?? 0);
        if (ev.type === "error" || (ev.type === "tool_end" && p?.isError))
            r.errors++;
    }

    get(runId: string): RunSummary | undefined {
        const r = this.byRun.get(runId);
        return r ? toSummary(r) : undefined;
    }

    // All known runs, latest-first.
    runs(): RunSummary[] {
        return [...this.byRun.values()]
            .map(toSummary)
            .sort((a, b) => b.firstTs - a.firstTs);
    }
}

function toSummary(r: RunRec): RunSummary {
    return {
        runId: r.runId,
        firstTs: r.firstTs,
        lastTs: r.lastTs,
        events: r.events,
        agents: [...r.agents],
        cwd: r.cwd,
        name: r.name,
        costUsd: r.costUsd,
        errors: r.errors,
        verdict: r.verdict,
        startOffset: r.startOffset,
        endOffset: r.endOffset,
    };
}
