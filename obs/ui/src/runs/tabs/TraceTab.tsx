import { useMemo, useRef, useState } from "react";
import { useDigest, useRunEvents, useSummarize, useVerdict } from "../../data/queries";
import { buildTrace, spanBar, type Span } from "../../data/derive/trace";
import { spanDetail } from "./spanDetail";
import { highlightJson } from "./rawHighlight";
import { formatSpanDur } from "../../lib/format";
import { Icon } from "../../lib/Icon";
import { onTablistKey } from "../../lib/tablist";
import { TabSkeleton } from "../../lib/Skeleton";
import { TailChip, useTail } from "../../lib/Tail";
import { AgentFilter, inScope, useAgentScope, useEventScopes } from "../AgentFilter";
import "./tabs.css";

type DetailTab = "io" | "meta" | "raw";
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "io", label: "I/O" },
  { id: "meta", label: "Metadata" },
  { id: "raw", label: "Raw" },
];

// An I/O block (Input or Output) with a raw ⇄ AI-summary toggle. Default is
// raw — the AI pill is the indicator and only fires the LLM call on click.
function IoBlock({ title, role, text, kind }: { title: string; role: string; text: string; kind: string }) {
  const [mode, setMode] = useState<"raw" | "ai">("raw");
  const sum = useSummarize(text, kind, mode === "ai");
  return (
    <div className="io">
      <div className="ioh">
        {title} <span className="role">· {role}</span>
        <span className="io-toggle" role="group" aria-label={`${title} view`}>
          <button className={`io-pill ${mode === "raw" ? "on" : ""}`} aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>
            Raw
          </button>
          <button className={`io-pill ai ${mode === "ai" ? "on" : ""}`} aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>
            <Icon name="spark" size={11} /> AI
          </button>
        </span>
      </div>
      {mode === "raw" ? (
        <pre>{text}</pre>
      ) : (
        <div className="io-ai">
          {sum.isLoading && <p className="ai-loading">Summarizing…</p>}
          {sum.data?.enabled === false && <p className="ai-off">{sum.data.hint}</p>}
          {sum.data?.error && <p className="ai-err">{sum.data.error}</p>}
          {sum.data?.summary && <p className="ai-narr">{sum.data.summary}</p>}
          {sum.isError && <p className="ai-err">{String((sum.error as Error)?.message || sum.error)}</p>}
        </div>
      )}
    </div>
  );
}

function SpanRow({
  span,
  bar,
  selected,
  onSelect,
}: {
  span: Span;
  bar: { left: number; width: number };
  selected: boolean;
  onSelect: () => void;
}) {
  const kindClass = span.kind;
  const kindEmoji = span.kind === "agent" ? "🤖" : span.kind === "llm" ? "🧠" : "🔧";
  return (
    <button className={`sp ${selected ? "sel" : ""}`} style={{ paddingLeft: 8 + span.depth * 16 }} onClick={onSelect}>
      <span className={`kind ${kindClass}`}>
        <span className="kemo" aria-hidden="true">{kindEmoji}</span>
        {span.kind.toUpperCase()}
      </span>
      <span className="nm2">
        {span.status === "error" && <Icon name="x" size={11} className="icon err-ic" style={{ verticalAlign: -1, marginRight: 4 }} />}
        {span.label}
      </span>
      <span className="sptime">{new Date(span.startTs).toLocaleTimeString()}</span>
      <span className="latbar">
        <i
          className={span.status === "error" ? "e" : span.status === "running" ? "" : "g"}
          style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
        />
      </span>
      <span className="lat">{formatSpanDur(span.endTs - span.startTs)}</span>
    </button>
  );
}

export function TraceTab({ runId }: { runId: string }) {
  const evQ = useRunEvents(runId);
  const events = useMemo(() => evQ.data ?? [], [evQ.data]);
  const model = useMemo(() => buildTrace(events, runId), [events, runId]);
  const [selId, setSelId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("io");
  // Scope the tree, not the model: spans keep their depth and their bars stay
  // measured against the whole run, so one agent's work still reads in the
  // context of the run's timeline rather than being rescaled to itself.
  const scopes = useEventScopes(events);
  const scope = useAgentScope(scopes);
  const spans = useMemo(() => inScope(model.spans, scope), [model.spans, scope]);
  const selected = spans.find((s) => s.id === selId) ?? spans[0] ?? null;
  // spanDetail walks the whole event list — memoize so unrelated re-renders
  // (splitter drags, verdict polls) don't recompute it
  // detail reads the FULL event list — a span's I/O and stats come from the
  // events around it, which the scope must not starve
  const detail = useMemo(() => (selected ? spanDetail(selected, events) : null), [selected, events]);

  // Tail the span tree: spans append as the run works, so a live trace scrolls
  // itself to the newest one. Selection is deliberately left alone — the tail
  // moves the view, never the detail pane you're reading.
  const tail = useTail(spans.length, { resetKey: runId, layoutKey: scope?.value ?? "" });

  // per-agent verdict — scoped to the selected agent's run, NOT the whole run
  const digestQ = useDigest(runId);
  const verdict = useVerdict(runId);
  const agentName = selected?.agent ?? "";
  const persisted = digestQ.data?.agentVerdicts?.[agentName];
  // a human score (source "api") locks the verdict; a workflow auto-score
  // (source "auto") is persisted but still treated as a suggestion.
  const manualVerdict = persisted && persisted.source !== "auto" ? persisted.status : undefined;
  const persistedAuto = persisted?.source === "auto" ? persisted.status : undefined;
  // buildTrace() already resolves a finished sub-agent to "done" (a running
  // span means it's the live, trailing activity), so the span status is the
  // single source of truth here.
  const agentActive = selected?.status === "running";
  // auto-score: prefer the workflow's persisted verdict, else derive once the
  // agent is done — fail if its span errored or any turn failed, else pass. A
  // finished agent always resolves to pass/fail, even with no turn_end events.
  const st = detail?.stats;
  const derivedAuto: "pass" | "fail" | null =
    st && !agentActive
      ? selected?.status === "error" || st.turnsFailed > 0
        ? "fail"
        : "pass"
      : null;
  const autoVerdict = persistedAuto ?? derivedAuto ?? null;
  const effectiveVerdict = manualVerdict ?? autoVerdict ?? (agentActive ? "running" : "open");
  const isAuto = !manualVerdict && autoVerdict != null;

  // resizable split between the span tree and the detail panel (persisted)
  const gridRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState<number>(() => {
    const v = Number(localStorage.getItem("obs.traceSplit"));
    return v >= 18 && v <= 82 ? v : 42;
  });
  const dragging = useRef(false);
  const [dragView, setDragView] = useState(false);
  // persisted on drag release (onSplitUp), not per pointer-move
  const onSplitDown = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragging.current = true;
    setDragView(true);
  };
  const onSplitMove = (e: React.PointerEvent) => {
    if (!dragging.current || !gridRef.current) return;
    const r = gridRef.current.getBoundingClientRect();
    const pct = ((e.clientX - r.left) / r.width) * 100;
    setSplit(Math.min(82, Math.max(18, pct)));
  };
  const onSplitUp = () => {
    if (dragging.current) localStorage.setItem("obs.traceSplit", String(Math.round(split)));
    dragging.current = false;
    setDragView(false);
  };

  if (evQ.isLoading) return <TabSkeleton label="Loading trace…" />;
  if (!model.spans.length) return <div className="tab-empty">No spans recorded for this run yet.</div>;

  return (
    <div className="trace-grid" ref={gridRef} style={{ gridTemplateColumns: `${split}% 7px minmax(0, 1fr)` }}>
      <div className="tree">
        <div className="thead">
          <span className="t">Spans</span>
          <AgentFilter options={scopes} width={150} />
          <span className="sub">
            {scope ? `${spans.length} of ${model.spans.length}` : model.spans.length}
          </span>
          <TailChip tail={tail} noun="span" />
        </div>
        <div className="treewrap" ref={tail.ref} onScroll={tail.onScroll}>
          {spans.map((s) => (
            <SpanRow
              key={s.id}
              span={s}
              bar={spanBar(s, model)}
              selected={selected?.id === s.id}
              onSelect={() => setSelId(s.id)}
            />
          ))}
        </div>
      </div>
      <div
        className={`tsplit ${dragView ? "dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onSplitDown}
        onPointerMove={onSplitMove}
        onPointerUp={onSplitUp}
      />
      <div className="iop">
        {selected && detail && (
          <>
            <div className="dchips">
              {detail.chips.map((c) => (
                <span className={`dc ${c.warn ? "w" : ""}`} key={c.k}>
                  {c.k} <b>{c.v}</b>
                </span>
              ))}
            </div>
            <div
              className="dtabs"
              role="tablist"
              onKeyDown={(e) => onTablistKey(e, DETAIL_TABS.map((t) => t.id), detailTab, setDetailTab)}
            >
              {DETAIL_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={detailTab === t.id}
                  tabIndex={detailTab === t.id ? 0 : -1}
                  className={`dtab ${detailTab === t.id ? "on" : ""}`}
                  onClick={() => setDetailTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="iobody">
              {detailTab === "io" && (
                <>
                  {detail.input && (
                    <IoBlock title="Input" role={detail.input.role} text={detail.input.text} kind="input" />
                  )}
                  {detail.output && (
                    <IoBlock title="Output" role={detail.output.role} text={detail.output.text} kind="output" />
                  )}
                </>
              )}
              {detailTab === "meta" && (
                <div className="metatbl">
                  {detail.meta.map((m) => (
                    <div className="metarow" key={m.k}>
                      <span className="mk">{m.k}</span>
                      <span className="mv">{m.v}</span>
                    </div>
                  ))}
                </div>
              )}
              {detailTab === "raw" &&
                (detail.raw.length ? (
                  detail.raw.map((e, i) => (
                    <div className="io" key={i}>
                      <div className="ioh">
                        {e.type} <span className="role">· {new Date(e.ts).toLocaleTimeString()}</span>
                      </div>
                      <pre className="jraw" dangerouslySetInnerHTML={{ __html: highlightJson(e.payload) }} />
                    </div>
                  ))
                ) : (
                  <div className="tab-empty small">No payloads in this span window.</div>
                ))}
            </div>
            {selected.kind === "agent" && detail.stats && (
              <div className="statstrip">
                <span className={`vpill ${effectiveVerdict}`}>
                  <span className="vk">verdict</span>
                  <b>{effectiveVerdict}</b>
                  {isAuto && <span className="auto">auto</span>}
                </span>
                <div className="stcell">
                  <span className="stk">turns</span>
                  <b className={detail.stats.turnsFailed ? "bad" : "good"}>
                    {detail.stats.turnsPassed} pass · {detail.stats.turnsFailed} fail
                  </b>
                </div>
                <div className="stcell">
                  <span className="stk">retry rate</span>
                  <b className={detail.stats.retryRate > 0 ? "warn" : ""}>{detail.stats.retryRate.toFixed(2)}</b>
                </div>
                {detail.stats.costDeltaPct != null && (
                  <div className="stcell">
                    <span className="stk">cost vs p50</span>
                    <b className={detail.stats.costDeltaPct > 0 ? "warn" : "good"}>
                      {detail.stats.costDeltaPct > 0 ? "+" : ""}
                      {detail.stats.costDeltaPct}%
                    </b>
                  </div>
                )}
                <span className="stspace" />
                {verdict.isError && (
                  <span className="verr" role="alert" title={(verdict.error as Error)?.message}>
                    score failed — {(verdict.error as Error)?.message || "server unreachable"}
                  </span>
                )}
                <button
                  className={`sc p ${manualVerdict === "pass" ? "on" : ""} ${isAuto && autoVerdict === "pass" ? "auto" : ""}`}
                  disabled={verdict.isPending}
                  onClick={() => verdict.mutate({ status: "pass", agent: agentName })}
                >
                  <Icon name="check" size={13} /> pass
                </button>
                <button
                  className={`sc f ${manualVerdict === "fail" ? "on" : ""} ${isAuto && autoVerdict === "fail" ? "auto" : ""}`}
                  disabled={verdict.isPending}
                  onClick={() => verdict.mutate({ status: "fail", agent: agentName })}
                >
                  <Icon name="x" size={13} /> fail
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
