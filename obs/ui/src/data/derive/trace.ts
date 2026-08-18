// §7.2 trace model — folds a run's event stream into a flattened span tree.
// One AGENT span per session; nested sub-agents by `parent` (agent name);
// LLM spans from turn_start/turn_end pairs and TOOL spans from
// tool_start/tool_end pairs, interleaved under their agent by time.
import type { ObsEvent } from "../types";

export type SpanKind = "agent" | "llm" | "tool";
export type SpanStatus = "running" | "error" | "done";

export interface Span {
  id: string;
  kind: SpanKind;
  label: string;
  agent: string;
  // The session this span belongs to. `agent` is a ROLE and a run can dispatch
  // several instances of it in parallel, so the session is what identifies one
  // of them — the id is prefixed with it, but callers shouldn't have to parse.
  sessionId: string;
  depth: number;
  startTs: number;
  endTs: number;
  status: SpanStatus;
  costUsd?: number; // agent spans: total spend for the session
  model?: string; // agent spans: the model it ran on
}

export interface TraceModel {
  runStart: number;
  runEnd: number;
  spans: Span[]; // flattened, render order, with depth
}

interface AgentNode {
  sessionId: string;
  agent: string;
  parent: string | null;
  firstTs: number;
  lastTs: number;
  ended: boolean;
  errors: number;
  costUsd: number; // summed from this session's turn_end events
  model?: string; // from session_start / turns
  children: ChildSpan[]; // llm/tool spans owned by this session
  kids: AgentNode[]; // dispatched sub-agents
}

interface ChildSpan {
  id: string;
  kind: "llm" | "tool";
  label: string;
  startTs: number;
  endTs: number;
  error: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toolName(p: Record<string, unknown>): string {
  return str(p.tool) ?? str(p.name) ?? str(p.toolName) ?? "tool";
}

// Pairing key for a tool span. `toolCallId` is the correlation id when the
// server sends one; without it we fall back to the tool NAME so two different
// tools running concurrently still pair. BOTH halves must build the key the
// same way — a mismatched default (e.g. ev.seq on the start side only) makes
// id-less starts unpairable, collapsing every tool span to zero duration. The
// sessionId prefix also stops two sessions sharing a toolCallId from crossing.
function toolKey(sessionId: string, p: Record<string, unknown>): string {
  return `${sessionId}#tool#${str(p.toolCallId) ?? `@${toolName(p)}`}`;
}

export function buildTrace(events: ObsEvent[], runId: string, now = Date.now()): TraceModel {
  const evs = events
    .filter((e) => e.runId === runId && e.type !== "verdict")
    .sort((a, b) => a.ts - b.ts);

  const nodes = new Map<string, AgentNode>();
  // open spans keyed by their correlation id
  const openTurns = new Map<string, { key: string; idx: unknown; model?: string; ts: number }>();
  const openTools = new Map<string, { key: string; ts: number; label: string }>();

  for (const ev of evs) {
    let n = nodes.get(ev.sessionId);
    if (!n) {
      n = {
        sessionId: ev.sessionId,
        agent: ev.agent,
        parent: null,
        firstTs: ev.ts,
        lastTs: ev.ts,
        ended: false,
        errors: 0,
        costUsd: 0,
        children: [],
        kids: [],
      };
      nodes.set(ev.sessionId, n);
    }
    n.firstTs = Math.min(n.firstTs, ev.ts);
    n.lastTs = Math.max(n.lastTs, ev.ts);
    if (ev.parent && !n.parent) n.parent = ev.parent;
    const p = ev.payload as Record<string, unknown>;

    switch (ev.type) {
      case "session_start":
        if (!n.model) n.model = str(p.model);
        break;
      case "session_end":
        n.ended = true;
        break;
      case "error":
        n.errors++;
        break;
      case "turn_start": {
        // same "" default as turn_end below — a mismatched default (e.g. ev.seq)
        // would make id-less starts unpairable by key
        const key = `${ev.sessionId}#turn#${str(p.turnId) ?? p.turnIndex ?? ""}`;
        openTurns.set(key, { key, idx: p.turnIndex, model: str(p.model), ts: ev.ts });
        break;
      }
      case "turn_end": {
        const key = `${ev.sessionId}#turn#${str(p.turnId) ?? p.turnIndex ?? ""}`;
        // fuzzy fallback stays within this session: matching on the bare
        // sessionId prefix would let "s1" steal "s12"'s open turns
        const open = openTurns.get(key) ?? [...openTurns.values()].find((t) => t.key.startsWith(`${ev.sessionId}#turn#`));
        const idx = open?.idx ?? p.turnIndex;
        const model = open?.model ?? str(p.model) ?? n.agent;
        if (!n.model) n.model = open?.model ?? str(p.model);
        if (typeof p.costUsd === "number") n.costUsd += p.costUsd;
        n.children.push({
          id: `${ev.sessionId}#llm#${ev.seq}`,
          kind: "llm",
          label: `${model} · turn ${idx ?? "?"}`,
          startTs: open?.ts ?? ev.ts,
          endTs: ev.ts,
          error: false,
        });
        if (open) openTurns.delete(open.key);
        break;
      }
      case "tool_start": {
        const key = toolKey(ev.sessionId, p);
        openTools.set(key, { key, ts: ev.ts, label: toolName(p) });
        break;
      }
      case "tool_end": {
        const key = toolKey(ev.sessionId, p);
        // fuzzy fallback stays within this session (never steal another
        // session's open tool); the most recently started one is the likeliest
        // match for an end frame that arrived without a usable key.
        let open = openTools.get(key);
        if (!open) {
          const prefix = `${ev.sessionId}#tool#`;
          for (const [k, v] of [...openTools].reverse()) {
            if (k.startsWith(prefix)) {
              open = v;
              break;
            }
          }
        }
        const label = open?.label ?? toolName(p);
        const error = p.isError === true || p.ok === false;
        if (error) n.errors++;
        n.children.push({
          id: `${ev.sessionId}#tool#${ev.seq}`,
          kind: "tool",
          label,
          startTs: open?.ts ?? ev.ts,
          endTs: ev.ts,
          error,
        });
        if (open) openTools.delete(open.key);
        break;
      }
    }
  }

  // parent linkage: agent name → earliest node
  const byAgent = new Map<string, AgentNode>();
  for (const n of [...nodes.values()].sort((a, b) => a.firstTs - b.firstTs)) {
    if (!byAgent.has(n.agent)) byAgent.set(n.agent, n);
  }
  const roots: AgentNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent ? byAgent.get(n.parent) : undefined;
    if (parent && parent !== n) parent.kids.push(n);
    else roots.push(n);
  }

  const allTs = [...nodes.values()];
  const runStart = allTs.length ? Math.min(...allTs.map((n) => n.firstTs)) : now;
  const runEnd = Math.max(runStart + 1, ...allTs.map((n) => n.lastTs));

  function status(n: AgentNode): SpanStatus {
    if (n.errors > 0) return "error";
    // Still running only if nothing in the run happened after it (it's the
    // trailing activity) AND it's recent. Sub-agents often never emit
    // session_end, so once the run moved past one (n.lastTs < runEnd) it's done —
    // don't leave a finished sub-agent stuck on "running".
    if (!n.ended && n.lastTs >= runEnd && now - n.lastTs < 60_000) return "running";
    return "done";
  }

  const spans: Span[] = [];
  const walk = (n: AgentNode, depth: number) => {
    spans.push({
      id: n.sessionId,
      kind: "agent",
      label: n.agent,
      agent: n.agent,
      sessionId: n.sessionId,
      depth,
      startTs: n.firstTs,
      endTs: n.lastTs,
      status: status(n),
      costUsd: n.costUsd,
      model: n.model,
    });
    // interleave own child spans + sub-agent subtrees by start time
    type Item = { ts: number; emit: () => void };
    const items: Item[] = [];
    for (const c of n.children) {
      items.push({
        ts: c.startTs,
        emit: () =>
          spans.push({
            id: c.id,
            kind: c.kind,
            label: c.label,
            agent: n.agent,
            sessionId: n.sessionId,
            depth: depth + 1,
            startTs: c.startTs,
            endTs: c.endTs,
            status: c.error ? "error" : "done",
          }),
      });
    }
    for (const k of n.kids) items.push({ ts: k.firstTs, emit: () => walk(k, depth + 1) });
    items.sort((a, b) => a.ts - b.ts);
    for (const it of items) it.emit();
  };
  for (const r of roots.sort((a, b) => a.firstTs - b.firstTs)) walk(r, 0);

  return { runStart, runEnd, spans };
}

/** left/width as fractions [0..1] of the run window. */
export function spanBar(span: Span, m: TraceModel): { left: number; width: number } {
  const span_ = Math.max(1, m.runEnd - m.runStart);
  const left = (span.startTs - m.runStart) / span_;
  const width = Math.max(0.004, (span.endTs - span.startTs) / span_);
  return { left: Math.max(0, Math.min(1, left)), width: Math.min(1, width) };
}
