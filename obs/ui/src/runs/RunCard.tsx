import type { RunMeta } from "../data/types";
import { StatusChip } from "../lib/Chip";
import { agentColor, formatCost, formatDuration, formatTokens, formatWhen } from "../lib/format";
import { durationMs, runTitle, statusOf } from "./runUtils";

export function RunCard({
  run,
  selected,
  active,
  onSelect,
}: {
  run: RunMeta;
  selected: boolean;
  active?: boolean; // the pi session is still open (from the live-sessions registry)
  onSelect: () => void;
}) {
  // an open session reads as "live" on the card, matching the Active filter even
  // when the agent has been idle longer than the loose recent-activity window
  const status = active ? "live" : statusOf(run);
  return (
    <button className={`run ${selected ? "sel" : ""}`} onClick={onSelect}>
      <div className="r1">
        <span className="rname">{runTitle(run)}</span>
        <StatusChip status={status} />
      </div>
      <div className="r2">
        <span className="avs">
          {run.agents.slice(0, 5).map((a, i) => (
            <i key={a + i} className={`av a${agentColor(a)}`} />
          ))}
        </span>
        {run.errors > 0 && <span className="rerr">{run.errors} err</span>}
        <span className="rwhen" title={new Date(run.firstTs).toLocaleString()}>
          {formatWhen(run.firstTs)}
        </span>
        <span className="rcd">
          {formatCost(run.costUsd)} · {formatTokens(run.tokens ?? 0)} · {formatDuration(durationMs(run))}
        </span>
      </div>
    </button>
  );
}
