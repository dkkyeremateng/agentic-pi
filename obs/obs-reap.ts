// obs-reap.ts — close orphaned lanes in the event sink.
//
// A lane shows as "stalled" forever when its session emitted `session_start`
// but never `session_end` — the process died without a clean shutdown (SIGKILL,
// terminal closed, reboot, crash). The collector now writes session_end on
// process exit (obs-live.ts), which prevents NEW orphans, but pre-existing ones
// already sit in the append-only sink with no way to close.
//
// This module finds those orphans and synthesizes a `session_end` for each —
// appended, never rewriting history. The synthetic end is stamped at the lane's
// last real activity (not reap time) so run latency isn't inflated by the gap.
//
// Pure + tested; the CLI (`obs-cli reap`) does the file I/O and supplies the
// live-session set so a genuinely-running session is never reaped.
import { OBS_SCHEMA, type ObsEvent } from "./obs-events";

export interface Orphan {
    sessionId: string;
    agent: string;
    runId?: string;
    cwd?: string;
    lastTs: number; // last real activity — where the synthetic end is stamped
    lastSeq: number; // so the synthetic end keeps per-session seq monotonic
    events: number; // how many events this lane has (context for the report)
}

export interface ReapPlan {
    orphans: Orphan[]; // stalest first
    sessions: number; // total distinct sessions scanned
    ended: number; // sessions that already had a clean session_end
    live: number; // orphan candidates skipped because they're still alive
    fresh: number; // orphan candidates skipped as too recent (< staleMs)
}

/**
 * Find sessions that started but never ended, are older than `staleMs`, and are
 * not in the `live` set (pid-alive + fresh heartbeat). Those are safe to close.
 */
export function planReap(
    events: ObsEvent[],
    now: number,
    staleMs: number,
    live: ReadonlySet<string>,
): ReapPlan {
    interface Agg {
        started: boolean;
        ended: boolean;
        lastTs: number;
        lastSeq: number;
        agent: string;
        runId?: string;
        cwd?: string;
        count: number;
    }
    const byId = new Map<string, Agg>();
    for (const ev of events) {
        let g = byId.get(ev.sessionId);
        if (!g) {
            g = { started: false, ended: false, lastTs: 0, lastSeq: -1, agent: ev.agent, count: 0 };
            byId.set(ev.sessionId, g);
        }
        g.count++;
        if (ev.ts > g.lastTs) g.lastTs = ev.ts;
        if (ev.seq > g.lastSeq) g.lastSeq = ev.seq;
        if (ev.agent) g.agent = ev.agent;
        if (ev.cwd) g.cwd = ev.cwd;
        if (ev.runId) g.runId = ev.runId;
        if (ev.type === "session_start") g.started = true;
        else if (ev.type === "session_end") g.ended = true;
    }

    const orphans: Orphan[] = [];
    let ended = 0;
    let liveSkipped = 0;
    let fresh = 0;
    for (const [sessionId, g] of byId) {
        if (g.ended) {
            ended++;
            continue;
        }
        if (!g.started) continue; // no session_start — not a real lane, leave it
        if (live.has(sessionId)) {
            liveSkipped++;
            continue; // genuinely alive — never reap
        }
        if (now - g.lastTs < staleMs) {
            fresh++;
            continue; // too recent — could still be mid-work
        }
        orphans.push({
            sessionId,
            agent: g.agent,
            runId: g.runId,
            cwd: g.cwd,
            lastTs: g.lastTs,
            lastSeq: g.lastSeq,
            events: g.count,
        });
    }
    orphans.sort((a, b) => a.lastTs - b.lastTs); // stalest first
    return { orphans, sessions: byId.size, ended, live: liveSkipped, fresh };
}

/**
 * The synthetic `session_end` that closes an orphan's lane. Stamped at the
 * lane's last real activity so latency reflects actual work; `reapedAt` records
 * when the reaper ran, `staleMs` how long the lane had been silent.
 */
export function reapEvent(o: Orphan, now: number): ObsEvent {
    return {
        v: OBS_SCHEMA,
        seq: o.lastSeq + 1,
        ts: o.lastTs,
        sessionId: o.sessionId,
        agent: o.agent,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(o.runId ? { runId: o.runId } : {}),
        type: "session_end",
        payload: { reason: "reaped", reapedAt: now, staleMs: now - o.lastTs },
    };
}
