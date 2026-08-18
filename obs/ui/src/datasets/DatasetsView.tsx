import { useMemo, useRef, useState } from "react";
import { useRuns } from "../data/queries";
import { useObs } from "../data/store";
import type { RunMeta } from "../data/types";
import { evaluateRun, overallScore, evalTrends } from "../data/derive/evals";
import { runTitle, statusOf } from "../runs/runUtils";
import { StatusChip } from "../lib/Chip";
import { Spark } from "../lib/Spark";
import { Icon } from "../lib/Icon";
import { EmptyState } from "../lib/EmptyState";
import { formatCost } from "../lib/format";
import "./datasets.css";

const scoreColor = (s: number) => (s >= 0.8 ? "var(--ok)" : s >= 0.5 ? "var(--warn)" : "var(--err)");

export function DatasetsView() {
  const runsQ = useRuns();
  const datasets = useObs((s) => s.datasets);
  const selectedId = useObs((s) => s.selectedDatasetId);
  const selectDataset = useObs((s) => s.selectDataset);
  const createDataset = useObs((s) => s.createDataset);
  const deleteDataset = useObs((s) => s.deleteDataset);
  const toggleRunInDataset = useObs((s) => s.toggleRunInDataset);
  const selectRun = useObs((s) => s.selectRun);
  const setSegment = useObs((s) => s.setSegment);
  const cfg = useObs((s) => s.evalConfig);
  const [newName, setNewName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const runMap = useMemo(() => new Map((runsQ.data ?? []).map((r) => [r.runId, r])), [runsQ.data]);
  const selected = datasets.find((d) => d.id === selectedId) ?? datasets[0] ?? null;

  // member runs resolvable from the index, oldest → newest (for the trend)
  const members = useMemo<RunMeta[]>(() => {
    if (!selected) return [];
    return selected.runIds.map((id) => runMap.get(id)).filter((r): r is RunMeta => !!r).sort((a, b) => a.firstTs - b.firstTs);
  }, [selected, runMap]);

  const trends = useMemo(() => evalTrends(members, cfg), [members, cfg]);
  const datasetScore = useMemo(() => {
    if (!members.length) return 0;
    return members.reduce((s, r) => s + overallScore(evaluateRun(r, cfg)).score, 0) / members.length;
  }, [members, cfg]);

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    createDataset(name);
    setNewName("");
  };

  return (
    <div className="dscols">
      <div className="dspane">
        <div className="px ph">
          <h2>Datasets</h2>
          <span className="count">{datasets.length}</span>
        </div>
        <div className="dsnew">
          <input
            ref={nameRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="New set name…"
            aria-label="New dataset name"
          />
          <button onClick={create} disabled={!newName.trim()}>
            add
          </button>
        </div>
        <div className="dslist">
          {datasets.length === 0 && <div className="empty">No sets yet. Create one, then add runs from a run's header.</div>}
          {datasets.map((d) => (
            <button
              key={d.id}
              className={`dsitem ${selected?.id === d.id ? "on" : ""}`}
              onClick={() => selectDataset(d.id)}
            >
              <span className="dsn">{d.name}</span>
              <span className="dsc mono">{d.runIds.length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dsmain">
        {!selected ? (
          <EmptyState
            icon="layers"
            title={datasets.length ? "No dataset selected" : "No datasets yet"}
            hint={
              datasets.length
                ? "Pick a set on the left to see its runs and aggregate evaluator scores."
                : "A dataset is a curated set of runs — a regression suite, a golden set, or a known-failures bucket — tracked by its aggregate score. Create one, then add runs from a run's header."
            }
            action={
              datasets.length
                ? undefined
                : { label: "Create your first set", onClick: () => nameRef.current?.focus() }
            }
          />
        ) : (
          <>
            <div className="dshd">
              <h2>{selected.name}</h2>
              <span className={`dsscore ${datasetScore >= 0.8 ? "pass" : datasetScore >= 0.5 ? "warn" : "fail"}`}>
                {members.length ? Math.round(datasetScore * 100) : "—"}
                <i>/100</i>
              </span>
              <span className="seln mono">{members.length} runs</span>
              <button className="dsdel" onClick={() => deleteDataset(selected.id)} title="Delete this dataset">
                Delete
              </button>
            </div>

            {trends.length > 0 && (
              <div className="dsevals">
                {trends.map((t) => (
                  <div className="dsevalr" key={t.id}>
                    <span className="pn" title={t.label}>{t.label}</span>
                    <Spark values={t.scores} color={scoreColor(t.passRate)} w={60} />
                    <span className="pp mono">{Math.round(t.passRate * 100)}%</span>
                  </div>
                ))}
              </div>
            )}

            <div className="dsruns">
              {members.length === 0 && (
                <div className="tab-empty small">
                  No runs in this set yet. Open a run and use <b>Add to set</b> in its header.
                </div>
              )}
              {members.map((r) => {
                const s = overallScore(evaluateRun(r, cfg));
                return (
                  <div className="dsrun" key={r.runId}>
                    <StatusChip status={statusOf(r)} />
                    <button
                      className="dsrn"
                      onClick={() => {
                        selectRun(r.runId);
                        setSegment("runs");
                      }}
                      title={r.runId}
                    >
                      {runTitle(r)}
                    </button>
                    <span className="dsrm mono">{formatCost(r.costUsd)}</span>
                    <span className="dsrs mono" style={{ color: scoreColor(s.score) }}>
                      {Math.round(s.score * 100)}
                    </span>
                    <button
                      className="dsx"
                      onClick={() => toggleRunInDataset(selected.id, r.runId)}
                      title="Remove from set"
                      aria-label="Remove run from set"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
