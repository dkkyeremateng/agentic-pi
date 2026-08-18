import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRuns } from "../data/queries";
import { useObs } from "../data/store";
import { collectAnalytics, buildSeries, type Analytics, type SeriesPoint } from "../data/derive/analytics";
import { evalTrends } from "../data/derive/evals";
import { runTitle, durationMs, statusOf } from "../runs/runUtils";
import { StatusChip } from "../lib/Chip";
import { Spark } from "../lib/Spark";
import { Combo } from "../lib/Combo";
import { TabSkeleton } from "../lib/Skeleton";
import { formatCost, formatDuration, formatTokens } from "../lib/format";
import type { RunMeta } from "../data/types";
import "./analytics.css";

// eased count-up for the hero readout
function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(0);
  // track the live displayed value so a target change mid-animation resumes from
  // where the number actually is — not the stale start of the previous tween.
  const shown = useRef(0);
  useEffect(() => {
    const a = shown.current;
    const b = target;
    if (a === b) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      const cur = a + (b - a) * e;
      shown.current = cur;
      setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

// area+line sparkline with a draw-in line (no dots — preserveAspectRatio:none ok).
// When `labels`/`fmt` are supplied, transparent per-bucket hover bands carry a
// native <title> readout (matches the hero chart's tooltip behaviour).
function MiniTrend({ values, color, labels, fmt }: { values: number[]; color: string; labels?: string[]; fmt?: (n: number) => string }) {
  const W = 220;
  const H = 46;
  const n = values.length;
  const max = Math.max(1e-9, ...values);
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - 3 - (v / max) * (H - 8);
  const line = values.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = n ? `M 0 ${H} L ${values.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" L ")} L ${W} ${H} Z` : "";
  const bw = n > 1 ? W / (n - 1) : W;
  return (
    <svg className="minitrend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {n > 0 && <path d={area} fill={color} fillOpacity="0.13" />}
      {n > 1 && (
        <path
          className="drawin"
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
        />
      )}
      {labels &&
        fmt &&
        values.map((v, i) => (
          <rect key={i} x={x(i) - bw / 2} y={0} width={bw} height={H} fill="transparent">
            <title>{`${labels[i]} · ${fmt(v)}`}</title>
          </rect>
        ))}
    </svg>
  );
}

function KpiTrend({
  label,
  value,
  values,
  color,
  labels,
  fmt,
}: {
  label: string;
  value: string;
  values: number[];
  color: string;
  labels?: string[];
  fmt?: (n: number) => string;
}) {
  return (
    <div className="readout reveal" style={{ "--accent": color } as CSSProperties}>
      <div className="ro-k">{label}</div>
      <div className="ro-v">{value}</div>
      <div className="ro-spark">
        <MiniTrend values={values} color={color} labels={labels} fmt={fmt} />
      </div>
    </div>
  );
}

const HEAD_METRICS: { id: string; label: string; color: string; fmt: (v: number) => string; get: (p: SeriesPoint) => number }[] = [
  { id: "cost", label: "Cost", color: "#7c6cf2", fmt: (v) => formatCost(v), get: (p) => p.costUsd },
  { id: "runs", label: "Runs", color: "#7c6cf2", fmt: (v) => Math.round(v).toLocaleString(), get: (p) => p.runs },
  { id: "tokens", label: "Tokens", color: "#4cc9f0", fmt: (v) => formatTokens(v), get: (p) => p.tokens },
  { id: "errors", label: "Errors", color: "#fb7185", fmt: (v) => Math.round(v).toLocaleString(), get: (p) => p.errors },
];

// commanding headline readout — metric switcher, count-up number, area trend
// over a graph-paper grid with a draw-in line and a live end-marker.
function HeadlineTrend({ series, a }: { series: SeriesPoint[]; a: Analytics }) {
  const [mi, setMi] = useState(0);
  const m = HEAD_METRICS[mi];
  const values = series.map(m.get);
  const total = values.reduce((s, v) => s + v, 0);
  const animated = useCountUp(total);
  const W = 1000;
  const H = 240;
  const TOP = 26;
  const BASE = H - 6;
  const n = series.length;
  const max = Math.max(1e-9, ...values);
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => BASE - (v / max) * (BASE - TOP);
  const line = values.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = n ? `M 0 ${BASE} L ${values.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" L ")} L ${W} ${BASE} Z` : "";
  const end = n ? { x: x(n - 1), y: y(values[n - 1]) } : null;
  const labelStep = Math.max(1, Math.ceil(n / 6));

  return (
    <div className="m-hero reveal" key={m.id} style={{ "--accent": m.color } as CSSProperties}>
      <div className="hero-head">
        <div className="m-seg">
          {HEAD_METRICS.map((mm, i) => (
            <button key={mm.id} className={i === mi ? "on" : ""} onClick={() => setMi(i)}>
              {mm.label}
            </button>
          ))}
        </div>
        <div className="hero-readouts">
          <span>
            <i>RUNS</i>
            <b>{a.totalRuns}</b>
          </span>
          <span>
            <i>PASS</i>
            <b>{a.scored ? `${Math.round(a.passRate * 100)}%` : "—"}</b>
          </span>
          <span>
            <i>P50</i>
            <b>{formatDuration(a.p50DurationMs)}</b>
          </span>
          <span>
            <i>P95</i>
            <b>{formatDuration(a.p95DurationMs)}</b>
          </span>
        </div>
      </div>
      <div className="hero-figure">{m.fmt(animated)}</div>
      <div className="hero-chart">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="hlArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={m.color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={m.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.2, 0.4, 0.6, 0.8].map((f) => {
            const gy = TOP + f * (BASE - TOP);
            return <line key={f} x1="0" y1={gy} x2={W} y2={gy} stroke="rgba(255,255,255,.045)" />;
          })}
          {area && <path d={area} fill="url(#hlArea)" />}
          {n > 1 && (
            <path className="drawin slow" d={line} fill="none" stroke={m.color} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" pathLength={1} />
          )}
          {end && (
            <>
              <circle className="pulse" cx={end.x} cy={end.y} r="9" fill={m.color} opacity="0.18" />
              <circle cx={end.x} cy={end.y} r="3.5" fill={m.color} stroke="var(--bg)" strokeWidth="2" />
            </>
          )}
          {/* transparent per-bucket hover bands — native <title> gives an exact
              value readout on hover without a charting dependency */}
          {series.map((p, i) => {
            const bw = n > 1 ? W / (n - 1) : W;
            return (
              <rect key={i} x={x(i) - bw / 2} y={TOP} width={bw} height={BASE - TOP} fill="transparent">
                <title>{`${p.label} · ${m.fmt(values[i])}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="hero-xax">
        {series.filter((_, i) => i % labelStep === 0).map((p, i) => (
          <span key={i}>{p.label}</span>
        ))}
      </div>
    </div>
  );
}

// Render a percentage delta, but past ~10× the percent form stops being
// scannable ("+87732%" for a 1m52s vs 27h23m run) — switch to a "×N" multiple,
// which reads at a glance regardless of magnitude.
function formatDelta(pct: number): string {
  if (pct === 0) return "—";
  if (Math.abs(pct) < 1000) return `${pct > 0 ? "+" : ""}${pct}%`;
  const mult = (pct + 100) / 100; // +2194% → 22.94× ; -50% wouldn't reach here
  return mult >= 100 ? `×${Math.round(mult)}` : `×${mult.toFixed(1)}`;
}

function deltaRow(label: string, a: number, b: number, fmt: (n: number) => string, lowerBetter = true) {
  // 0 → x has no % basis: call it "new" (worse when lower is better, e.g.
  // errors appearing) instead of the misleading flat "—"
  const isNew = a === 0 && b !== 0;
  const pct = a === 0 ? 0 : Math.round(((b - a) / a) * 100);
  const dir = isNew ? (lowerBetter ? "up" : "dn") : pct === 0 ? "flat" : (pct < 0) === lowerBetter ? "dn" : "up";
  return (
    <div className="drow" key={label}>
      <span className="dk">{label}</span>
      <span className="va">{fmt(a)}</span>
      <span className="vb">{fmt(b)}</span>
      <span className={`dd ${dir}`}>{isNew ? "new" : formatDelta(pct)}</span>
    </div>
  );
}

function Compare({ runs }: { runs: RunMeta[] }) {
  const [aId, setA] = useState(runs[1]?.runId ?? runs[0]?.runId ?? "");
  const [bId, setB] = useState(runs[0]?.runId ?? "");
  const a = runs.find((r) => r.runId === aId);
  const b = runs.find((r) => r.runId === bId);
  const cmpOptions = useMemo(
    () => runs.map((r) => ({ value: r.runId, label: runTitle(r), sub: r.runId.slice(-6) })),
    [runs],
  );

  return (
    <div className="acard">
      <div className="ahd">
        <h3>Compare</h3>
        <span className="seln">A ↔ B</span>
      </div>
      <div className="cmp-pickers">
        <Combo value={aId} onChange={setA} width="100%" options={cmpOptions} ariaLabel="Compare — run A" />
        <Combo value={bId} onChange={setB} width="100%" options={cmpOptions} ariaLabel="Compare — run B" />
      </div>
      {a && b && (
        <div className="deltas">
          {deltaRow("cost", a.costUsd, b.costUsd, formatCost)}
          {deltaRow("duration", durationMs(a), durationMs(b), formatDuration)}
          {deltaRow("events", a.events, b.events, (n) => String(n), false)}
          {deltaRow("agents", a.agents.length, b.agents.length, (n) => String(n), false)}
          {deltaRow("errors", a.errors, b.errors, (n) => String(n))}
        </div>
      )}
    </div>
  );
}

function Outcomes({ o }: { o: Analytics["outcomes"] }) {
  const total = Math.max(1, o.pass + o.fail + o.open);
  const parts = [
    { k: "pass", v: o.pass, c: "var(--ok)" },
    { k: "fail", v: o.fail, c: "var(--err)" },
    { k: "open", v: o.open, c: "var(--t3)" },
  ];
  return (
    <div className="acard">
      <div className="ahd">
        <h3>Outcomes</h3>
        <span className="seln mono">{o.pass + o.fail} scored</span>
      </div>
      <div className="ocbody">
        <div className="ocbar">
          {parts.map((p) => p.v > 0 && <i key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: p.c }} title={`${p.k}: ${p.v}`} />)}
        </div>
        <div className="oclegend">
          {parts.map((p) => (
            <span key={p.k}>
              <i style={{ background: p.c }} /> {p.k} <b className="mono">{p.v}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Projects({ projects }: { projects: Analytics["projects"] }) {
  const maxCost = Math.max(0.0001, ...projects.map((p) => p.costUsd));
  return (
    <div className="acard">
      <div className="ahd">
        <h3>By project</h3>
        <span className="seln">{projects.length}</span>
      </div>
      <div className="projtbl">
        {projects.slice(0, 8).map((p) => (
          <div
            className="projr"
            key={p.project}
            title={`${p.project} · ${formatCost(p.costUsd)} · ${p.runs} run${p.runs === 1 ? "" : "s"}${p.scored ? ` · ${Math.round((p.passed / p.scored) * 100)}% pass` : ""}`}
          >
            <span className="pn">{p.project}</span>
            <span className="ptrack">
              <i style={{ width: `${(p.costUsd / maxCost) * 100}%` }} />
            </span>
            <span className="pc mono">{formatCost(p.costUsd)}</span>
            <span className="pr mono">{p.runs} run{p.runs === 1 ? "" : "s"}</span>
            <span className="pp mono">{p.scored ? `${Math.round((p.passed / p.scored) * 100)}%` : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Models({ models }: { models: Analytics["models"] }) {
  if (!models.length) return null;
  const total = Math.max(0.0001, models.reduce((s, m) => s + m.costUsd, 0));
  const maxCost = Math.max(0.0001, ...models.map((m) => m.costUsd));
  return (
    <div className="acard">
      <div className="ahd">
        <h3>Spend by model</h3>
        <span className="seln mono">{formatCost(total)}</span>
      </div>
      <div className="projtbl">
        {models.slice(0, 8).map((m) => (
          <div
            className="projr"
            key={m.model}
            title={`${m.model} · ${formatCost(m.costUsd)} · ${Math.round((m.costUsd / total) * 100)}% of spend · ${m.runs} run${m.runs === 1 ? "" : "s"}`}
          >
            <span className="pn mono">{m.model}</span>
            <span className="ptrack">
              <i style={{ width: `${(m.costUsd / maxCost) * 100}%` }} />
            </span>
            <span className="pc mono">{formatCost(m.costUsd)}</span>
            <span className="pr mono">{m.runs} run{m.runs === 1 ? "" : "s"}</span>
            <span className="pp mono">{Math.round((m.costUsd / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Scored history: per-evaluator pass-rate + score-trend across the indexed runs
// (automated heuristic evaluators — see derive/evals.ts).
function Evals({ runs }: { runs: RunMeta[] }) {
  const cfg = useObs((s) => s.evalConfig);
  // runs arrive newest-first; trends read oldest → newest
  const rows = useMemo(() => evalTrends([...runs].reverse(), cfg), [runs, cfg]);
  if (!rows.length) return null;
  const color = (p: number) => (p >= 0.999 ? "var(--ok)" : p >= 0.5 ? "var(--warn)" : "var(--err)");
  return (
    <div className="acard">
      <div className="ahd">
        <h3>Evaluators</h3>
        <span className="seln mono">{runs.length} runs · trend · pass-rate</span>
      </div>
      <div className="evaltbl">
        {rows.map((r) => (
          <div className="evalr" key={r.id}>
            <span className="pn">{r.label}</span>
            <Spark values={r.scores} color={color(r.passRate)} />
            <span className="pp mono">{Math.round(r.passRate * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type TopMetric = "cost" | "duration" | "tokens" | "errors";
const TOP_METRICS: TopMetric[] = ["cost", "duration", "tokens", "errors"];

function TopRuns({ runs, onOpen }: { runs: RunMeta[]; onOpen: (id: string) => void }) {
  const [metric, setMetric] = useState<TopMetric>("cost");
  const val = (r: RunMeta) =>
    metric === "cost" ? r.costUsd : metric === "duration" ? durationMs(r) : metric === "tokens" ? r.tokens ?? 0 : r.errors;
  const fmt = (r: RunMeta) =>
    metric === "cost"
      ? formatCost(r.costUsd)
      : metric === "duration"
        ? formatDuration(durationMs(r))
        : metric === "tokens"
          ? formatTokens(r.tokens ?? 0)
          : String(r.errors);
  const sorted = [...runs].sort((a, b) => val(b) - val(a)).slice(0, 8);
  const max = Math.max(0.0001, ...sorted.map(val));

  return (
    <div className="acard">
      <div className="ahd">
        <h3>Top runs</h3>
        <span className="segtoggle">
          {TOP_METRICS.map((m) => (
            <button key={m} className={`stog ${metric === m ? "on" : ""}`} onClick={() => setMetric(m)}>
              {m}
            </button>
          ))}
        </span>
      </div>
      <div className="toptbl">
        {sorted.map((r) => (
          <button className="topr" key={r.runId} onClick={() => onOpen(r.runId)} title={`${runTitle(r)} · ${fmt(r)}`}>
            <StatusChip status={statusOf(r)} />
            <span className="tn">{runTitle(r)}</span>
            <span className="ttrack">
              <i style={{ width: `${(val(r) / max) * 100}%` }} />
            </span>
            <span className="tv mono">{fmt(r)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AnalyticsView() {
  const runsQ = useRuns();
  const selectRun = useObs((s) => s.selectRun);
  const setSegment = useObs((s) => s.setSegment);
  const openRun = (id: string) => {
    selectRun(id);
    setSegment("runs");
  };
  const runs = useMemo(() => [...(runsQ.data ?? [])].sort((a, b) => b.lastTs - a.lastTs), [runsQ.data]);
  const a = useMemo(() => collectAnalytics(runs), [runs]);
  const series = useMemo(() => buildSeries(runs), [runs]);
  const seriesLabels = useMemo(() => series.map((p) => p.label), [series]);

  if (runsQ.isLoading) return <TabSkeleton rows={8} label="Loading analytics…" />;
  if (!runs.length) return <div className="tab-empty">No runs indexed yet.</div>;

  const totalErrors = runs.reduce((s, r) => s + r.errors, 0);

  return (
    <div className="metrics">
      <div className="m-head">
        <span className="m-mark">
          <i className="m-pulse" />
          Metrics
        </span>
        <span className="m-sub mono">telemetry · {runs.length} runs</span>
      </div>

      <div className="hero-band">
        <HeadlineTrend series={series} a={a} />
        <div className="kpi-rail">
          <KpiTrend label="cost" value={formatCost(a.totalCost)} values={series.map((p) => p.costUsd)} color="#7c6cf2" labels={seriesLabels} fmt={formatCost} />
          <KpiTrend label="tokens" value={formatTokens(a.totalTokens)} values={series.map((p) => p.tokens)} color="#4cc9f0" labels={seriesLabels} fmt={formatTokens} />
          <KpiTrend label="errors" value={totalErrors.toLocaleString()} values={series.map((p) => p.errors)} color="#fb7185" labels={seriesLabels} fmt={(v) => `${Math.round(v)} err`} />
          {/* "error rate" invited reading this as a FAIL rate — it's the share
              of runs that hit ≥1 error, which a run can do and still pass */}
          <KpiTrend
            label="runs w/ errors"
            value={`${a.errRuns} of ${a.totalRuns}`}
            values={series.map((p) => (p.runs ? (p.errRuns / p.runs) * 100 : 0))}
            color="#fb7185"
            labels={seriesLabels}
            fmt={(v) => `${v.toFixed(0)}%`}
          />
        </div>
      </div>

      {/* short cards grouped so the row height is uniform (no stretched gaps) */}
      <div className="astatrow">
        <Outcomes o={a.outcomes} />
        <Evals runs={runs} />
        <Projects projects={a.projects} />
        <Models models={a.models} />
      </div>

      {/* taller list/compare cards grouped together */}
      <div className="astatrow">
        <TopRuns runs={runs} onOpen={openRun} />
        <Compare runs={runs} />
        <div className="acard">
          <div className="ahd">
            <h3>Run history</h3>
            <span className="seln">{runs.length} runs</span>
          </div>
          <div className="histtbl">
            {runs.slice(0, 60).map((r) => (
              <button className="histr" key={r.runId} onClick={() => openRun(r.runId)}>
                <StatusChip status={statusOf(r)} />
                <span className="hn">{runTitle(r)}</span>
                <span className="hc mono">{formatCost(r.costUsd)}</span>
                <span className="hd mono">{formatDuration(durationMs(r))}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
