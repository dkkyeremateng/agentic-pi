import { useState } from "react";
import { useRun, useJudge } from "../../data/queries";
import { useObs } from "../../data/store";
import { evaluateRun, overallScore } from "../../data/derive/evals";
import type { EvalLevel } from "../../data/derive/evals";
import { Icon } from "../../lib/Icon";
import { Stepper } from "../../lib/Stepper";
import { TabSkeleton } from "../../lib/Skeleton";
import "./tabs.css";

// 0..100 → level, matching the heuristic thresholds (pass ≥80, warn ≥50).
function levelOf(score100: number): EvalLevel {
  return score100 >= 80 ? "pass" : score100 >= 50 ? "warn" : "fail";
}

export function EvalsTab({ runId }: { runId: string }) {
  const runQ = useRun(runId);
  const run = runQ.data;
  const cfg = useObs((s) => s.evalConfig);
  const setEvalConfig = useObs((s) => s.setEvalConfig);
  const [judgeRequested, setJudgeRequested] = useState(false);
  const judgeQ = useJudge(runId, judgeRequested);
  const j = judgeQ.data;
  // The other tabs scope to one agent; these evaluators can't. They score the
  // run as a whole from run-level telemetry (RunMeta: total cost, the run's
  // active makespan, total tool calls, total errors) — there is no per-agent
  // equivalent to narrow to, and reusing an agent's turn time as "latency"
  // would answer a different question under the same label. Say so instead of
  // letting the picker look broken here. Per-agent judgement already exists:
  // the Trace tab scores the selected agent's span.
  const agentScope = useObs((s) => s.runAgentFilter);

  if (!run) return runQ.isLoading ? <TabSkeleton label="Loading evaluators…" /> : <div className="tab-empty">No run data.</div>;

  const results = evaluateRun(run, cfg);
  const overall = overallScore(results);

  return (
    <div className="evalp">
      <div className="evalhd">
        <span className="t">Evaluators</span>
        <span className={`evalscore ${overall.level}`}>
          {Math.round(overall.score * 100)}
          <i>/100</i>
        </span>
        <span className="seln">heuristic · auto</span>
      </div>
      {agentScope && (
        <p className="evalscope">
          Scoring the whole run — these checks read run-level totals, so the <b>{agentScope}</b> scope doesn't
          narrow them. For one agent's verdict, open <b>Trace</b> and select its span.
        </p>
      )}
      <div className="evalcfg" title="Budgets — saved across sessions, applied to every run">
        <Stepper
          label="cost"
          prefix="$"
          min={0}
          step={0.5}
          value={cfg.costBudgetUsd}
          onChange={(n) => setEvalConfig({ costBudgetUsd: n })}
        />
        <Stepper
          label="max min"
          min={1}
          step={1}
          value={Math.round(cfg.maxDurationMs / 60_000)}
          onChange={(n) => setEvalConfig({ maxDurationMs: n * 60_000 })}
        />
        <Stepper
          label="max tools"
          min={1}
          step={5}
          value={cfg.maxToolCalls}
          onChange={(n) => setEvalConfig({ maxToolCalls: n })}
        />
      </div>
      <div className="evalbody">
        {results.map((r) => (
          <div className={`evalcard ${r.level}`} key={r.id}>
            <div className="evalcard-h">
              <span className={`evchip ${r.level}`}>{r.level}</span>
              <span className="evlabel">{r.label}</span>
              <span className="evval mono">{r.value}</span>
              <span className="evscore mono">{Math.round(r.score * 100)}</span>
            </div>
            <div className="evtrack">
              <i className={r.level} style={{ width: `${r.score * 100}%` }} />
            </div>
            <p className="evreason">{r.reason}</p>
          </div>
        ))}
      </div>

      {/* LLM-as-judge — on-demand (one LLM call), opt-in via PI_OBS_LLM on the server */}
      <div className="judgehd">
        <span className="t">
          <Icon name="spark" size={12} /> LLM-as-judge
        </span>
        {j?.enabled && j.model && (
          <span className="seln mono">
            {j.model}
            {j.cached ? " · cached" : ""}
          </span>
        )}
        {j?.enabled && typeof j.score === "number" && (
          <span className={`evalscore ${levelOf(j.score)}`}>
            {j.score}
            <i>/100</i>
          </span>
        )}
        {!judgeRequested && (
          <button className="judgebtn" onClick={() => setJudgeRequested(true)}>
            <Icon name="spark" size={11} /> Run AI judge
          </button>
        )}
      </div>
      <div className="judgebody">
        {judgeRequested && judgeQ.isLoading && <p className="judgenote">Scoring the run…</p>}
        {judgeQ.isError && <p className="judgenote err">Couldn't reach the server.</p>}
        {j?.error && <p className="judgenote err">{j.error}</p>}
        {j && j.enabled === false && (
          <p className="judgenote">{j.hint || "AI judge is off. Set PI_OBS_LLM=1 on the server."}</p>
        )}
        {j?.enabled && j.reason && <p className="judgesum">{j.reason}</p>}
        {j?.enabled && j.criteria && j.criteria.length > 0 && (
          <div className="evalbody nogrow">
            {j.criteria.map((c) => {
              const lvl = levelOf(c.score);
              return (
                <div className={`evalcard ${lvl}`} key={c.name}>
                  <div className="evalcard-h">
                    <span className={`evchip ${lvl}`}>{lvl}</span>
                    <span className="evlabel">{c.name.replace(/_/g, " ")}</span>
                    <span className="evscore mono">{c.score}</span>
                  </div>
                  <div className="evtrack">
                    <i className={lvl} style={{ width: `${c.score}%` }} />
                  </div>
                  <p className="evreason">{c.reason}</p>
                </div>
              );
            })}
          </div>
        )}
        {!judgeRequested && (
          <p className="judgenote">An LLM scores this run on goal completion, efficiency, and error handling.</p>
        )}
      </div>
    </div>
  );
}
