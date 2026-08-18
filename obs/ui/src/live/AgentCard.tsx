import type { CSSProperties } from "react";
import type { Lane } from "../data/store";
import { laneStalledMs, type LaneRollup } from "../data/derive/laneRollup";
import { eventMeta } from "../runs/eventMeta";
import { agentColor, formatCost, formatDuration, formatTokens } from "../lib/format";
import { Icon } from "../lib/Icon";

export function AgentCard({ lane, roll, now, runId }: { lane: Lane; roll: LaneRollup; now: number; runId?: string }) {
  const r = roll;
  const stalled = laneStalledMs(r, now);
  const state = stalled ? "stall" : r.active && !r.ended ? "runn" : "done";
  const feed = lane.events.slice(-4);
  // a stable colour per run, so same-run agents share a left accent + pill colour
  const runC = runId ? agentColor(runId) : 0;
  const runStyle = runC ? ({ "--run": `var(--a${runC})` } as CSSProperties) : undefined;

  return (
    <div className={`lcard ${state}${runC ? " runaccent" : ""}`} style={runStyle}>
      <div className="chead">
        <span className={`dot ${stalled ? "w" : r.active && !r.ended ? "on" : ""}`} />
        <span className="cname">{r.agent}</span>
        {runId && <span className="crun" title={runId}>{runId}</span>}
        <span className="cmodel">{r.model ?? ""}</span>
        <span className="cmeter">
          {r.ctxPct != null ? `ctx ${r.ctxPct}%` : r.ended ? "done" : "live"}
          {r.ctxPct != null && (
            <span className="meter">
              <i className={r.ctxPct > 75 ? "w" : ""} style={{ width: `${Math.min(100, r.ctxPct)}%` }} />
            </span>
          )}
        </span>
      </div>
      <div className="cfeed">
        {feed.map((ev) => {
          const m = eventMeta(ev);
          return (
            <div className="frow" key={`${ev.sessionId}:${ev.seq}`}>
              <span className="ts">{new Date(ev.ts).toLocaleTimeString()}</span>
              <span className={`badge ${m.badgeClass}`}>{m.badge}</span>
              <span className="d">{m.text}</span>
            </div>
          );
        })}
      </div>
      <div className="cfoot">
        <span>
          <b>{formatCost(r.costUsd)}</b> cost
        </span>
        <span>
          <b>{formatTokens(r.tokens)}</b> tok
        </span>
        <span>
          <b>{r.toolCalls}</b> tools
        </span>
        <span>
          <b>{r.turns}</b> turns
        </span>
        {stalled > 0 && (
          <span className="stallchip">
            <Icon name="alert" size={11} /> stalled {formatDuration(stalled)}
          </span>
        )}
      </div>
    </div>
  );
}
