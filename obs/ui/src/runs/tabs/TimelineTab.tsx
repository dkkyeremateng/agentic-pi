import { useEffect, useMemo, useRef, useState } from "react";
import { useRunEvents } from "../../data/queries";
import { useObs } from "../../data/store";
import { buildTrace, type Span } from "../../data/derive/trace";
import {
  fullView,
  viewBar,
  revealBar,
  clampView,
  fracToTs,
  tsToFrac,
  axisTicks,
  isZoomed,
  type View,
} from "../../data/derive/timeline";
import { buildReplay, totalsAt, stepFrom, buildWarp, type Pace } from "../../data/derive/replay";
import { agentColor, formatSpanDur, formatCost, formatTokens } from "../../lib/format";
import { Icon } from "../../lib/Icon";
import { TabSkeleton } from "../../lib/Skeleton";
import { AgentFilter, inScope, useAgentScope, useEventScopes } from "../AgentFilter";
import "./timeline.css";

const GUTTER = 190; // px label column, matches .tlane grid
const RIGHT = 144; // px readout column (128) + track right margin (16)

// short model name for the lane label: "anthropic/claude-fable-5" → "fable-5"
const shortModel = (m?: string) => (m ? (m.split("/").pop() ?? m).replace(/^claude-/, "") : "");
const SPEEDS = [0.5, 1, 2, 4];
const PACES: { id: Pace; label: string; hint: string }[] = [
  { id: "fit", label: "Fit", hint: "Proportional — idle gaps shown to scale" },
  { id: "even", label: "Even", hint: "Equal time per event — collapses idle gaps" },
];
const REPLAY_MS = 9000; // wall-time to replay the full window at 1×

interface Lane {
  agent: string;
  depth: number;
  envelope: Span;
  segs: Span[];
}

// Legend doubles as a kind filter. "agent" toggles the lane envelope bars; the
// rest toggle segments. A segment's kind is its status when errored, else its span kind.
type Kind = "agent" | "llm" | "tool" | "error";
const KINDS: { id: Kind; color: string }[] = [
  { id: "agent", color: "rgba(124,108,242,.45)" },
  { id: "llm", color: "var(--cy)" },
  { id: "tool", color: "var(--ok)" },
  { id: "error", color: "var(--err)" },
];
const segKind = (s: Span): Kind => (s.status === "error" ? "error" : s.kind === "tool" ? "tool" : "llm");

// Per-run UI state, kept across tab/page switches (the tab unmounts when you
// leave it). Module-level so it survives remounts within the session; playback
// (`playing`) is intentionally not persisted — we don't auto-resume on return.
interface TlSnapshot {
  view: View;
  playhead: number;
  speed: number;
  pace: Pace;
  follow: boolean;
  loop: boolean;
  solo: string | null;
  kinds: Kind[];
}
const TL_CACHE_MAX = 50; // snapshots kept; oldest-written evicted (simple LRU)
const timelineCache = new Map<string, TlSnapshot>();
// Map iteration order is insertion order — delete+set moves the entry to the
// back, so the front is always the least-recently-written run.
function cacheSnapshot(runId: string, snap: TlSnapshot) {
  timelineCache.delete(runId);
  timelineCache.set(runId, snap);
  if (timelineCache.size > TL_CACHE_MAX) {
    const oldest = timelineCache.keys().next().value;
    if (oldest !== undefined) timelineCache.delete(oldest);
  }
}

const elapsed = (ms: number) => (ms <= 0 ? "0s" : formatSpanDur(ms));

export function TimelineTab({ runId }: { runId: string }) {
  const evQ = useRunEvents(runId);
  // Scope to this run BEFORE deriving: buildTrace filters internally, but
  // buildReplay doesn't — and useLiveEvents merges pushed events that carry no
  // runId, which would then inflate the replay's cost/token/error totals with
  // work that never appears as a span.
  const events = useMemo(() => (evQ.data ?? []).filter((e) => e.runId === runId), [evQ.data, runId]);
  const model = useMemo(() => buildTrace(events, runId), [events, runId]);
  // Bounds stay run-wide even when scoped, so the axis doesn't rescale under
  // you — one agent's work keeps its true position in the run rather than
  // being stretched to fill the width.
  const bounds = useMemo(() => fullView(model.runStart, model.runEnd), [model.runStart, model.runEnd]);

  const scopes = useEventScopes(events);
  const scope = useAgentScope(scopes);
  const scopedSpans = useMemo(() => inScope(model.spans, scope), [model.spans, scope]);
  const scopedEvents = useMemo(() => inScope(events, scope), [events, scope]);
  // the running tally follows the scope too — "cost so far" means the scoped
  // agent's cost, not the run's, whenever a lane filter is on
  const replay = useMemo(() => buildReplay(scopedEvents, scopedSpans), [scopedEvents, scopedSpans]);

  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = [];
    const byDepth = new Map<number, Lane>();
    for (const s of scopedSpans) {
      if (s.kind === "agent") {
        const lane: Lane = { agent: s.agent, depth: s.depth, envelope: s, segs: [] };
        out.push(lane);
        byDepth.set(s.depth, lane);
      } else {
        byDepth.get(s.depth - 1)?.segs.push(s);
      }
    }
    return out;
  }, [scopedSpans]);

  // restore this run's persisted state (captured once at mount; view/playhead are
  // restored by the effect below once bounds are known)
  const snap0 = timelineCache.get(runId);
  const snapRef = useRef(snap0);
  const restoredRef = useRef(false);

  const [view, setView] = useState<View>(bounds);
  const [playhead, setPlayhead] = useState(bounds.end);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(() => snap0?.speed ?? 1);
  const [pace, setPace] = useState<Pace>(() => snap0?.pace ?? "fit");
  const [follow, setFollow] = useState(() => snap0?.follow ?? true);
  const [loop, setLoop] = useState(() => snap0?.loop ?? false);
  const [solo, setSolo] = useState<string | null>(() => snap0?.solo ?? null); // isolate one agent lane
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null);
  const [kinds, setKinds] = useState<Set<Kind>>(() => new Set(snap0?.kinds ?? KINDS.map((k) => k.id)));
  const toggleKind = (k: Kind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // shared focus time bridges this tab with the Events tab (both write the time
  // they're parked on; the other scrolls / seeks there when you switch tabs).
  const focusTs = useObs((s) => s.focusTs);
  const setFocusTs = useObs((s) => s.setFocusTs);
  const setRunTab = useObs((s) => s.setRunTab);
  const setSelectEventTs = useObs((s) => s.setSelectEventTs);

  // refs let the rAF loop read live view/playhead without being torn down each
  // frame (panning the view during follow would otherwise restart the sweep).
  const viewRef = useRef(view);
  viewRef.current = view;
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  // Initialize the window/playhead once bounds are known: restore a saved
  // snapshot, else fit the full run. After that, live growth only FOLLOWS: an
  // un-zoomed view (still equal to the previous bounds) is extended to the new
  // bounds; a user-zoomed view — and a mid-replay playhead — are never reset.
  const prevBoundsRef = useRef<View | null>(null);
  useEffect(() => {
    if (model.runEnd <= model.runStart) return; // wait for events to load
    const prev = prevBoundsRef.current;
    prevBoundsRef.current = bounds;
    if (snapRef.current && !restoredRef.current) {
      const s = snapRef.current;
      restoredRef.current = true;
      setView(clampView(s.view, bounds));
      setPlayhead(Math.min(bounds.end, Math.max(bounds.start, s.playhead)));
      setPlaying(false);
      return;
    }
    if (prev) {
      // live bounds tick — follow only when the user hasn't zoomed
      if (viewRef.current.start === prev.start && viewRef.current.end === prev.end) {
        setView(bounds);
        // a playhead resting on the old live edge rides along to the new edge;
        // a scrubbed or replaying playhead is left alone
        if (!playing && playheadRef.current >= prev.end) setPlayhead(bounds.end);
      }
      return;
    }
    // first fit for a fresh run
    setView(bounds);
    const f = focusTs;
    setPlayhead(f != null && f >= bounds.start && f <= bounds.end ? f : bounds.end);
    setPlaying(false);
    // focusTs/playing read once per bounds tick — not deps, so replay isn't disturbed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.start, bounds.end, model.runStart, model.runEnd]);

  // Persist the run's UI state on change (skip until a pending restore has run,
  // so the initial default view doesn't overwrite the saved snapshot).
  useEffect(() => {
    if (snapRef.current && !restoredRef.current) return;
    cacheSnapshot(runId, { view, playhead, speed, pace, follow, loop, solo, kinds: [...kinds] });
  }, [runId, view, playhead, speed, pace, follow, loop, solo, kinds]);

  // keep `ts` inside the current window by sliding the window (constant width)
  const panToward = (ts: number) => {
    const v = viewRef.current;
    const w = v.end - v.start;
    const m = w * 0.18; // lead margin so the playhead rides ~18% from an edge
    if (ts > v.end - m) setView(clampView({ start: ts - w + m, end: ts + m }, bounds));
    else if (ts < v.start + m) setView(clampView({ start: ts - m, end: ts - m + w }, bounds));
  };

  // replay loop — position is computed absolutely from elapsed wall-time through
  // a pacing Warp, so a stray double-frame can't accelerate it. When following a
  // zoomed view, the window slides to keep the playhead on screen; the sweep
  // basis is the full run so replay never stops short at the window edge.
  useEffect(() => {
    if (!playing) return;
    const startReal = performance.now();
    const fol = follow && isZoomed(viewRef.current, bounds);
    const basis = fol ? bounds : viewRef.current;
    const warp = buildWarp(pace, replay.steps, basis.start, basis.end);
    const dur = REPLAY_MS / speed;
    let anchorReal = startReal;
    let startFrac = warp.inv(playheadRef.current);
    let raf = 0;
    const tick = (t: number) => {
      const f = startFrac + (t - anchorReal) / dur;
      if (f >= 1) {
        if (loop) {
          // wrap to the start and keep sweeping
          anchorReal = t;
          startFrac = 0;
          setPlayhead(basis.start);
          if (fol) setView(clampView({ start: basis.start, end: basis.start + (viewRef.current.end - viewRef.current.start) }, bounds));
          raf = requestAnimationFrame(tick);
          return;
        }
        setPlayhead(basis.end);
        setPlaying(false);
        return;
      }
      const ts = warp.at(f);
      setPlayhead(ts);
      if (fol) panToward(ts);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // view/playhead are read once via refs at start to anchor the sweep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, pace, follow, loop, bounds.start, bounds.end, replay.steps]);

  const lanesRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);

  const capture = (e: React.PointerEvent) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events / lost pointer — safe to ignore */
    }
  };
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  // fraction within the lane TRACK area (excludes the label gutter)
  const trackFrac = (clientX: number) => {
    const r = lanesRef.current!.getBoundingClientRect();
    return clamp01((clientX - (r.left + GUTTER)) / (r.width - GUTTER - RIGHT));
  };
  const elFrac = (ref: React.RefObject<HTMLDivElement | null>, clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };

  // ── brush-to-zoom on the lanes ──
  // brushRef drives the logic (never stale), `brush` state just renders the rect
  const brushRef = useRef<{ a: number; b: number } | null>(null);
  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capture(e);
    const f = trackFrac(e.clientX);
    brushRef.current = { a: f, b: f };
    setBrush(brushRef.current);
  };
  const onLaneMove = (e: React.PointerEvent) => {
    if (!brushRef.current) return;
    brushRef.current = { a: brushRef.current.a, b: trackFrac(e.clientX) };
    setBrush({ ...brushRef.current });
  };
  const onLaneUp = () => {
    const br = brushRef.current;
    brushRef.current = null;
    setBrush(null);
    if (!br) return;
    const a = Math.min(br.a, br.b);
    const b = Math.max(br.a, br.b);
    if (b - a > 0.015) {
      const nv = clampView({ start: fracToTs(a, view), end: fracToTs(b, view) }, bounds);
      setView(nv);
      setPlayhead(nv.end);
      setPlaying(false);
    }
  };

  // ── scrubber (playhead drag) ──
  const scrubbing = useRef(false);
  const doScrub = (clientX: number) => {
    setPlaying(false);
    const t = fracToTs(elFrac(scrubRef, clientX), view);
    setPlayhead(t);
    setFocusTs(t);
  };
  const onScrubDown = (e: React.PointerEvent) => {
    capture(e);
    scrubbing.current = true;
    doScrub(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    if (scrubbing.current) doScrub(e.clientX);
  };
  const onScrubUp = () => {
    scrubbing.current = false;
  };

  // ── overview minimap: pan (body) + resize (edge handles) ──
  const ovDrag = useRef<{ mode: "pan" | "l" | "r"; startFrac: number; startView: View } | null>(null);
  const onOvDown = (e: React.PointerEvent) => {
    capture(e);
    const f = elFrac(ovRef, e.clientX);
    const handle = (e.target as HTMLElement).dataset.h as "l" | "r" | undefined;
    if (handle) {
      ovDrag.current = { mode: handle, startFrac: f, startView: view };
      return;
    }
    const wl = tsToFrac(view.start, bounds);
    const wr = tsToFrac(view.end, bounds);
    if (f >= wl && f <= wr) {
      ovDrag.current = { mode: "pan", startFrac: f, startView: view };
    } else {
      // jump: center the window on the click, then pan from there
      const span = view.end - view.start;
      const c = fracToTs(f, bounds);
      const nv = clampView({ start: c - span / 2, end: c + span / 2 }, bounds);
      setView(nv);
      ovDrag.current = { mode: "pan", startFrac: elFrac(ovRef, e.clientX), startView: nv };
    }
    setPlaying(false);
  };
  const onOvMove = (e: React.PointerEvent) => {
    const d = ovDrag.current;
    if (!d) return;
    const f = elFrac(ovRef, e.clientX);
    if (d.mode === "pan") {
      const deltaTs = (f - d.startFrac) * (bounds.end - bounds.start);
      setView(clampView({ start: d.startView.start + deltaTs, end: d.startView.end + deltaTs }, bounds));
    } else if (d.mode === "l") {
      setView(clampView({ start: fracToTs(f, bounds), end: d.startView.end }, bounds));
    } else {
      setView(clampView({ start: d.startView.start, end: fracToTs(f, bounds) }, bounds));
    }
  };
  const onOvUp = () => {
    ovDrag.current = null;
  };

  const playToggle = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const fol = follow && isZoomed(view, bounds);
    const startEdge = fol ? bounds.start : view.start;
    const endEdge = fol ? bounds.end : view.end;
    if (playhead >= endEdge - 1) {
      setPlayhead(startEdge); // restart from the left
      if (fol) setView(clampView({ start: bounds.start, end: bounds.start + (view.end - view.start) }, bounds));
    }
    setPlaying(true);
  };
  const resetZoom = () => {
    setView(bounds);
    setPlayhead(bounds.end);
  };

  const seek = (ts: number) => {
    setPlaying(false);
    const t = Math.min(view.end, Math.max(view.start, ts));
    setPlayhead(t);
    setFocusTs(t);
  };
  // snap the playhead to the previous / next span boundary
  const step = (dir: 1 | -1) => {
    setPlaying(false);
    const t = stepFrom(replay.steps, playhead, dir, view.start, view.end) ?? (dir > 0 ? view.end : view.start);
    setPlayhead(t);
    setFocusTs(t);
  };
  const bumpSpeed = (dir: 1 | -1) => {
    const i = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + dir))]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === " " || k === "Spacebar") playToggle();
    else if (k === "ArrowLeft") step(-1);
    else if (k === "ArrowRight") step(1);
    else if (k === "Home") seek(view.start);
    else if (k === "End") seek(view.end);
    else if (k === "ArrowUp") bumpSpeed(1);
    else if (k === "ArrowDown") bumpSpeed(-1);
    else return;
    e.preventDefault();
  };

  if (evQ.isLoading) return <TabSkeleton label="Loading timeline…" />;
  if (!lanes.length) return <div className="tab-empty">No spans to plot yet.</div>;

  const zoomed = isZoomed(view, bounds);
  const phFrac = tsToFrac(playhead, view);
  const now = totalsAt(replay.cum, playhead); // running tally up to the playhead
  const active = scopedSpans.filter((s) => s.kind !== "agent" && s.startTs <= playhead && playhead < s.endTs);
  const replayed = playing || playhead < view.end - 1; // reveal mode active?
  const ticks = axisTicks(view).map((ts) => ({ left: tsToFrac(ts, view) * 100, label: elapsed(ts - bounds.start) }));
  const flat = scopedSpans.filter((s) => s.kind !== "agent");
  const winL = tsToFrac(view.start, bounds) * 100;
  const winW = (tsToFrac(view.end, bounds) - tsToFrac(view.start, bounds)) * 100;

  return (
    <div className="tl" tabIndex={0} onKeyDown={onKey}>
      <div className="tlhd">
        <span className="t">Timeline</span>
        <AgentFilter options={scopes} width={150} />
        {scope && (
          <span className="tlscope mono">
            {lanes.length} of {model.spans.filter((s) => s.kind === "agent").length} lanes
          </span>
        )}
        <span className="leg" role="group" aria-label="Filter by kind">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`legchip ${kinds.has(k.id) ? "on" : "off"}`}
              onClick={() => toggleKind(k.id)}
              aria-pressed={kinds.has(k.id)}
              title={`Show / hide ${k.id}`}
            >
              <i style={{ background: k.color }} />
              {k.id}
            </button>
          ))}
        </span>
      </div>

      {/* controls */}
      <div className="tlctrls">
        <button className="tlbtn play" onClick={playToggle} title={`${playing ? "Pause" : "Play"} replay — Space · ←/→ step · ↑/↓ speed`}>
          <Icon name={playing ? "pause" : "play"} size={13} />
          {playing ? "Pause" : "Replay"}
        </button>
        <button className="tlbtn ghost step" onClick={() => step(-1)} title="Previous event (←)" aria-label="Step to previous event">
          ‹
        </button>
        <button className="tlbtn ghost step" onClick={() => step(1)} title="Next event (→)" aria-label="Step to next event">
          ›
        </button>
        <div className="tlspeed">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="tlspeed" role="group" aria-label="Replay pacing">
          {PACES.map((p) => (
            <button key={p.id} className={pace === p.id ? "on" : ""} onClick={() => setPace(p.id)} title={p.hint}>
              {p.label}
            </button>
          ))}
        </div>
        <button
          className={`tlbtn ghost foll ${follow ? "on" : ""}`}
          onClick={() => setFollow((v) => !v)}
          aria-pressed={follow}
          title="Follow the playhead while zoomed — pans the window so the sweep stays on screen"
        >
          <Icon name="crosshair" size={12} />
          Follow
        </button>
        <button
          className={`tlbtn ghost foll ${loop ? "on" : ""}`}
          onClick={() => setLoop((v) => !v)}
          aria-pressed={loop}
          title="Loop the replay"
        >
          <Icon name="retry" size={12} />
          Loop
        </button>
        <span className="tltime mono">
          T+{elapsed(playhead - bounds.start)} <span className="sep">/</span> {elapsed(bounds.end - bounds.start)}
        </span>
        <span className="tlspacer" />
        <span className="tlzoom mono">{zoomed ? `${Math.round(((bounds.end - bounds.start) / (view.end - view.start)) * 100) / 100}× zoom` : "full"}</span>
        <button className="tlbtn ghost" onClick={resetZoom} disabled={!zoomed}>
          Reset
        </button>
      </div>

      {/* "now" readout — what's live at the playhead + running totals up to it */}
      <div className="tlnow">
        <div className="tlnow-active">
          {active.length ? (
            <>
              {active.slice(0, 3).map((s) => (
                <span className={`nchip ${s.status === "error" ? "err" : s.kind}`} key={s.id} title={s.label}>
                  {s.label}
                </span>
              ))}
              {active.length > 3 && <span className="nmore">+{active.length - 3}</span>}
            </>
          ) : (
            <span className="nidle">{playing ? "waiting…" : playhead >= view.end ? "complete" : "idle"}</span>
          )}
        </div>
        <div className="tlnow-stats mono">
          <span className="ns">
            <i>cost</i>
            <b>{formatCost(now.cost)}</b>
            <u>/ {formatCost(replay.total.cost)}</u>
          </span>
          <span className="ns">
            <i>tokens</i>
            <b>{formatTokens(now.tokens)}</b>
            <u>/ {formatTokens(replay.total.tokens)}</u>
          </span>
          <span className="ns">
            <i>tools</i>
            <b>{now.tools}</b>
            <u>/ {replay.total.tools}</u>
          </span>
          <span className={`ns ${now.errors ? "err" : ""}`}>
            <i>err</i>
            <b>{now.errors}</b>
            <u>/ {replay.total.errors}</u>
          </span>
        </div>
      </div>

      {/* overview minimap */}
      <div className="tlov-row">
        <span className="tlov-cap">overview</span>
        <div className="tlov" ref={ovRef} onPointerDown={onOvDown} onPointerMove={onOvMove} onPointerUp={onOvUp}>
          {flat.map((s) => {
            if (!kinds.has(segKind(s))) return null;
            const b = viewBar(s.startTs, s.endTs, bounds);
            const err = s.status === "error";
            const c = err ? "var(--err)" : s.kind === "tool" ? "var(--ok)" : "var(--cy)";
            return (
              <span
                key={s.id}
                className={`tlov-mark ${err ? "err" : ""}`}
                style={{ left: `${b.left * 100}%`, width: `${Math.max(err ? 0.8 : 0.4, b.width * 100)}%`, background: c }}
              />
            );
          })}
          <div className="tlov-win" style={{ left: `${winL}%`, width: `${winW}%` }}>
            <span className="tlov-h l" data-h="l" />
            <span className="tlov-h r" data-h="r" />
          </div>
        </div>
      </div>

      {/* axis */}
      <div className="tlaxis">
        <div />
        <div className="ticks">
          {ticks.map((t, i) => (
            <span key={i} style={{ left: `${t.left}%`, transform: i === 0 ? "none" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {/* lanes + playhead + brush */}
      <div
        className="tlanes"
        ref={lanesRef}
        onPointerDown={onLaneDown}
        onPointerMove={onLaneMove}
        onPointerUp={onLaneUp}
      >
        {lanes.map((lane, i) => {
          const env = viewBar(lane.envelope.startTs, lane.envelope.endTs, view);
          const dimmed = solo != null && solo !== lane.agent;
          return (
            <div className={`tlane ${dimmed ? "dim" : ""} ${solo === lane.agent ? "solo" : ""}`} key={i}>
              <button
                type="button"
                className="ln"
                style={{ paddingLeft: 16 + lane.depth * 12 }}
                onClick={() => setSolo((cur) => (cur === lane.agent ? null : lane.agent))}
                title={solo === lane.agent ? "Clear solo" : `Solo ${lane.agent}`}
                aria-pressed={solo === lane.agent}
              >
                <i style={{ background: `var(--a${agentColor(lane.agent)})` }} />
                <span className="lnname">{lane.agent}</span>
                {lane.envelope.model && <span className="lnmodel">{shortModel(lane.envelope.model)}</span>}
              </button>
              <div className="tltrack">
                {env.visible && kinds.has("agent") && <span className="tlbar" style={{ left: `${env.left * 100}%`, width: `${env.width * 100}%` }} />}
                {lane.segs.map((s) => {
                  const b = viewBar(s.startTs, s.endTs, view);
                  if (!b.visible) return null;
                  if (!kinds.has(segKind(s))) return null;
                  const cls = s.status === "error" ? "err" : s.kind === "tool" ? "tool" : "llm";
                  const rev = revealBar(s.startTs, s.endTs, view, playhead);
                  const isActive = replayed && s.startTs <= playhead && playhead < s.endTs;
                  // click a segment → jump to that event in the Events tab (the
                  // one-shot selectEventTs intent selects, scroll-flashes, and
                  // opens the drawer there). stopPropagation keeps the click
                  // from starting a brush-zoom on the lane.
                  const jump = (e: React.MouseEvent) => {
                    e.stopPropagation();
                    setFocusTs(s.startTs); // seed the shared playhead position
                    setSelectEventTs(s.startTs); // explicit pick → select/scroll/flash
                    setRunTab("events");
                  };
                  const stop = (e: React.PointerEvent) => e.stopPropagation();
                  return (
                    <span key={s.id} title={s.label}>
                      <span
                        className={`tlseg ghost hit ${cls}`}
                        style={{ left: `${b.left * 100}%`, width: `${b.width * 100}%` }}
                        onPointerDown={stop}
                        onClick={jump}
                      />
                      {replayed && rev.width > 0 && (
                        <span
                          className={`tlseg hit ${cls}${isActive ? " active" : ""}`}
                          style={{ left: `${rev.left * 100}%`, width: `${rev.width * 100}%` }}
                          onPointerDown={stop}
                          onClick={jump}
                        />
                      )}
                      {!replayed && (
                        <span
                          className={`tlseg hit ${cls}`}
                          style={{ left: `${b.left * 100}%`, width: `${b.width * 100}%` }}
                          onPointerDown={stop}
                          onClick={jump}
                        />
                      )}
                    </span>
                  );
                })}
              </div>
              <span className="tlmeta">
                <b>{formatSpanDur(lane.envelope.endTs - lane.envelope.startTs)}</b>
                {(lane.envelope.costUsd ?? 0) > 0 && (
                  <>
                    {" · "}
                    <span className="tlcost">{formatCost(lane.envelope.costUsd ?? 0)}</span>
                  </>
                )}
              </span>
            </div>
          );
        })}

        {/* overlay: brush selection + playhead, aligned to the track area */}
        <div className="tloverlay">
          {brush && (
            <span
              className="tlbrush"
              style={{ left: `${Math.min(brush.a, brush.b) * 100}%`, width: `${Math.abs(brush.b - brush.a) * 100}%` }}
            />
          )}
          {replayed && <span className="tlplay" style={{ left: `${clamp01(phFrac) * 100}%` }} />}
        </div>
      </div>

      {/* scrubber */}
      <div className="tlscrub">
        <span className="sl">
          <button type="button" className="pl" onClick={playToggle} aria-label={playing ? "Pause replay" : "Play replay"}>
            <Icon name={playing ? "pause" : "play"} size={12} />
          </button>
          scrub
        </span>
        <div
          className="scrub"
          ref={scrubRef}
          role="slider"
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={Math.round((bounds.end - bounds.start) / 1000)}
          aria-valuenow={Math.round((playhead - bounds.start) / 1000)}
          aria-valuetext={`T+${elapsed(playhead - bounds.start)}`}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
        >
          <i style={{ width: `${clamp01(phFrac) * 100}%` }} />
          {replay.markers.map((mk, i) => {
            const f = tsToFrac(mk.ts, view);
            if (f < 0 || f > 1) return null;
            return (
              <span
                key={i}
                className={`smk ${mk.kind}`}
                style={{ left: `${f * 100}%` }}
                title={mk.label}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  seek(mk.ts);
                }}
              />
            );
          })}
          <b style={{ left: `${clamp01(phFrac) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
