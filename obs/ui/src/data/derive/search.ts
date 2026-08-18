// Client-side query parsing + filtering for the Search view. The prefix grammar
// (tool:/status:/agent:/model:/run:) is parsed and applied here; free text is
// matched against the event as a whole.
//
// The server substring-matches ONE phrase against the event's full JSON (keys
// included). A multi-word free-text query means "all of these words", so we hand
// the server the single most-selective term (see serverQuery) and AND the rest
// client-side against the same full-JSON haystack — otherwise "jq error" would
// go to the server as one phrase and match nothing, since the words are never
// adjacent.
import type { ObsEvent } from "../types";

export interface ParsedQuery {
  text: string; // free-text terms, joined (display)
  terms: string[]; // the individual free-text terms, lowercased (AND-matched)
  tool?: string;
  status?: string; // "error" | "ok" | event type
  agent?: string;
  model?: string;
  run?: string;
}

const PREFIXES = ["tool", "status", "agent", "model", "run"] as const;

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { text: "", terms: [] };
  const free: string[] = [];
  for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\w+):(.*)$/.exec(tok);
    if (m && (PREFIXES as readonly string[]).includes(m[1])) {
      // a known prefix with an empty value (a just-clicked "tool:" hint chip)
      // is a no-op filter — neither a constraint nor free text for the server.
      if (m[2]) (out as unknown as Record<string, string>)[m[1]] = m[2].toLowerCase();
    } else {
      free.push(tok);
    }
  }
  out.text = free.join(" ");
  out.terms = free.map((t) => t.toLowerCase());
  return out;
}

// The single free-text term to hand the server (it substring-matches ONE phrase
// only). Any one required term yields a superset of the AND result, so the
// choice affects only how many candidates come back under the result cap — the
// longest term is the cheapest proxy for "most selective". "" for a prefix-only
// query, which fetches recent events and narrows them client-side.
export function serverQuery(p: ParsedQuery): string {
  if (!p.terms.length) return "";
  return p.terms.reduce((a, b) => (b.length > a.length ? b : a));
}

// The searchable text for one event — its full JSON, matching what the server
// substring-matches against (values AND keys), so a client-side AND check stays
// consistent with the server's own term match.
function haystack(ev: ObsEvent): string {
  return JSON.stringify(ev).toLowerCase();
}

function str(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

function isError(ev: ObsEvent): boolean {
  return ev.type === "error" || (ev.type === "tool_end" && (ev.payload?.isError === true || ev.payload?.ok === false));
}

export function filterHits(events: ObsEvent[], p: ParsedQuery): ObsEvent[] {
  return events.filter((ev) => {
    if (p.agent && !str(ev.agent).includes(p.agent)) return false;
    if (p.run && !str(ev.runId).includes(p.run)) return false;
    if (p.model && !str(ev.payload?.model).includes(p.model)) return false;
    if (p.tool) {
      const t = str(ev.payload?.toolName) || str(ev.payload?.tool) || str(ev.payload?.name);
      if (!t.includes(p.tool)) return false;
    }
    if (p.status) {
      if (p.status === "error") {
        if (!isError(ev)) return false;
      } else if (!str(ev.type).includes(p.status)) return false;
    }
    // free text: require EVERY term (the server guaranteed only the one from
    // serverQuery). Skipped when there are no terms — a prefix-only query.
    if (p.terms.length) {
      const hay = haystack(ev);
      for (const t of p.terms) if (!hay.includes(t)) return false;
    }
    return true;
  });
}

export interface Facet {
  key: string;
  count: number;
}
export function facetBy(events: ObsEvent[], pick: (ev: ObsEvent) => string): Facet[] {
  const m = new Map<string, number>();
  for (const ev of events) {
    const k = pick(ev);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}
