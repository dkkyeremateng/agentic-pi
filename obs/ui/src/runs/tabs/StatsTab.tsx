import { useMemo, useState } from "react";
import { useDigest } from "../../data/queries";
import { AgentFilter, useAgentScope, type ScopeOption } from "../AgentFilter";
import { useObs } from "../../data/store";
import { agentColor, formatCost, formatCostPrecise, formatDuration, formatTokens } from "../../lib/format";
import type { AgentDigest, RunDigest, ToolDigest } from "../../data/types";
import "../../analytics/analytics.css";
import { TabSkeleton } from "../../lib/Skeleton";
import "./tabs.css";

function Kpi({ k, v, sub, warn }: { k: string; v: string; sub?: string; warn?: boolean }) {
  return (
    <div className="mkpi">
      <div className="k">{k}</div>
      <div className="v" style={warn ? { color: "var(--err)" } : undefined}>{v}</div>
      {sub && <div className="d flat">{sub}</div>}
    </div>
  );
}

// horizontal share bar: each agent's slice of a metric, coloured by agent.
// `highlight` dims the others rather than filtering them out — a share chart
// IS the comparison, so cutting it to one row would destroy the point.
function ShareBar({
  rows,
  total,
  highlight,
}: {
  rows: { key: string; label: string; value: number; fmt: string }[];
  total: number;
  highlight?: string;
}) {
  return (
    <div className="shbars">
      {rows.map((r) => {
        const pct = total > 0 ? (r.value / total) * 100 : 0;
        return (
          <div className={`shbar ${highlight && highlight !== r.key ? "dim" : ""}`} key={r.key}>
            <span className="shbl">{r.label}</span>
            <span className="shtrack">
              <i className={`a${agentColor(r.key)}`} style={{ width: `${Math.max(1.5, pct)}%` }} />
            </span>
            <span className="shbv mono">{r.fmt}</span>
          </div>
        );
      })}
    </div>
  );
}

type AgentSort = "cost" | "tokens" | "turns" | "toolCalls" | "errors";
const AGENT_METRIC: Record<AgentSort, (a: AgentDigest) => number> = {
  cost: (a) => a.costUsd,
  tokens: (a) => a.tokens,
  turns: (a) => a.turns,
  toolCalls: (a) => a.toolCalls,
  errors: (a) => a.toolErrors + a.errors,
};

function AgentTable({ agents }: { agents: AgentDigest[] }) {
  const [sort, setSort] = useState<AgentSort>("cost");
  const metric = AGENT_METRIC[sort];
  const rows = [...agents].sort((a, b) => metric(b) - metric(a));
  const H = (k: AgentSort, label: string) => (
    <button className={`sh ${sort === k ? "on" : ""}`} onClick={() => setSort(k)}>
      {label}
    </button>
  );
  return (
    <div className="stbl">
      <div className="sthead ag">
        <span>agent</span>
        <span>model</span>
        {H("turns", "turns")}
        {H("tokens", "tokens")}
        {H("cost", "cost")}
        {H("toolCalls", "tools")}
        {H("errors", "err")}
        <span>ctx</span>
        <span>avg turn</span>
      </div>
      {rows.map((a) => (
        <div className="strow ag" key={a.agent}>
          <span className="snm">
            <i className={`adot a${agentColor(a.agent)}`} />
            {a.agent}
            {a.instances > 1 && <em className="ix">×{a.instances}</em>}
          </span>
          <span className="smodel mono">{a.model ?? "—"}</span>
          <span className="mono">{a.turns}</span>
          <span className="mono">{formatTokens(a.tokens)}</span>
          <span className="mono">{formatCostPrecise(a.costUsd)}</span>
          <span className="mono">{a.toolCalls}</span>
          <span className={`mono ${a.toolErrors + a.errors > 0 ? "bad" : ""}`}>{a.toolErrors + a.errors}</span>
          <span className="mono">{a.maxContextPct != null ? `${Math.round(a.maxContextPct)}%` : "—"}</span>
          <span className="mono">{a.turns ? formatDuration(a.turnMs / a.turns) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

function ToolTable({ tools }: { tools: ToolDigest[] }) {
  const rows = [...tools].sort((a, b) => b.calls - a.calls);
  return (
    <div className="stbl">
      <div className="sthead tl">
        <span>tool</span>
        <span>calls</span>
        <span>avg ms</span>
        <span>total</span>
        <span>err</span>
      </div>
      {rows.map((t) => (
        <div className="strow tl" key={t.tool}>
          <span className="snm">{t.tool}</span>
          <span className="mono">{t.calls}</span>
          <span className="mono">{t.calls ? Math.round(t.totalMs / t.calls) : 0}</span>
          <span className="mono">{formatDuration(t.totalMs)}</span>
          <span className={`mono ${t.errors > 0 ? "bad" : ""}`}>{t.errors}</span>
        </div>
      ))}
    </div>
  );
}

function TokenBar({ tk }: { tk: RunDigest["totals"]["tokens"] }) {
  const parts = [
    { k: "input", v: tk.input, c: "var(--a1)" },
    { k: "output", v: tk.output, c: "var(--a2)" },
    { k: "cache read", v: tk.cacheRead, c: "var(--a3)" },
    { k: "cache write", v: tk.cacheWrite, c: "var(--a4)" },
  ];
  const total = Math.max(1, tk.input + tk.output + tk.cacheRead + tk.cacheWrite);
  return (
    <>
      <div className="tokbar">
        {parts.map((p) => p.v > 0 && <i key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: p.c }} title={`${p.k}: ${formatTokens(p.v)}`} />)}
      </div>
      <div className="toklegend">
        {parts.map((p) => (
          <span key={p.k}>
            <i style={{ background: p.c }} /> {p.k} <b className="mono">{formatTokens(p.v)}</b>
          </span>
        ))}
      </div>
    </>
  );
}

export function StatsTab({ runId }: { runId: string }) {
  const dq = useDigest(runId);
  const d = dq.data;
  // The digest carries per-agent aggregates, so the picker needs no event
  // stream — count by turns, the digest's own unit of agent activity.
  //
  // Role-level only: the digest folds every instance of a role into one
  // AgentDigest (it keeps a count in `instances`, not a per-session split), so
  // there is nothing here to scope an instance to. A pick made on another tab
  // still lands — resolveScope degrades a session to its role — and the header
  // says which instances are being summed so the numbers aren't misread.
  const scopes = useMemo<ScopeOption[]>(
    () =>
      (d?.agents ?? [])
        .map((a) => ({
          value: a.agent,
          agent: a.agent,
          sessionId: "",
          label: a.instances > 1 ? `${a.agent} · all ${a.instances}` : a.agent,
          count: a.turns,
        }))
        .sort((x, y) => y.count - x.count),
    [d],
  );
  const scope = useAgentScope(scopes);
  const one = scope ? d?.agents.find((a) => a.agent === scope.agent) ?? null : null;
  const pinnedSession = useObs((s) => s.runAgentSession);

  if (dq.isLoading) return <TabSkeleton label="Building stats…" />;
  if (!d) return <div className="tab-empty">No stats recorded for this run yet.</div>;

  const t = d.totals;
  const errors = one ? one.toolErrors + one.errors : t.toolErrors + t.providerErrors;
  const costRows = d.agents
    .filter((a) => a.costUsd > 0)
    .map((a) => ({ key: a.agent, label: a.agent, value: a.costUsd, fmt: formatCostPrecise(a.costUsd) }));
  // Panels the digest can't break down per agent stay run-wide rather than
  // silently reporting run numbers under an agent's name:
  //   · token input/output/cache split — AgentDigest.tokens is a single total
  //   · tools — ToolDigest has no agent field
  //   · retries — only in run totals
  const runWide = one ? <span className="seln dim">run-wide</span> : null;

  return (
    <div className="statwrap">
      {scopes.length > 1 && (
        <div className="stbar">
          <AgentFilter options={scopes} width={190} />
          <span className="seln">
            {one
              ? one.instances > 1
                ? `${one.agent} — all ${one.instances} instances summed${pinnedSession ? " (the digest has no per-instance split)" : ""}`
                : `scoped to ${one.agent}`
              : `${scopes.length} agents`}
          </span>
        </div>
      )}
      <div className="mstrip">
        {one ? (
          <Kpi k="turn time" v={formatDuration(one.turnMs)} sub="this agent" />
        ) : (
          <Kpi k="wall time" v={formatDuration(d.wallMs)} />
        )}
        <Kpi k="cost" v={formatCost(one ? one.costUsd : t.costUsd)} />
        <Kpi
          k="tokens"
          v={formatTokens(one ? one.tokens : t.tokens.total)}
          sub={one ? undefined : `${formatTokens(t.tokens.cacheRead)} cached`}
        />
        <Kpi k="turns" v={String(one ? one.turns : t.turns)} />
        <Kpi
          k="tool calls"
          v={String(one ? one.toolCalls : t.toolCalls)}
          sub={(one ? one.toolErrors : t.toolErrors) ? `${one ? one.toolErrors : t.toolErrors} failed` : undefined}
        />
        <Kpi k="errors" v={String(errors)} warn={errors > 0} />
        {!one && <Kpi k="retries" v={String(t.retries)} warn={t.retries > 0} />}
        <Kpi k="compactions" v={String(one ? one.compactions : t.compactions)} />
      </div>

      <div className="stcards">
        <div className="acard">
          <div className="ahd">
            <h3>Tokens</h3>
            {runWide}
            <span className="seln mono">{formatTokens(t.tokens.total)} total</span>
          </div>
          <div className="cbody">
            <TokenBar tk={t.tokens} />
          </div>
        </div>

        <div className="acard">
          <div className="ahd">
            <h3>Cost by agent</h3>
            {runWide}
            <span className="seln mono">{formatCost(t.costUsd)}</span>
          </div>
          <div className="cbody">
            {costRows.length ? (
              <ShareBar rows={costRows} total={t.costUsd} highlight={scope?.agent} />
            ) : (
              <div className="tab-empty small">No spend recorded.</div>
            )}
          </div>
        </div>
      </div>

      <div className="acard">
        <div className="ahd">
          <h3>Agents</h3>
          <span className="seln">{one ? `1 of ${d.agents.length}` : d.agents.length}</span>
        </div>
        <AgentTable agents={one ? [one] : d.agents} />
      </div>

      {d.tools.length > 0 && (
        <div className="acard">
          <div className="ahd">
            <h3>Tools</h3>
            {runWide}
            <span className="seln">{d.tools.length}</span>
          </div>
          <ToolTable tools={d.tools} />
        </div>
      )}

      {d.models.length > 0 && (
        <div className="modelrow">
          <span className="mk">models</span>
          {d.models.map((m) => (
            <span className="mchip mono" key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}
