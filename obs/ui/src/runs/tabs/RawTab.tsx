import { useEffect, useMemo, useState } from "react";
import { useRunEvents } from "../../data/queries";
import { highlightJson, markTerm } from "./rawHighlight";
import { TabSkeleton } from "../../lib/Skeleton";
import { TailChip, useTail } from "../../lib/Tail";
import { AgentFilter, inScope, useAgentScope, useEventScopes } from "../AgentFilter";
import "./tabs.css";
// render cap — huge runs would otherwise mount tens of thousands of <pre>s.
// "Show all" lifts it (copy always covers the full filtered set).
const ROW_CAP = 500;

export function RawTab({ runId }: { runId: string }) {
  const evQ = useRunEvents(runId);
  const all = useMemo(() => evQ.data ?? [], [evQ.data]);
  const scopes = useEventScopes(all);
  const scope = useAgentScope(scopes);
  // scope before highlighting — no point pretty-printing rows we won't show
  const events = useMemo(() => inScope(all, scope), [all, scope]);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [runId, scope]); // fresh run / scope → fresh cap

  // pretty-print + syntax-highlight once per event set; keep a lowercased
  // haystack alongside each for fast substring search.
  const rows = useMemo(
    () =>
      events.map((e) => ({
        key: `${e.sessionId}#${e.seq}`,
        html: highlightJson(e),
        hay: JSON.stringify(e).toLowerCase(),
        raw: JSON.stringify(e),
      })),
    [events],
  );

  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? rows.filter((r) => r.hay.includes(needle)) : rows),
    [rows, needle],
  );
  const visible = showAll ? shown : shown.slice(-ROW_CAP);
  const hidden = shown.length - visible.length;

  if (evQ.isLoading) return <TabSkeleton label="Loading raw events…" />;
  if (!all.length) return <div className="tab-empty">No events.</div>;

  // the copy payload is built on click, not per keystroke/render
  const copyAll = () => navigator.clipboard?.writeText(shown.map((r) => r.raw).join("\n"));
  return (
    <div className="rawp">
      <div className="rawhd">
        <span className="t">Raw events</span>
        <span className="seln">
          {runId} ·{" "}
          {needle || scope
            ? `${shown.length.toLocaleString()} of ${all.length.toLocaleString()} events`
            : `${all.length.toLocaleString()} events`}{" "}
          · JSONL
        </span>
        <AgentFilter options={scopes} width={150} />
        <input
          className="rawsearch"
          type="search"
          placeholder="search raw…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search raw events"
        />
        <button className="cp" onClick={copyAll}>
          copy
        </button>
      </div>
      <div className="rawbody">
        {shown.length === 0 ? (
          <div className="tab-empty small">No events match “{q.trim()}”.</div>
        ) : (
          <>
            {visible.map((r) => (
              <pre
                className="rawev"
                key={r.key}
                dangerouslySetInnerHTML={{ __html: needle ? markTerm(r.html, q) : r.html }}
              />
            ))}
            {hidden > 0 && (
              <button className="showall" onClick={() => setShowAll(true)}>
                Show all {shown.length.toLocaleString()} events ({hidden.toLocaleString()} more)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
