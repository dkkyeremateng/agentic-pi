import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../data/client";
import { useObs } from "../data/store";
import { parseQuery, filterHits, facetBy, serverQuery } from "../data/derive/search";
import { eventMeta } from "../runs/eventMeta";
import { agentColor, projectOf } from "../lib/format";
import { Icon } from "../lib/Icon";
import type { ObsEvent } from "../data/types";
import "./search.css";

const PREFIX_HINTS = ["tool:", "status:", "agent:", "model:", "run:"];

function isError(ev: ObsEvent): boolean {
  return ev.type === "error" || (ev.type === "tool_end" && (ev.payload?.isError === true || ev.payload?.ok === false));
}

// Highlight EVERY occurrence of EACH whitespace-separated term — a two-word
// query like "npm test" should light up both words wherever they appear, not
// only an exact contiguous "npm test" and only its first hit.
function Highlight({ text, term }: { text: string; term: string }) {
  const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const hay = text.toLowerCase();
  // collect match ranges, then merge overlaps so nested terms don't double-wrap
  const hits: [number, number][] = [];
  for (const t of terms) {
    for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + t.length)) hits.push([i, i + t.length]);
  }
  if (!hits.length) return <>{text}</>;
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else merged.push([h[0], h[1]]);
  }
  const out: React.ReactNode[] = [];
  let at = 0;
  merged.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export function SearchView() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const parsed = useMemo(() => parseQuery(q), [q]);
  const selectRun = useObs((s) => s.selectRun);
  const setSegment = useObs((s) => s.setSegment);
  const setRunTab = useObs((s) => s.setRunTab);
  const setFocusTs = useObs((s) => s.setFocusTs);
  const setSelectEventTs = useObs((s) => s.setSelectEventTs);

  // open the run this event belongs to and land on it in the Events tab — the
  // focusTs bridge scroll-flashes it, and selectEventTs opens its detail drawer.
  const openHit = (ev: ObsEvent) => {
    if (!ev.runId) return;
    selectRun(ev.runId);
    setFocusTs(ev.ts);
    setSelectEventTs(ev.ts);
    setRunTab("events");
    setSegment("runs");
  };

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(id);
  }, [q]);

  // gate + key the fetch on the DEBOUNCED input: deriving them from the live
  // input would fire an empty-index scan on the first keystroke, before the
  // debounced text catches up.
  // a query is "real" if there's free text OR a prefix filter (tool:, status:…);
  // prefix-only queries fetch with empty text and filter the candidates client-side.
  // The server matches ONE phrase, so we hand it the single most-selective term
  // (serverQuery) and AND any remaining terms client-side in filterHits — a
  // multi-word query like "jq error" would otherwise match nothing server-side.
  const dbParsed = useMemo(() => parseQuery(debounced), [debounced]);
  const dbServerTerm = useMemo(() => serverQuery(dbParsed), [dbParsed]);
  const hasQuery = debounced.trim().length > 0;
  const searchQ = useQuery({
    queryKey: ["search", dbServerTerm],
    queryFn: ({ signal }) => api.search(dbServerTerm, 400, signal),
    // don't scan the whole index on an empty box (mount / cleared input)
    enabled: hasQuery,
  });

  // prefix filters re-apply live (no debounce): they only narrow already-fetched data
  const hits = useMemo(() => filterHits(searchQ.data ?? [], parsed), [searchQ.data, parsed]);
  // count "error" with the same isError() predicate the status:error filter
  // uses — bucketing by ev.type alone would disagree with what clicking the
  // facet actually returns (error-shaped tool_ends).
  const typeFacets = useMemo(() => {
    const f = facetBy(hits, (e) => e.type).filter((x) => x.key !== "error");
    const errors = hits.reduce((n, e) => n + (isError(e) ? 1 : 0), 0);
    if (errors) f.push({ key: "error", count: errors });
    return f.sort((a, b) => b.count - a.count);
  }, [hits]);
  const agentFacets = useMemo(() => facetBy(hits, (e) => e.agent), [hits]);
  const runCount = useMemo(() => new Set(hits.map((h) => h.runId)).size, [hits]);

  const addFilter = (s: string) => setQ((cur) => (cur ? `${cur.trim()} ${s}` : s));

  return (
    <div className="swrap">
      <div className="sbarwrap">
        <div className="sbar">
          <Icon name="search" size={17} style={{ color: "var(--t3)" }} />
          <input
            className="q"
            value={q}
            placeholder="search events… try tool:bash status:error"
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <span className="rc">
            {!hasQuery ? "" : searchQ.isLoading ? "…" : `${hits.length} matches · ${runCount} runs`}
          </span>
        </div>
        <div className="pfx">
          {PREFIX_HINTS.map((p) => (
            <button
              key={p}
              className={`pchip ${(parsed as unknown as Record<string, unknown>)[p.slice(0, -1)] ? "on" : ""}`}
              onClick={() => addFilter(p)}
            >
              <code>{p}</code>
            </button>
          ))}
        </div>
      </div>

      <div className="sgrid">
        <div className="facets">
          <div className="fgroup">
            <h4>Event type</h4>
            {typeFacets.slice(0, 8).map((f) => (
              <button key={f.key} className="fct" onClick={() => addFilter(`status:${f.key}`)}>
                <span className="fl">{f.key}</span>
                <span className="fn">{f.count}</span>
              </button>
            ))}
            {!typeFacets.length && <div className="fnull">—</div>}
          </div>
          <div className="fgroup">
            <h4>Agent</h4>
            {agentFacets.slice(0, 8).map((f) => (
              <button key={f.key} className="fct" onClick={() => addFilter(`agent:${f.key}`)}>
                <span className="dotc" style={{ background: `var(--a${agentColor(f.key)})` }} />
                <span className="fl">{f.key}</span>
                <span className="fn">{f.count}</span>
              </button>
            ))}
            {!agentFacets.length && <div className="fnull">—</div>}
          </div>
        </div>

        <div className="reslist">
          <div className="reshd">
            <span className="t">Results</span>
            <span className="sortby">newest first</span>
          </div>
          <div className="resrows">
            {!hasQuery && <div className="tab-empty small">Type to search across all runs.</div>}
            {hasQuery && hits.length === 0 && !searchQ.isLoading && <div className="tab-empty small">No matches.</div>}
            {[...hits]
              .sort((a, b) => b.ts - a.ts)
              .slice(0, 200)
              .map((ev) => {
                const m = eventMeta(ev);
                const err = isError(ev);
                return (
                  <button
                    type="button"
                    className="res"
                    key={`${ev.sessionId}#${ev.seq}`}
                    onClick={() => openHit(ev)}
                    disabled={!ev.runId}
                    title={ev.runId ? "Open this event in its run" : undefined}
                  >
                    <span className={`rdot a${agentColor(ev.agent)}`} />
                    <span className="rmeta">
                      <div className="rrun">{projectOf(ev.cwd)}</div>
                      <div className="ragent">
                        <span className={`tk ${err ? "err" : "disp"}`}>{err ? "ERR" : ev.type.replace("_", " ")}</span>
                        {ev.agent}
                      </div>
                    </span>
                    <span className="snip">
                      <Highlight text={`${m.badge} ${m.text}`} term={parsed.text} />
                    </span>
                    <span className="rright">{new Date(ev.ts).toLocaleTimeString()}</span>
                  </button>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
