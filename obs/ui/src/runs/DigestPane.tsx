import { useDigest, useExplain, useVerdict } from "../data/queries";
import { useObs } from "../data/store";
import type { Anomaly, AnomalyKind, RunDigest } from "../data/types";
import { Icon } from "../lib/Icon";
import { Skel } from "../lib/Skeleton";
import { renderMarkdown } from "../chat/markdown";
import { formatCost, formatDuration, formatTokens } from "../lib/format";
import "./digest.css";

const ICON: Record<AnomalyKind, Parameters<typeof Icon>[0]["name"]> = {
  retry: "retry",
  "dispatch-error": "x",
  truncated: "alert",
  "tool-error": "x",
  "provider-error": "x",
  "slow-tool": "clock",
  "slow-turn": "clock",
  "cost-outlier": "spark",
  compaction: "gauge",
  context: "gauge",
};
function severity(k: AnomalyKind): "e" | "w" | "i" {
  if (k === "tool-error" || k === "provider-error" || k === "dispatch-error" || k === "truncated") return "e";
  if (k === "context") return "i";
  return "w";
}

function narrative(d: RunDigest): string {
  const top = [...d.agents].sort((a, b) => b.costUsd - a.costUsd)[0];
  const parts: string[] = [];
  parts.push(
    `${d.agents.length} agent${d.agents.length === 1 ? "" : "s"} over ${formatDuration(d.wallMs)}, ${formatCost(
      d.totals.costUsd,
    )} and ${formatTokens(d.totals.tokens.total)} tokens across ${d.totals.turns} turns.`,
  );
  if (top && top.costUsd > 0)
    parts.push(`${top.agent} dominates spend (${formatCost(top.costUsd)}).`);
  if (d.totals.toolErrors || d.totals.providerErrors)
    parts.push(`${d.totals.toolErrors + d.totals.providerErrors} error(s) seen.`);
  if (d.totals.retries) parts.push(`${d.totals.retries} retr${d.totals.retries === 1 ? "y" : "ies"}.`);
  if (!d.anomalies.length) parts.push("No anomalies flagged.");
  return parts.join(" ");
}

export function DigestPane({ runId }: { runId: string | null }) {
  const digestQ = useDigest(runId);
  const verdict = useVerdict(runId);
  const d = digestQ.data;
  const current = d?.verdict?.status;
  // an auto-scored verdict (source "auto") is a suggestion — shown dashed until
  // a human confirms; a manual score locks the button solid.
  const isAuto = d?.verdict?.source === "auto";
  const manual = isAuto ? undefined : current;

  // AI summary — only fires after the hero's Explain button is clicked
  const explainRunId = useObs((s) => s.explainRunId);
  const requested = !!runId && explainRunId === runId;
  const explainQ = useExplain(runId, requested);
  const ex = explainQ.data;

  return (
    <div className="pane dright">
      <div className="dhd">
        <span className="gem2" />
        <h3>Run digest</h3>
        <span className="sub">/api · digest</span>
      </div>
      <div className="dbody">
        {requested && (
          <div className="ai-card">
            <div className="ai-h">
              <Icon name="spark" size={12} /> AI summary
              {ex?.enabled && ex.model && (
                <span className="ai-model">
                  · {ex.model}
                  {ex.cached ? " · cached" : ""}
                </span>
              )}
            </div>
            {explainQ.isLoading && <p className="ai-loading">Generating</p>}
            {explainQ.isError && <p className="ai-err">Couldn't reach the server.</p>}
            {ex?.error && <p className="ai-err">{ex.error}</p>}
            {ex && ex.enabled === false && (
              <p className="ai-off">{ex.hint || "AI summaries are off. Set PI_OBS_LLM=1 on the server."}</p>
            )}
            {ex?.enabled && ex.narrative && (
              <>
                {/* LLM output — rendered as markdown (same renderer as chat) so
                    **bold**, `code`, and lists don't show as literal syntax */}
                <div className="ai-narr chmd" dangerouslySetInnerHTML={{ __html: renderMarkdown(ex.narrative) }} />
                {ex.recommendations && ex.recommendations.length > 0 && (
                  <ul className="ai-recs">
                    {ex.recommendations.map((r, i) => (
                      <li key={i} className="chmd" dangerouslySetInnerHTML={{ __html: renderMarkdown(r) }} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        {!runId && <p className="dsum">Select a run to see its digest.</p>}
        {runId && digestQ.isLoading && (
          <div className="dsum" role="status" aria-label="Building digest…" style={{ display: "grid", gap: 8 }}>
            <Skel w="92%" h={11} />
            <Skel w="78%" h={11} />
            <Skel w="85%" h={11} />
          </div>
        )}
        {d && (
          <>
            <p className="dsum">{narrative(d)}</p>
            {d.anomalies.map((a: Anomaly, i) => (
              <div className="anom" key={i}>
                <div className={`ah ${severity(a.kind)}`}>
                  <Icon name={ICON[a.kind] ?? "alert"} size={12} />
                  {a.kind.replace("-", " ")}
                </div>
                <p>
                  {a.agent && <code>{a.agent}</code>} {a.detail}
                </p>
              </div>
            ))}
          </>
        )}
      </div>
      {verdict.isError && (
        <p className="verr" role="alert">
          Score failed — {(verdict.error as Error)?.message || "server unreachable"}
        </p>
      )}
      <div className="score2">
        <button
          className={`sc p ${manual === "pass" ? "on" : ""} ${isAuto && current === "pass" ? "auto" : ""}`}
          disabled={!runId || verdict.isPending}
          onClick={() => verdict.mutate({ status: "pass" })}
        >
          <Icon name="check" size={13} /> pass
        </button>
        <button
          className={`sc f ${manual === "fail" ? "on" : ""} ${isAuto && current === "fail" ? "auto" : ""}`}
          disabled={!runId || verdict.isPending}
          onClick={() => verdict.mutate({ status: "fail" })}
        >
          <Icon name="x" size={13} /> fail
        </button>
      </div>
    </div>
  );
}
