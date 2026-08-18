import { useMemo } from "react";
import { useObs } from "../data/store";
import { useNow } from "../lib/useNow";
import { laneRollup, laneStalledMs } from "../data/derive/laneRollup";
import { eventMeta } from "../runs/eventMeta";
import { agentColor, projectOf } from "../lib/format";
import { Combo, type ComboOption } from "../lib/Combo";
import { AgentCard } from "./AgentCard";
import { Icon } from "../lib/Icon";
import "./live.css";

export function LiveView() {
  const lanes = useObs((s) => s.lanes);
  const eventCount = useObs((s) => s.eventCount);
  const livePaused = useObs((s) => s.livePaused);
  const setLivePaused = useObs((s) => s.setLivePaused);
  const now = useNow(1000);

  // roll up each lane ONCE per ingest (not per render), then reuse the rollup for
  // visibility, the active/stalled counts, and the cards. Keyed on `lanes`, so
  // the per-second `now` tick re-renders without recomputing any rollups.
  const laneList = useMemo(() => {
    const arr = [...lanes.values()]
      .map((lane) => ({ lane, roll: laneRollup(lane.events) }))
      // hide finished sessions that did nothing (start→end, no turns/tools/cost)
      .filter(({ roll }) => roll.active || roll.turns > 0 || roll.toolCalls > 0 || roll.costUsd > 0);
    const runOf = (i: (typeof arr)[number]) => i.lane.events[0]?.runId ?? "";
    // freshest activity per run, so the most-active run's cluster floats up
    const runFresh = new Map<string, number>();
    for (const i of arr) runFresh.set(runOf(i), Math.max(runFresh.get(runOf(i)) ?? 0, i.lane.lastTs));
    // group lanes of the same run together (runs ordered by recency), newest lane first within a run
    return arr.sort((a, b) => {
      const ra = runOf(a);
      const rb = runOf(b);
      if (ra !== rb) return (runFresh.get(rb)! - runFresh.get(ra)!) || (ra < rb ? -1 : 1);
      return b.lane.lastTs - a.lane.lastTs;
    });
  }, [lanes]);

  // run filter — narrow the wall (+ tail/throughput/counts) to one run's lanes.
  // Persisted (store + localStorage) so it survives navigation and reload.
  const runFilter = useObs((s) => s.liveRunFilter);
  const setRunFilter = useObs((s) => s.setLiveRunFilter);
  const runOptions = useMemo<ComboOption[]>(() => {
    const seen = new Map<string, string>(); // runId → label
    for (const { lane } of laneList) {
      const rid = lane.events[0]?.runId ?? "";
      if (!rid || seen.has(rid)) continue;
      const named = lane.events.find((e) => e.name)?.name?.trim();
      seen.set(rid, named || projectOf(lane.events[0]?.cwd));
    }
    const opts: ComboOption[] = [{ value: "", label: `All runs (${seen.size})` }];
    for (const [rid, label] of seen) opts.push({ value: rid, label, sub: rid });
    return opts;
  }, [laneList]);
  // if the selected run drains out of the live buffer, fall back to all
  const activeRun = runFilter && runOptions.some((o) => o.value === runFilter) ? runFilter : "";
  const runScoped = useMemo(
    () => (activeRun ? laneList.filter((i) => (i.lane.events[0]?.runId ?? "") === activeRun) : laneList),
    [laneList, activeRun],
  );

  // "active only" — restrict the wall to sessions still doing work: open
  // (not ended) AND not stalled. A lane stays `active` forever if its process
  // died without a clean session_end, so open-ness alone lets 310h-idle ghosts
  // through — gate on laneStalledMs too. Persisted; on by default.
  const activeOnly = useObs((s) => s.liveActiveOnly);
  const setActiveOnly = useObs((s) => s.setLiveActiveOnly);
  const visible = useMemo(
    () =>
      activeOnly
        ? runScoped.filter(({ roll }) => roll.active && !roll.ended && laneStalledMs(roll, now) === 0)
        : runScoped,
    [runScoped, activeOnly, now],
  );

  // recent events across run-scoped lanes, newest first. Keyed on runScoped
  // (not the now-dependent `visible`) so the per-second stall tick doesn't
  // re-sort the whole tail.
  const tail = useMemo(() => {
    const all = runScoped.flatMap((i) => i.lane.events);
    return all.sort((a, b) => b.ts - a.ts).slice(0, 40);
  }, [runScoped]);

  // throughput buckets — events per 10s over the last 100s
  const buckets = useMemo(() => {
    const b = new Array(10).fill(0);
    for (const i of runScoped) {
      for (const ev of i.lane.events) {
        const age = now - ev.ts;
        if (age < 0 || age >= 100_000) continue;
        b[9 - Math.floor(age / 10_000)]++;
      }
    }
    return b;
  }, [runScoped, now]);
  const rate = (buckets[9] / 10).toFixed(1);

  // counts come from runScoped, not `visible` — under the default activeOnly
  // filter, stalled lanes are hidden, so counting `visible` would pin the
  // stall chip at zero forever.
  const activeAgents = runScoped.filter(({ roll }) => roll.active && !roll.ended).length;
  const stalledCount = runScoped.filter(({ roll }) => laneStalledMs(roll, now) > 0).length;
  const maxBucket = Math.max(1, ...buckets);

  return (
    <div className="live-wrap">
      <div className="ctx">
        <span className="runtag">
          Live wall
          <span className="mono">
            {visible.length} lane{visible.length === 1 ? "" : "s"} · {activeAgents} active
          </span>
        </span>
        {stalledCount > 0 && <span className="chip warn">⚠ {stalledCount} stalled</span>}
        <button
          className={`livechip ${activeOnly ? "on" : ""}`}
          onClick={() => setActiveOnly(!activeOnly)}
          title={activeOnly ? "Showing only active (non-stalled) sessions — click to show all" : "Showing all sessions — click to show only active ones"}
        >
          <i className="livedot" />
          Active only
        </button>
        {runOptions.length > 1 && (
          <Combo value={activeRun} options={runOptions} onChange={setRunFilter} placeholder="Filter by run…" width={220} />
        )}
        <span className="spacer" />
        <span className="meta-r">
          {eventCount.toLocaleString()} events · {rate}/s
        </span>
        <button
          className="pausebtn"
          onClick={() => setLivePaused(!livePaused)}
          title={livePaused ? "Resume — buffered events flush immediately" : "Pause the wall — incoming events keep buffering"}
        >
          <Icon name={livePaused ? "play" : "pause"} size={12} /> {livePaused ? "resume" : "pause"} wall
        </button>
      </div>

      <div className="live-cols">
        {visible.length === 0 ? (
          <div className="wall-empty">
            <div>
              {activeOnly && runScoped.length > 0 ? (
                <>
                  <h3>No active sessions</h3>
                  <p>
                    Every recent session has ended or stalled.{" "}
                    <button className="linkbtn" onClick={() => setActiveOnly(false)}>
                      Show all sessions
                    </button>
                  </p>
                </>
              ) : (
                <>
                  <h3>{activeRun ? "No lanes for this run" : "No live agents"}</h3>
                  <p>
                    {activeRun
                      ? "This run has no lanes in the live buffer — clear the filter to see all."
                      : "Start a pi run with PI_OBS=1 — sessions stream in here as they happen."}
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="wall">
            <div className="wall-inner">
              {visible.map(({ lane, roll }) => (
                <AgentCard key={lane.key} lane={lane} roll={roll} now={now} runId={lane.events[0]?.runId} />
              ))}
            </div>
          </div>
        )}

        <div className="tail">
          <div className="thead">
            <h3>Live tail</h3>
            <span
              className={`followchip ${livePaused ? "paused" : ""}`}
              title={livePaused ? "Paused — events keep buffering and flush on resume" : "Following live events"}
            >
              <Icon name={livePaused ? "pause" : "check"} size={10} /> {livePaused ? "paused" : "following"}
            </span>
          </div>
          <div className="trows">
            {tail.map((ev) => {
              const m = eventMeta(ev);
              return (
                <div className="trow" key={`${ev.sessionId}:${ev.seq}`}>
                  <span className={`adot a${agentColor(ev.agent)}`} />
                  <span className="ag">{ev.agent}</span>
                  <span className="d">
                    {m.badge} {m.text ? `· ${m.text}` : ""}
                  </span>
                  <span className="ts">{new Date(ev.ts).toLocaleTimeString()}</span>
                </div>
              );
            })}
            {tail.length === 0 && <div className="tab-empty small">No events yet.</div>}
          </div>
          <div className="tfoot">
            <span className="k">events / 10s</span>
            <span className="tput">
              {buckets.map((v, i) => (
                <i key={i} className={i === 9 ? "h" : ""} style={{ height: `${(v / maxBucket) * 100}%` }} />
              ))}
            </span>
            <span className="v">{rate}/s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
