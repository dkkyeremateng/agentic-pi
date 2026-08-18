import { useMemo, useState } from "react";
import { useRuns } from "../data/queries";
import { useObs } from "../data/store";
import { api } from "../data/client";
import { ALERT_WINDOW_MS, METRIC_META, evaluateMonitors, type Alert, type MonitorMetric } from "../data/derive/monitors";
import { runTitle } from "../runs/runUtils";
import { formatDuration, projectOf, relTime } from "../lib/format";
import { Icon } from "../lib/Icon";
import { Combo } from "../lib/Combo";
import { Stepper } from "../lib/Stepper";
import "./monitors.css";

const METRICS: MonitorMetric[] = ["cost", "latency", "evalScore", "errorRate"];
// Alerts are scoped to recent activity (see ALERT_WINDOW_MS) — say so in the UI
// rather than letting "0 alerts" silently mean "none in the last day".
// formatDuration is built for run durations ("27h23m"), so a round window comes
// out as "24h00m"; drop the minutes when they're zero.
const alertWindowLabel =
  ALERT_WINDOW_MS % 3_600_000 === 0 ? `${ALERT_WINDOW_MS / 3_600_000}h` : formatDuration(ALERT_WINDOW_MS);

export function MonitorsView() {
  const runsQ = useRuns();
  const monitors = useObs((s) => s.monitors);
  const cfg = useObs((s) => s.evalConfig);
  const addMonitor = useObs((s) => s.addMonitor);
  const updateMonitor = useObs((s) => s.updateMonitor);
  const deleteMonitor = useObs((s) => s.deleteMonitor);
  const selectRun = useObs((s) => s.selectRun);
  const setSegment = useObs((s) => s.setSegment);
  const webhook = useObs((s) => s.webhook);
  const setWebhook = useObs((s) => s.setWebhook);

  const [project, setProject] = useState("all");
  const [newMetric, setNewMetric] = useState<MonitorMetric>("cost");
  const [newThreshold, setNewThreshold] = useState(METRIC_META.cost.def);
  const [testState, setTestState] = useState("");
  const [testing, setTesting] = useState(false);

  // selecting a metric pre-fills its sensible default threshold
  const pickMetric = (m: MonitorMetric) => {
    setNewMetric(m);
    setNewThreshold(METRIC_META[m].def);
  };

  // project filter — alerts (incl. the aggregate error-rate) scope to the set
  const allRuns = runsQ.data ?? [];
  const projects = useMemo(
    () => [...new Set(allRuns.map((r) => projectOf(r.cwd)))].sort(),
    [allRuns],
  );
  const scopedRuns = useMemo(
    () => (project === "all" ? allRuns : allRuns.filter((r) => projectOf(r.cwd) === project)),
    [allRuns, project],
  );
  const alerts = useMemo(
    () => evaluateMonitors(monitors, scopedRuns, cfg),
    [monitors, scopedRuns, cfg],
  );
  const projectOptions = useMemo(
    () => [{ value: "all", label: "All projects" }, ...projects.map((p) => ({ value: p, label: p }))],
    [projects],
  );

  const sendTest = () => {
    if (!webhook.url || testing) return;
    setTesting(true);
    setTestState("sending…");
    api
      .notify(webhook.url, { source: "pi-obs", test: true, ts: Date.now() })
      .then((r) => setTestState(r.ok ? `delivered (HTTP ${r.status})` : `failed: ${r.error || r.status}`))
      .catch((e) => setTestState(`failed: ${String((e as Error)?.message || e)}`))
      .finally(() => setTesting(false));
  };

  const runMap = useMemo(() => new Map((runsQ.data ?? []).map((r) => [r.runId, r])), [runsQ.data]);
  const crit = alerts.filter((a) => a.severity === "crit").length;
  const warn = alerts.length - crit;
  const activeMonitors = monitors.filter((m) => m.enabled).length;

  // group alerts by the monitor that raised them — far more scannable than a
  // flat list where the same monitor repeats
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; items: Alert[]; crit: number }>();
    for (const a of alerts) {
      let g = m.get(a.monitorId);
      if (!g) {
        g = { id: a.monitorId, name: a.monitorName, items: [], crit: 0 };
        m.set(a.monitorId, g);
      }
      g.items.push(a);
      if (a.severity === "crit") g.crit++;
    }
    return [...m.values()].sort((x, y) => y.items.length - x.items.length);
  }, [alerts]);
  // per-monitor breach count, for the rule badges
  const breachByMonitor = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of alerts) m.set(a.monitorId, (m.get(a.monitorId) ?? 0) + 1);
    return m;
  }, [alerts]);

  const add = () => {
    if (!(newThreshold > 0)) return;
    addMonitor(newMetric, newThreshold);
    setNewThreshold(METRIC_META[newMetric].def);
  };

  return (
    <div className="mon">
      <div className="monhd">
        <span className="m-mark">
          <i className="m-pulse" />
          Monitors
        </span>
        <span className="m-sub mono" title={`Only runs active in the last ${alertWindowLabel} can raise an alert — older breaches age out.`}>
          {alerts.length} alert{alerts.length === 1 ? "" : "s"}
          {crit ? ` · ${crit} critical` : ""} · last {alertWindowLabel}
        </span>
        {projects.length > 1 && (
          <span className="monfilter">
            <Combo value={project} options={projectOptions} onChange={setProject} width={180} ariaLabel="Filter alerts by project" />
          </span>
        )}
      </div>

      {/* summary tiles — gives the page the dashboard-header feel of the other views */}
      <div className="montiles">
        <div className="mtile">
          <span className="mtk">alerts</span>
          <b className="mtv">{alerts.length}</b>
        </div>
        <div className="mtile">
          <span className="mtk">critical</span>
          <b className={`mtv ${crit ? "crit" : ""}`}>{crit}</b>
        </div>
        <div className="mtile">
          <span className="mtk">warning</span>
          <b className={`mtv ${warn ? "warn" : ""}`}>{warn}</b>
        </div>
        <div className="mtile">
          <span className="mtk">monitors</span>
          <b className="mtv">
            {activeMonitors}
            <span className="mtsub">/{monitors.length}</span>
          </b>
        </div>
      </div>

      <div className="mongrid">
        {/* alerts inbox — grouped by monitor */}
        <div className="acard">
          <div className="ahd">
            <h3>Alerts</h3>
            <span className="seln mono">{alerts.length}</span>
          </div>
          <div className="alertlist">
            {runsQ.isError ? (
              <div className="mon-err">
                <Icon name="alert" size={14} /> Couldn't reach the server — alert status is unknown.
              </div>
            ) : (
              alerts.length === 0 && (
                <div className="allclear">
                  <Icon name="check" size={14} /> All clear — every monitor is within its threshold over the last {alertWindowLabel}.
                </div>
              )
            )}
            {groups.map((g) => (
              <div className="agroup" key={g.id}>
                <div className="aghd">
                  <span className="agname">{g.name}</span>
                  <span className={`agcount ${g.crit ? "crit" : "warn"}`}>{g.items.length}</span>
                </div>
                {g.items.map((a, i) => {
                  const run = a.runId ? runMap.get(a.runId) : null;
                  return (
                    <div className={`alert ${a.severity}`} key={`${a.monitorId}-${a.runId ?? "agg"}-${i}`}>
                      <span className={`achip ${a.severity}`}>{a.severity}</span>
                      <span className="ainfo">
                        {run ? (
                          <button
                            className="alink"
                            onClick={() => {
                              selectRun(run.runId);
                              setSegment("runs");
                            }}
                          >
                            {runTitle(run)}
                          </button>
                        ) : (
                          <span className="aagg">all runs</span>
                        )}
                        <span className="adetail mono">{a.detail}</span>
                      </span>
                      <span className="atime mono">{relTime(a.ts)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* monitor rules */}
        <div className="acard">
          <div className="ahd">
            <h3>Rules</h3>
            <span className="seln mono">{monitors.length}</span>
          </div>
          <div className="rulelist">
            {monitors.map((m) => {
              const meta = METRIC_META[m.metric];
              return (
                <div className={`rule ${m.enabled ? "" : "off"}`} key={m.id}>
                  <label className="rsw">
                    <input type="checkbox" checked={m.enabled} onChange={(e) => updateMonitor(m.id, { enabled: e.target.checked })} />
                  </label>
                  <span className="rname">{m.name}</span>
                  <span className="rbreach" title="runs breaching now">
                    {m.enabled && (breachByMonitor.get(m.id) ?? 0) > 0 ? breachByMonitor.get(m.id) : ""}
                  </span>
                  <span className="rcmp mono">{meta.cmp === "above" ? ">" : "<"}</span>
                  <Stepper
                    value={m.threshold}
                    min={0}
                    step={meta.step}
                    width={44}
                    onChange={(v) => updateMonitor(m.id, { threshold: v })}
                  />
                  <span className="runit mono">{meta.unit}</span>
                  <button className="rx" onClick={() => deleteMonitor(m.id)} title="Delete monitor" aria-label="Delete monitor">
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="ruleadd">
            <select value={newMetric} onChange={(e) => pickMetric(e.target.value as MonitorMetric)}>
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {METRIC_META[m].label} ({METRIC_META[m].cmp === "above" ? ">" : "<"} {METRIC_META[m].unit})
                </option>
              ))}
            </select>
            <Stepper
              value={newThreshold}
              min={0}
              step={METRIC_META[newMetric].step}
              width={48}
              onChange={setNewThreshold}
            />
            <button onClick={add} disabled={!(newThreshold > 0)}>
              add monitor
            </button>
          </div>
        </div>
      </div>

      {/* webhook — relay new alerts to an external endpoint (Slack, etc.) */}
      <div className="acard webhookcard">
        <div className="ahd">
          <h3>Webhook</h3>
          <label className="whtoggle">
            <input
              type="checkbox"
              checked={webhook.enabled}
              onChange={(e) => setWebhook({ enabled: e.target.checked })}
            />
            enabled
          </label>
        </div>
        <div className="whrow">
          <input
            className="whurl"
            type="url"
            value={webhook.url}
            onChange={(e) => {
              setWebhook({ url: e.target.value });
              setTestState(""); // a stale verdict beside an untested URL misleads
            }}
            placeholder="https://hooks.example.com/…"
            aria-label="Webhook URL"
          />
          <button onClick={sendTest} disabled={!webhook.url || testing}>
            Send test
          </button>
          {testState && <span className="whstate mono">{testState}</span>}
        </div>
        <p className="whnote">
          New alerts are POSTed here while the dashboard is open (deduped per run). A server-resident monitor loop would
          deliver even when it's closed.
        </p>
      </div>
    </div>
  );
}
