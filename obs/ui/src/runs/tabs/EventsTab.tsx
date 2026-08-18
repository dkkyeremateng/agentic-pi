import { useEffect, useMemo, useRef, useState } from "react";
import { useRunEvents } from "../../data/queries";
import { useObs } from "../../data/store";
import { groupCycles, cycleLabel } from "../../data/derive/cycles";
import { eventMeta } from "../eventMeta";
import { highlightJson } from "./rawHighlight";
import { agentColor } from "../../lib/format";
import type { ObsEvent } from "../../data/types";
import { TabSkeleton } from "../../lib/Skeleton";
import { TailChip, useTail } from "../../lib/Tail";
import { AgentFilter, inScope, useAgentScope, useEventScopes } from "../AgentFilter";
import "./tabs.css";

type Filter = "all" | "tools" | "llm" | "errors" | "says";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "llm", label: "LLM" },
  { id: "errors", label: "Errors" },
  { id: "says", label: "Says" },
];

function keep(ev: ObsEvent, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "tools") return ev.type === "tool_start" || ev.type === "tool_end";
  if (f === "llm") return ev.type === "turn_start" || ev.type === "turn_end";
  if (f === "errors")
    return ev.type === "error" || (ev.type === "tool_end" && (ev.payload?.isError === true || ev.payload?.ok === false));
  if (f === "says") return ev.type === "message";
  return true;
}

const evKey = (ev: ObsEvent) => `${ev.sessionId}#${ev.seq}`;

// render cap — huge runs would otherwise mount tens of thousands of row
// buttons. "Show all" lifts it; a cross-page jump past the cap lifts it too.
const ROW_CAP = 500;

export function EventsTab({ runId }: { runId: string }) {
  const evQ = useRunEvents(runId);
  const [filter, setFilter] = useState<Filter>("all");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const all = useMemo(() => evQ.data ?? [], [evQ.data]);
  // agent scope first — grouping the narrowed set keeps cycle headers honest
  // (a turn with nothing left in it disappears rather than showing empty)
  const scopes = useEventScopes(all);
  const scope = useAgentScope(scopes);
  const scoped = useMemo(() => inScope(all, scope), [all, scope]);
  const cycles = useMemo(() => groupCycles(scoped), [scoped]);
  const total = scoped.length;

  const setFocusTs = useObs((s) => s.setFocusTs);
  const selectEventTs = useObs((s) => s.selectEventTs);
  const setSelectEventTs = useObs((s) => s.setSelectEventTs);
  const setRunAgentScope = useObs((s) => s.setRunAgentScope);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // Cross-page selection intent (Timeline segment click, Search hit) — a
  // one-shot we consume immediately, parking the target time in a ref until
  // the events have loaded. ONLY this path scrolls + flashes; a plain row
  // click below just selects (its setFocusTs write only feeds the Timeline
  // playhead bridge — focusTs is never a scroll trigger here).
  const pendingTsRef = useRef<number | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  // Tail the feed: it rides the live stream (useLiveEvents pushes straight
  // into this query's cache), so rows append while you watch. A pending
  // cross-page jump owns the scroll, so the tail stands down for it.
  const tail = useTail(total, {
    resetKey: runId,
    layoutKey: `${filter}|${showAll}|${scope?.value ?? ""}`, // each changes the rendered height
    skip: () => pendingTsRef.current != null,
  });

  useEffect(() => setShowAll(false), [runId]); // fresh run → fresh cap

  // the drawer follows the scope: narrowing away the event it was showing
  // closes it, rather than leaving a detail pane for a row you can't see
  const selected = useMemo(
    () => (selKey ? scoped.find((e) => evKey(e) === selKey) ?? null : null),
    [selKey, scoped],
  );

  useEffect(() => {
    if (selectEventTs == null) return;
    pendingTsRef.current = selectEventTs;
    // A cross-page jump names one specific event, which may belong to an agent
    // the current scope hides — landing on a row that isn't rendered would
    // strand the intent (and with it the tail). Showing the target wins.
    setRunAgentScope("");
    setSelectEventTs(null); // consume — don't refire on re-render / poll
  }, [selectEventTs, setSelectEventTs, setRunAgentScope]);

  // resolve a parked intent once events (and their rows) exist: select the
  // nearest event, open the drawer, scroll to it, and flash it.
  useEffect(() => {
    const ts = pendingTsRef.current;
    const evs = scoped;
    if (ts == null || !evs?.length) return;
    let near = evs[0];
    let nearIdx = 0;
    for (let i = 0; i < evs.length; i++) {
      if (Math.abs(evs[i].ts - ts) < Math.abs(near.ts - ts)) {
        near = evs[i];
        nearIdx = i;
      }
    }
    const k = evKey(near);
    // Decide "is the target inside the render cap?" from the DATA, not from
    // whether its row happens to be mounted right now. The cap keeps the
    // NEWEST rows, so an older target only renders once the cap is lifted —
    // and asking the ref map is timing-dependent: while a run is still
    // loading the list is short enough that every row exists, so the check
    // passes, and the row is then evicted as the rest of the events arrive.
    // Distance from the live edge is exact enough: the cap counts FILTERED
    // rows, so anything within ROW_CAP raw events of the end is always in the
    // window, and lifting the cap when it isn't only renders more.
    if (evs.length - 1 - nearIdx >= ROW_CAP && !showAll) {
      setShowAll(true); // target is older than the cap — reveal, retry next pass
      return;
    }
    pendingTsRef.current = null;
    setSelKey(k);
    setFlashKey(k);
    requestAnimationFrame(() => {
      rowRefs.current.get(k)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashKey(null), 1400);
  }, [selectEventTs, scoped, showAll]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // close the drawer on Escape
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelKey(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (evQ.isLoading) return <TabSkeleton label="Loading events…" />;
  if (!all.length) return <div className="tab-empty">No events recorded for this run.</div>;

  const turnCount = cycles.filter((c) => c.turn != null).length;

  // group → filter → cap: the cap is applied across the flattened row count so
  // group headers still wrap their (possibly truncated) rows.
  // It keeps the NEWEST rows (walk from the end): this is a tail, so the live
  // edge must stay rendered — capping from the front would freeze the feed at
  // the run's first 500 rows and hide every event that arrives after.
  const groups = cycles
    .map((c) => ({ c, rows: c.events.filter((e) => keep(e, filter)) }))
    .filter((g) => g.rows.length > 0);
  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  let budget = showAll ? Number.POSITIVE_INFINITY : ROW_CAP;
  const capped: typeof groups = [];
  for (let i = groups.length - 1; i >= 0 && budget > 0; i--) {
    const g = groups[i];
    capped.unshift(budget >= g.rows.length ? g : { c: g.c, rows: g.rows.slice(g.rows.length - budget) });
    budget -= g.rows.length;
  }
  const hidden = Math.max(0, totalRows - (showAll ? totalRows : ROW_CAP));

  return (
    <div className="evp">
      <div className="evbar">
        {FILTERS.map((f) => (
          <button key={f.id} className={`fc ${filter === f.id ? "on" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
        <AgentFilter options={scopes} />
        <span className="cnt">
          {scope ? `${total.toLocaleString()} of ${all.length.toLocaleString()}` : total.toLocaleString()} events ·{" "}
          {turnCount} turns
        </span>
        <TailChip tail={tail} noun="event" />
      </div>
      <div className="evlist" ref={tail.ref} onScroll={tail.onScroll}>
        {hidden > 0 && (
          <button className="showall" onClick={() => setShowAll(true)}>
            Show {hidden.toLocaleString()} older row{hidden === 1 ? "" : "s"} ({totalRows.toLocaleString()} total)
          </button>
        )}
        {capped.map(({ c, rows }) => (
          <div className={`evgrp ${c.index % 2 ? "alt" : ""}`} key={c.index}>
            <div className="evgh">
              <span>
                {cycleLabel(c)} · {c.agent}
              </span>
              <span className="ln" />
              <span className="meta">{new Date(c.startTs).toLocaleTimeString()}</span>
            </div>
            {rows.map((ev) => {
              const m = eventMeta(ev);
              const k = evKey(ev);
              return (
                <button
                  type="button"
                  className={`ev ${selKey === k ? "sel" : ""} ${flashKey === k ? "flash" : ""}`}
                  key={k}
                  ref={(el) => {
                    if (el) rowRefs.current.set(k, el);
                    else rowRefs.current.delete(k);
                  }}
                  onClick={() => {
                    setSelKey(k);
                    setFocusTs(ev.ts);
                  }}
                  aria-label={`${ev.type} event details`}
                >
                  <span className="ts">{new Date(ev.ts).toLocaleTimeString()}</span>
                  <span className={`ad a${agentColor(ev.agent)}`} />
                  <span className="ag">{ev.agent}</span>
                  <span className="bd">
                    <span className={`emo ${m.badgeClass}`} aria-hidden="true">{m.emoji}</span>
                    <span className={`badge ${m.badgeClass}`}>{m.badge}</span>
                    <span className="d">{m.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selected && <EventDetail ev={selected} onClose={() => setSelKey(null)} />}
    </div>
  );
}

function scalarRows(p: Record<string, unknown>): { k: string; v: string }[] {
  return Object.entries(p)
    .filter(([, v]) => v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .map(([k, v]) => ({ k, v: String(v) }));
}

function EventDetail({ ev, onClose }: { ev: ObsEvent; onClose: () => void }) {
  const m = eventMeta(ev);
  const payload = ev.payload ?? {};
  const scalars = scalarRows(payload);
  const hasNested = Object.keys(payload).length > scalars.length;

  const meta: { k: string; v: string }[] = [
    { k: "time", v: new Date(ev.ts).toLocaleString() },
    { k: "type", v: ev.type },
    { k: "agent", v: ev.agent },
    { k: "seq", v: String(ev.seq) },
  ];
  if (ev.name) meta.push({ k: "name", v: ev.name });
  if (ev.runId) meta.push({ k: "run", v: ev.runId });
  if (ev.parent) meta.push({ k: "parent", v: ev.parent });
  meta.push({ k: "session", v: ev.sessionId });

  return (
    <>
      <div className="evdbk" onClick={onClose} />
      <aside className="evdrawer" role="dialog" aria-label="Event details">
        <div className="evdh">
          <span className={`ad a${agentColor(ev.agent)}`} />
          <span className={`emo ${m.badgeClass}`} aria-hidden="true">{m.emoji}</span>
          <span className={`badge ${m.badgeClass}`}>{m.badge}</span>
          <span className="evdtype">{ev.type}</span>
          <button className="evdx" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="evdbody">
          {m.text && <p className="evdesc">{m.text}</p>}

          <div className="evdsec">Event</div>
          <div className="metatbl">
            {meta.map((r) => (
              <div className="metarow" key={r.k}>
                <span className="mk">{r.k}</span>
                <span className="mv">{r.v}</span>
              </div>
            ))}
          </div>

          {scalars.length > 0 && (
            <>
              <div className="evdsec">Payload</div>
              <div className="metatbl">
                {scalars.map((r) => (
                  <div className="metarow" key={r.k}>
                    <span className="mk">{r.k}</span>
                    <span className="mv">{r.v}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {hasNested && (
            <>
              <div className="evdsec">Raw payload</div>
              <div className="io">
                <pre className="jraw" dangerouslySetInnerHTML={{ __html: highlightJson(payload) }} />
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
