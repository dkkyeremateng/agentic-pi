// Pure agent-scoping logic for a run's Trace / Events / Timeline / Raw / Stats
// tabs. Kept apart from the <AgentFilter> component so it stays testable
// without pulling a React/CSS import chain into the test runner.
//
// `agent` is a ROLE, not an identity: a run routinely dispatches several
// instances of the same role in parallel (four `phase-implementer`s working
// different phases). Each instance is its own SESSION, so scoping offers both
// levels — the whole role, or one instance of it.
import type { ObsEvent } from "../data/types";

/** One dispatched instance of a role. */
export interface AgentInstance {
  agent: string;
  sessionId: string;
  count: number;
  firstTs: number;
}

/** A pick offered by the filter: a whole role, or one instance of it. */
export interface ScopeOption {
  value: string; // encoded key for the picker / store
  agent: string;
  sessionId: string; // "" = every instance of the role
  label: string;
  count: number;
}

// Joins agent + session into one dropdown value. NUL because it can't appear
// in an agent name or a session id, so the split stays unambiguous whatever a
// run calls its roles — a space separator would mis-split "phase implementer".
const SEP = "\u0000";

/** Encode/decode a pick. The store keeps agent and session separately, so this
 *  is only the wire format for the dropdown. */
export function encodeScope(agent: string, sessionId: string): string {
  return sessionId ? agent + SEP + sessionId : agent;
}
export function decodeScope(value: string): { agent: string; sessionId: string } {
  const i = value.indexOf(SEP);
  return i < 0
    ? { agent: value, sessionId: "" }
    : { agent: value.slice(0, i), sessionId: value.slice(i + SEP.length) };
}

/** Every (role, session) pair present in the events, oldest instance first. */
export function agentInstances(events: readonly ObsEvent[]): AgentInstance[] {
  const m = new Map<string, AgentInstance>();
  for (const e of events) {
    if (!e.agent) continue;
    const k = encodeScope(e.agent, e.sessionId);
    const cur = m.get(k);
    if (cur) {
      cur.count++;
      if (e.ts < cur.firstTs) cur.firstTs = e.ts;
    } else {
      m.set(k, { agent: e.agent, sessionId: e.sessionId, count: 1, firstTs: e.ts });
    }
  }
  return [...m.values()].sort((a, b) => a.firstTs - b.firstTs);
}

/** Build the picker's options: roles busiest-first, and — only for a role that
 *  actually ran more than once — its instances beneath it, numbered in dispatch
 *  order. A single-instance role stays one line; numbering it "#1" would just
 *  be noise. */
export function scopeOptions(instances: readonly AgentInstance[]): ScopeOption[] {
  const roles = new Map<string, AgentInstance[]>();
  for (const i of instances) {
    const list = roles.get(i.agent);
    if (list) list.push(i);
    else roles.set(i.agent, [i]);
  }
  const rows = [...roles.entries()].map(([agent, list]) => ({
    agent,
    list,
    total: list.reduce((n, i) => n + i.count, 0),
  }));
  rows.sort((a, b) => b.total - a.total || (a.agent < b.agent ? -1 : 1));

  const out: ScopeOption[] = [];
  for (const r of rows) {
    const many = r.list.length > 1;
    out.push({
      value: encodeScope(r.agent, ""),
      agent: r.agent,
      sessionId: "",
      label: many ? `${r.agent} · all ${r.list.length}` : r.agent,
      count: r.total,
    });
    if (!many) continue;
    r.list.forEach((i, n) => {
      out.push({
        value: encodeScope(i.agent, i.sessionId),
        agent: i.agent,
        sessionId: i.sessionId,
        // the tail of the session id is what distinguishes two instances in
        // the raw stream, so carry it — the ordinal alone can't be looked up
        label: `${i.agent} #${n + 1} · ${shortSession(i.sessionId)}`,
        count: i.count,
      });
    });
  }
  return out;
}

/** Last segment of a session id — enough to tell two instances apart. */
export function shortSession(sessionId: string): string {
  const parts = sessionId.split("-");
  return parts[parts.length - 1] || sessionId;
}

/** Resolve a stored pick against what this tab can actually offer. Falls back
 *  outward rather than to nothing: an unknown session degrades to its role, and
 *  an unknown role to "all". Tabs whose data has no session granularity (Stats
 *  reads the digest, which aggregates per role) pass role-only options and
 *  get the role-level scope back. */
export function resolveScope(
  stored: { agent: string; sessionId: string },
  options: readonly ScopeOption[],
): ScopeOption | null {
  if (!stored.agent) return null;
  if (stored.sessionId) {
    const exact = options.find((o) => o.agent === stored.agent && o.sessionId === stored.sessionId);
    if (exact) return exact;
  }
  return options.find((o) => o.agent === stored.agent && !o.sessionId) ?? null;
}

/** Keep only the rows in scope (null = all). Matches on session when the pick
 *  names one, else on the role — so "all 4" and "#2" both work off one call. */
export function inScope<T extends { agent: string; sessionId?: string }>(
  rows: T[],
  scope: ScopeOption | null,
): T[] {
  if (!scope) return rows;
  if (scope.sessionId) return rows.filter((r) => r.sessionId === scope.sessionId);
  return rows.filter((r) => r.agent === scope.agent);
}
