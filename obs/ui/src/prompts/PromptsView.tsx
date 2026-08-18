import { useMemo, useState } from "react";
import { usePrompts } from "../data/queries";
import { api } from "../data/client";
import { useObs } from "../data/store";
import type { PlaygroundResp, PromptVersion } from "../data/types";
import { relTime } from "../lib/format";
import { Icon } from "../lib/Icon";
import { TabSkeleton } from "../lib/Skeleton";
import "./prompts.css";

function Playground() {
  const [system, setSystem] = useState("");
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PlaygroundResp | null>(null);
  const [err, setErr] = useState("");

  const run = () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setErr("");
    setRes(null);
    api
      .playground(system, input, model.trim() || undefined)
      .then(setRes)
      .catch((e) => setErr(String((e as Error)?.message || e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="pg">
      <div className="prhd">
        <h2>Prompt playground</h2>
        <span className="seln mono">safe · one-shot · no tools</span>
      </div>
      <div className="pgbody">
        <label className="pglabel">System prompt</label>
        <textarea className="pgta" value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a terse assistant…" rows={5} />
        <label className="pglabel">Input</label>
        <textarea className="pgta" value={input} onChange={(e) => setInput(e.target.value)} placeholder="The user message / content to run…" rows={5} />
        <div className="pgrun">
          <input className="pgmodel" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model (optional, e.g. anthropic/claude-haiku-4-5)" />
          <button className="pgbtn" onClick={run} disabled={busy || !input.trim()}>
            <Icon name="spark" size={12} /> {busy ? "Running…" : "Run"}
          </button>
        </div>
        {err && <p className="pgerr">Couldn't reach the server: {err}</p>}
        {res && res.enabled === false && <p className="pgnote">{res.hint || "Set PI_OBS_LLM=1 on the server."}</p>}
        {res?.error && <p className="pgerr">{res.error}</p>}
        {res?.enabled && res.output != null && (
          <>
            <label className="pglabel">
              Output {res.model && <span className="mono pgmeta">· {res.model}</span>}
            </label>
            <pre className="pgout">{res.output}</pre>
          </>
        )}
        <p className="pgnote">
          A pure text completion (tools, session, skills, and extensions are off) — for iterating on wording, not
          re-running an agent.
        </p>
      </div>
    </div>
  );
}

function diff(newer: PromptVersion, older: PromptVersion) {
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  return {
    toolsAdded: minus(newer.tools, older.tools),
    toolsRemoved: minus(older.tools, newer.tools),
    skillsAdded: minus(newer.skills, older.skills),
    skillsRemoved: minus(older.skills, newer.skills),
    promptDelta: newer.promptChars - older.promptChars,
    modelChanged: newer.model !== older.model,
  };
}

function VersionCard({ v, idx, total, prev }: { v: PromptVersion; idx: number; total: number; prev?: PromptVersion }) {
  const selectRun = useObs((s) => s.selectRun);
  const setSegment = useObs((s) => s.setSegment);
  const openRun = (id: string) => {
    selectRun(id);
    setSegment("runs");
  };
  const d = prev ? diff(v, prev) : null;
  const label = `v${total - idx}`;
  return (
    <div className={`pv ${idx === 0 ? "current" : ""}`}>
      <div className="pv-h">
        <span className="pv-tag">{label}</span>
        {idx === 0 && <span className="pv-cur">current</span>}
        <span className="pv-hash mono">#{v.promptHash || "—"}</span>
        {v.model && <span className="pv-model mono">{v.model}</span>}
        <span className="pv-when mono">{relTime(v.lastTs)}</span>
      </div>
      <div className="pv-meta mono">
        {v.promptChars.toLocaleString()} chars · {v.tools.length} tools · {v.skills.length} skills ·{" "}
        {v.runs.length} run{v.runs.length === 1 ? "" : "s"} · {v.sessions} session{v.sessions === 1 ? "" : "s"}
      </div>
      {d && (
        <div className="pv-diff">
          {d.modelChanged && <span className="dchg model">model changed</span>}
          {d.promptDelta !== 0 && (
            <span className={`dchg ${d.promptDelta > 0 ? "up" : "down"}`}>
              prompt {d.promptDelta > 0 ? "+" : ""}
              {d.promptDelta} chars
            </span>
          )}
          {d.toolsAdded.map((t) => (
            <span className="dchg add" key={`ta${t}`}>+tool {t}</span>
          ))}
          {d.toolsRemoved.map((t) => (
            <span className="dchg rem" key={`tr${t}`}>−tool {t}</span>
          ))}
          {d.skillsAdded.map((s) => (
            <span className="dchg add" key={`sa${s}`}>+skill {s}</span>
          ))}
          {d.skillsRemoved.map((s) => (
            <span className="dchg rem" key={`sr${s}`}>−skill {s}</span>
          ))}
          {!d.modelChanged && d.promptDelta === 0 && !d.toolsAdded.length && !d.toolsRemoved.length && !d.skillsAdded.length && !d.skillsRemoved.length && (
            <span className="dchg same">only config order changed</span>
          )}
        </div>
      )}
      <div className="pv-lists">
        <div className="pv-row">
          <span className="pv-k">tools</span>
          <span className="pv-chips">
            {v.tools.map((t) => (
              <span className="pchip" key={t}>{t}</span>
            ))}
          </span>
        </div>
        <div className="pv-row">
          <span className="pv-k">skills</span>
          <span className="pv-chips">
            {v.skills.length ? v.skills.map((s) => <span className="pchip" key={s}>{s}</span>) : <span className="pv-none">none</span>}
          </span>
        </div>
        {v.contextFiles.length > 0 && (
          <div className="pv-row">
            <span className="pv-k">context</span>
            <span className="pv-chips">
              {v.contextFiles.map((c) => (
                <span className="pchip" key={c}>{c}</span>
              ))}
            </span>
          </div>
        )}
        {v.runs.length > 0 && (
          <div className="pv-row">
            <span className="pv-k">runs</span>
            <span className="pv-chips">
              {v.runs.slice(0, 8).map((r) => (
                <button className="pchip prun" key={r} onClick={() => openRun(r)} title={`Open ${r}`}>
                  <Icon name="crosshair" size={10} />
                  {r.replace(/^run-/, "").slice(0, 12)}
                </button>
              ))}
              {v.runs.length > 8 && <span className="pv-none">+{v.runs.length - 8} more</span>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function PromptsView() {
  const q = usePrompts();
  const agents = q.data ?? [];
  const [selAgent, setSelAgent] = useState<string | null>(null);
  const [playground, setPlayground] = useState(false);
  const selected = useMemo(() => agents.find((a) => a.agent === selAgent) ?? agents[0] ?? null, [agents, selAgent]);

  return (
    <div className="prcols">
      <div className="prpane">
        <div className="px ph">
          <h2>Prompts</h2>
          <span className="count">{agents.length}</span>
        </div>
        <button className={`pritem pin ${playground ? "on" : ""}`} onClick={() => setPlayground(true)}>
          <Icon name="spark" size={12} />
          <span className="prn">Playground</span>
        </button>
        <div className="prlist">
          {q.isLoading && <div className="empty">Scanning runs…</div>}
          {!q.isLoading && agents.length === 0 && <div className="empty">No boot snapshots recorded yet.</div>}
          {agents.map((a) => (
            <button
              key={a.agent}
              className={`pritem ${!playground && selected?.agent === a.agent ? "on" : ""}`}
              onClick={() => {
                setSelAgent(a.agent);
                setPlayground(false);
              }}
            >
              <span className="prn">{a.agent}</span>
              <span className="prc mono">
                {a.versions.length} ver{a.versions.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="prmain">
        {playground ? (
          <Playground />
        ) : !selected ? (
          q.isLoading ? (
            <TabSkeleton label="Loading prompt snapshots…" />
          ) : (
            <div className="tab-empty">No agent configs found.</div>
          )
        ) : (
          <>
            <div className="prhd">
              <h2>{selected.agent}</h2>
              <span className="seln mono">
                {selected.versions.length} version{selected.versions.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="prversions">
              {selected.versions.map((v, i) => (
                <VersionCard key={v.promptHash + i} v={v} idx={i} total={selected.versions.length} prev={selected.versions[i + 1]} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
