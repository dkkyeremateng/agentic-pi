// UI + live-event store. Deliberately thin: it holds UI state and the raw
// per-lane event tails, nothing computed. Every rollup and derivation (lanes,
// stall calc, trace, analytics, cycles, evals, monitors) lives in ./derive as
// pure, tested functions that components call on the state selected here.
import { create } from "zustand";
import type { ChatMessage, ChatSession, ObsEvent } from "./types";
import { laneKey } from "./derive/lanes";
import { authHeaders } from "./auth";
import { apiUrl } from "./config";
import type { DateWin, RunStatusFilter } from "../runs/runUtils";
import { DEFAULT_EVAL_CONFIG, type EvalConfig } from "./derive/evals";
import { DEFAULT_MONITORS, type Monitor, type MonitorMetric } from "./derive/monitors";

// Evaluator budgets persist across reloads (localStorage); the real environment
// (a fresh install) falls back to DEFAULT_EVAL_CONFIG.
const EVAL_CFG_KEY = "obs.evalConfig";
function loadEvalConfig(): EvalConfig {
  try {
    const raw = localStorage.getItem(EVAL_CFG_KEY);
    if (raw) return { ...DEFAULT_EVAL_CONFIG, ...(JSON.parse(raw) as Partial<EvalConfig>) };
  } catch {
    /* ignore — fall back to defaults */
  }
  return DEFAULT_EVAL_CONFIG;
}

export type Segment = "runs" | "live" | "analytics" | "datasets" | "monitors" | "prompts" | "chat" | "search";

// A curated set of runs (a regression suite / golden set / known-failures bucket).
// Persisted in localStorage — the observability tool can't re-execute agents, so
// a "dataset" is a named collection whose aggregate evaluator scores we track.
export interface Dataset {
  id: string;
  name: string;
  runIds: string[];
  createdTs: number;
}
const DATASETS_KEY = "obs.datasets";
function loadDatasets(): Dataset[] {
  try {
    const raw = localStorage.getItem(DATASETS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Dataset[];
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* ignore — start empty */
  }
  return [];
}
function saveDatasets(d: Dataset[]): void {
  try {
    localStorage.setItem(DATASETS_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}
const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Monitors persist in localStorage; a fresh install seeds DEFAULT_MONITORS.
const MONITORS_KEY = "obs.monitors";
function loadMonitors(): Monitor[] {
  try {
    const raw = localStorage.getItem(MONITORS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Monitor[];
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_MONITORS.map((m) => ({ ...m }));
}
function saveMonitors(m: Monitor[]): void {
  try {
    localStorage.setItem(MONITORS_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

const CHATS_KEY = "obs.chats";
function loadChats(): ChatSession[] {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as ChatSession[];
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* ignore */
  }
  return [];
}
// Mirror chats to the server (debounced) so they survive a cache clear and are
// shared across browsers. localStorage stays the instant local cache.
let chatRemoteTimer: ReturnType<typeof setTimeout> | undefined;
let pendingChats: ChatSession[] | undefined; // batch awaiting the debounced PUT
function putChatsNow(chats: ChatSession[], keepalive: boolean): void {
  fetch(apiUrl("/chats"), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ chats }),
    keepalive,
  }).catch(() => {
    /* offline / server down — localStorage still has it */
  });
}
function saveChatsRemote(c: ChatSession[]): void {
  pendingChats = c;
  clearTimeout(chatRemoteTimer);
  chatRemoteTimer = setTimeout(() => {
    pendingChats = undefined;
    putChatsNow(c, false);
  }, 800);
}
// Flush the pending debounced PUT when the tab hides or closes — without this an
// edit made <800ms before close never reaches the server. keepalive lets the PUT
// outlive the page (browsers cap keepalive bodies at ~64KB; an oversized flush
// fails, but localStorage still has the data).
function flushChatsRemote(): void {
  if (!pendingChats) return;
  clearTimeout(chatRemoteTimer);
  const chats = pendingChats;
  pendingChats = undefined;
  putChatsNow(chats, true);
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushChatsRemote);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushChatsRemote();
  });
}
function saveChats(c: ChatSession[]): void {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
  saveChatsRemote(c);
}
// Latest activity in a chat — the newest message ts, falling back to creation.
// Picks the winner when the server and local copies of a chat diverge.
function newestTs(c: ChatSession): number {
  let ts = c.createdTs;
  for (const m of c.messages) if (m.ts > ts) ts = m.ts;
  return ts;
}

const WEBHOOK_KEY = "obs.webhook";
function loadWebhook(): { url: string; enabled: boolean } {
  try {
    const raw = localStorage.getItem(WEBHOOK_KEY);
    if (raw) return { url: "", enabled: false, ...(JSON.parse(raw) as object) };
  } catch {
    /* ignore */
  }
  return { url: "", enabled: false };
}

// Live-wall run filter persists across navigation AND reload.
const LIVE_RUN_FILTER_KEY = "obs.liveRunFilter";
function loadLiveRunFilter(): string {
  try {
    return localStorage.getItem(LIVE_RUN_FILTER_KEY) ?? "";
  } catch {
    return "";
  }
}

// Live-wall "active only" toggle — restrict the wall to sessions still open (not
// session_end'd). Persisted; defaults on, mirroring the Runs inbox's Active facet.
const LIVE_ACTIVE_ONLY_KEY = "obs.liveActiveOnly";
function loadLiveActiveOnly(): boolean {
  try {
    return localStorage.getItem(LIVE_ACTIVE_ONLY_KEY) !== "0";
  } catch {
    return true;
  }
}
export type RunTab = "trace" | "timeline" | "events" | "stats" | "evals" | "raw";
export type StreamStatus = "open" | "closed" | "retrying";

export interface Lane {
  key: string;
  agent: string;
  events: ObsEvent[];
  lastTs: number;
}

// Cap the live wall's memory: the lanes Map would otherwise grow forever across
// a long browser session (every run ever streamed). Once over MAX_LANES, evict
// the stalest finished lanes (oldest lastTs first), never touching the lane just
// written or anything still within the live window.
const MAX_LANES = 80;
const LANE_TTL_MS = 30 * 60_000;
function pruneLanes(lanes: Map<string, Lane>, now: number, keep: string): void {
  if (lanes.size <= MAX_LANES) return;
  const stale = [...lanes.values()]
    .filter((l) => l.key !== keep && now - l.lastTs > LANE_TTL_MS)
    .sort((a, b) => a.lastTs - b.lastTs);
  for (const l of stale) {
    if (lanes.size <= MAX_LANES) break;
    lanes.delete(l.key);
  }
}

interface ObsState {
  // ui
  segment: Segment;
  selectedRunId: string | null;
  runTab: RunTab;
  focusTs: number | null; // shared event/playhead time, bridges Timeline ↔ Events
  // one-shot "open the detail for the event nearest this time" intent — set only
  // by cross-page openers (Timeline segment, Search hit); consumed by EventsTab.
  // A plain tab click never sets it, so it won't auto-open the drawer.
  selectEventTs: number | null;
  // Agent scope for the open run's detail tabs — "" = all agents. Shared across
  // the tabs so narrowing survives a tab switch; cleared when a different run
  // is selected (its agents won't match).
  // Two parts because `agent` is a ROLE and a run can dispatch several
  // instances of it: runAgentSession pins one of them ("" = every instance).
  // Tabs whose data only aggregates per role (Stats, off the digest) honour the
  // role and ignore the session.
  runAgentFilter: string;
  runAgentSession: string;
  // runs inbox filters (shared with the telemetry strip so both scope alike)
  runStatusFilter: RunStatusFilter;
  runDateWin: DateWin;
  runProjectFilter: string; // "all" or a project name
  runHideNoops: boolean; // fold low-signal throwaway runs (default on)
  runSearch: string; // free-text filter over the runs inbox
  liveRunFilter: string; // "" = all runs, else a runId (persisted)
  liveActiveOnly: boolean; // live wall: show only still-open sessions (persisted)
  evalConfig: EvalConfig; // evaluator budgets (persisted)
  datasets: Dataset[]; // curated run sets (persisted)
  selectedDatasetId: string | null;
  monitors: Monitor[]; // alert thresholds (persisted)
  webhook: { url: string; enabled: boolean }; // alert delivery (persisted)
  chats: ChatSession[]; // chat conversations (persisted)
  selectedChatId: string | null;
  paletteOpen: boolean;
  livePaused: boolean;
  explainRunId: string | null; // run the user asked to AI-explain
  setSegment: (s: Segment) => void;
  selectRun: (id: string | null) => void;
  setRunTab: (t: RunTab) => void;
  setFocusTs: (ts: number | null) => void;
  setSelectEventTs: (ts: number | null) => void;
  setRunAgentScope: (agent: string, sessionId?: string) => void;
  setRunStatusFilter: (f: RunStatusFilter) => void;
  setRunDateWin: (w: DateWin) => void;
  setRunProjectFilter: (p: string) => void;
  setRunHideNoops: (v: boolean) => void;
  setRunSearch: (q: string) => void;
  setLiveRunFilter: (runId: string) => void;
  setLiveActiveOnly: (v: boolean) => void;
  setEvalConfig: (patch: Partial<EvalConfig>) => void;
  createDataset: (name: string) => string; // returns the new id
  renameDataset: (id: string, name: string) => void;
  deleteDataset: (id: string) => void;
  toggleRunInDataset: (id: string, runId: string) => void;
  selectDataset: (id: string | null) => void;
  addMonitor: (metric: MonitorMetric, threshold: number, name?: string) => void;
  updateMonitor: (id: string, patch: Partial<Monitor>) => void;
  deleteMonitor: (id: string) => void;
  setWebhook: (patch: Partial<{ url: string; enabled: boolean }>) => void;
  createChat: () => string;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  selectChat: (id: string | null) => void;
  patchChat: (
    id: string,
    patch: Partial<
      Pick<
        ChatSession,
        | "model"
        | "toolsEnabled"
        | "title"
        | "attachedRunId"
        | "attachedSessionId"
        | "attachedAgent"
        | "attachedCwd"
        | "attachedTools"
        | "attachedLive"
        | "deliverMode"
        | "requireApproval"
      >
    >,
  ) => void;
  appendChatMessage: (id: string, msg: ChatMessage) => void;
  replaceChatMessages: (id: string, messages: ChatMessage[]) => void;
  hydrateChats: (chats: ChatSession[]) => void; // merge server-stored chats on load
  setPalette: (open: boolean) => void;
  setLivePaused: (v: boolean) => void;
  requestExplain: (id: string) => void;

  // live
  streamStatus: StreamStatus;
  lanes: Map<string, Lane>;
  eventCount: number;
  setStreamStatus: (s: StreamStatus) => void;
  ingestMany: (evs: ObsEvent[]) => void;
}

export const useObs = create<ObsState>((set) => ({
  segment: "runs",
  selectedRunId: null,
  runTab: "trace",
  focusTs: null,
  selectEventTs: null,
  runAgentFilter: "",
  runAgentSession: "",
  runStatusFilter: "active",
  runDateWin: "max",
  runProjectFilter: "all",
  runHideNoops: true,
  runSearch: "",
  liveRunFilter: loadLiveRunFilter(),
  liveActiveOnly: loadLiveActiveOnly(),
  evalConfig: loadEvalConfig(),
  datasets: loadDatasets(),
  selectedDatasetId: null,
  monitors: loadMonitors(),
  webhook: loadWebhook(),
  chats: loadChats(),
  selectedChatId: null,
  paletteOpen: false,
  livePaused: false,
  explainRunId: null,
  setSegment: (segment) => set({ segment }),
  selectRun: (selectedRunId) =>
    set({ selectedRunId, explainRunId: null, focusTs: null, selectEventTs: null, runAgentFilter: "", runAgentSession: "" }),
  setRunTab: (runTab) => set({ runTab }),
  setFocusTs: (focusTs) => set({ focusTs }),
  setSelectEventTs: (selectEventTs) => set({ selectEventTs }),
  setRunAgentScope: (runAgentFilter, runAgentSession = "") => set({ runAgentFilter, runAgentSession }),
  setRunStatusFilter: (runStatusFilter) => set({ runStatusFilter }),
  setRunDateWin: (runDateWin) => set({ runDateWin }),
  setRunProjectFilter: (runProjectFilter) => set({ runProjectFilter }),
  setRunHideNoops: (runHideNoops) => set({ runHideNoops }),
  setRunSearch: (runSearch) => set({ runSearch }),
  setLiveRunFilter: (liveRunFilter) => {
    try {
      localStorage.setItem(LIVE_RUN_FILTER_KEY, liveRunFilter);
    } catch {
      /* ignore */
    }
    set({ liveRunFilter });
  },
  setLiveActiveOnly: (liveActiveOnly) => {
    try {
      localStorage.setItem(LIVE_ACTIVE_ONLY_KEY, liveActiveOnly ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ liveActiveOnly });
  },
  setEvalConfig: (patch) =>
    set((s) => {
      const evalConfig = { ...s.evalConfig, ...patch };
      try {
        localStorage.setItem(EVAL_CFG_KEY, JSON.stringify(evalConfig));
      } catch {
        /* ignore */
      }
      return { evalConfig };
    }),
  createDataset: (name) => {
    const ds: Dataset = { id: newId(), name: name.trim() || "Untitled set", runIds: [], createdTs: Date.now() };
    set((s) => {
      const datasets = [...s.datasets, ds];
      saveDatasets(datasets);
      return { datasets, selectedDatasetId: ds.id };
    });
    return ds.id;
  },
  renameDataset: (id, name) =>
    set((s) => {
      const datasets = s.datasets.map((d) => (d.id === id ? { ...d, name: name.trim() || d.name } : d));
      saveDatasets(datasets);
      return { datasets };
    }),
  deleteDataset: (id) =>
    set((s) => {
      const datasets = s.datasets.filter((d) => d.id !== id);
      saveDatasets(datasets);
      return { datasets, selectedDatasetId: s.selectedDatasetId === id ? null : s.selectedDatasetId };
    }),
  toggleRunInDataset: (id, runId) =>
    set((s) => {
      const datasets = s.datasets.map((d) =>
        d.id === id
          ? { ...d, runIds: d.runIds.includes(runId) ? d.runIds.filter((r) => r !== runId) : [...d.runIds, runId] }
          : d,
      );
      saveDatasets(datasets);
      return { datasets };
    }),
  selectDataset: (selectedDatasetId) => set({ selectedDatasetId }),
  addMonitor: (metric, threshold, name) =>
    set((s) => {
      const m: Monitor = { id: newId(), name: name?.trim() || metric, metric, threshold, enabled: true };
      const monitors = [...s.monitors, m];
      saveMonitors(monitors);
      return { monitors };
    }),
  updateMonitor: (id, patch) =>
    set((s) => {
      const monitors = s.monitors.map((m) => (m.id === id ? { ...m, ...patch } : m));
      saveMonitors(monitors);
      return { monitors };
    }),
  deleteMonitor: (id) =>
    set((s) => {
      const monitors = s.monitors.filter((m) => m.id !== id);
      saveMonitors(monitors);
      return { monitors };
    }),
  setWebhook: (patch) =>
    set((s) => {
      const webhook = { ...s.webhook, ...patch };
      try {
        localStorage.setItem(WEBHOOK_KEY, JSON.stringify(webhook));
      } catch {
        /* ignore */
      }
      return { webhook };
    }),
  createChat: () => {
    // id doubles as pi's --session-id, which must be alphanumeric (with -/_/.)
    // AND start+end alphanumeric — so strip to alnum and keep "chat" as a prefix.
    const id = `chat${newId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
    const chat: ChatSession = { id, title: "New chat", model: "", toolsEnabled: false, createdTs: Date.now(), messages: [] };
    set((s) => {
      const chats = [chat, ...s.chats];
      saveChats(chats);
      return { chats, selectedChatId: id };
    });
    return id;
  },
  deleteChat: (id) =>
    set((s) => {
      const chats = s.chats.filter((c) => c.id !== id);
      saveChats(chats);
      return { chats, selectedChatId: s.selectedChatId === id ? null : s.selectedChatId };
    }),
  renameChat: (id, title) =>
    set((s) => {
      const chats = s.chats.map((c) => (c.id === id ? { ...c, title: title.trim() || c.title } : c));
      saveChats(chats);
      return { chats };
    }),
  selectChat: (selectedChatId) => set({ selectedChatId }),
  patchChat: (id, patch) =>
    set((s) => {
      const chats = s.chats.map((c) => (c.id === id ? { ...c, ...patch } : c));
      saveChats(chats);
      return { chats };
    }),
  appendChatMessage: (id, msg) =>
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== id) return c;
        // auto-title from the first user message
        const title = c.messages.length === 0 && msg.role === "user" ? msg.text.slice(0, 48) : c.title;
        return { ...c, title, messages: [...c.messages, msg] };
      });
      saveChats(chats);
      return { chats };
    }),
  replaceChatMessages: (id, messages) =>
    set((s) => {
      const chats = s.chats.map((c) => (c.id === id ? { ...c, messages } : c));
      saveChats(chats);
      return { chats };
    }),
  hydrateChats: (serverChats) =>
    set((s) => {
      // Merge, don't replace: a stale server copy (or another browser's older
      // PUT) must not wipe messages written locally moments ago. Union by chat
      // id; on collision keep the copy whose newest message ts is later (tie →
      // server); local-only chats survive. If the merge differs from what the
      // server sent, push it back up via the debounced save.
      const merged = new Map<string, ChatSession>();
      for (const c of serverChats) merged.set(c.id, c);
      let differs = false;
      for (const local of s.chats) {
        const remote = merged.get(local.id);
        if (!remote) {
          merged.set(local.id, local); // local-only chat — keep it
          differs = true;
        } else if (newestTs(local) > newestTs(remote)) {
          merged.set(local.id, local); // local copy is fresher
          differs = true;
        }
      }
      const chats = [...merged.values()].sort((a, b) => newestTs(b) - newestTs(a));
      if (differs) {
        saveChats(chats); // caches locally AND schedules the debounced push-up
      } else {
        try {
          localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
        } catch {
          /* ignore */
        }
      }
      return { selectedChatId: chats.some((c) => c.id === s.selectedChatId) ? s.selectedChatId : null, chats };
    }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setLivePaused: (livePaused) => set({ livePaused }),
  requestExplain: (explainRunId) => set({ explainRunId }),

  streamStatus: "closed",
  lanes: new Map(),
  eventCount: 0,
  setStreamStatus: (streamStatus) => set({ streamStatus }),

  ingestMany: (evs) =>
    set((st) => {
      // Group the batch by lane FIRST, then rebuild each touched lane's tail
      // once. Appending per event would copy the (up to 60-entry) tail array
      // once per event — a 200-event burst into one lane meant 200 copies.
      let byLane: Map<string, ObsEvent[]> | null = null; // built lazily — an all-verdict batch is a no-op
      let added = 0;
      let lastKey = "";
      let lastTs = 0;
      for (const ev of evs) {
        // verdicts are annotations from a synthetic "user" session — they must not
        // spawn a "user" lane on the live wall (matches the server rollup).
        if (ev.type === "verdict") continue;
        if (!byLane) byLane = new Map();
        const key = laneKey(ev);
        const bucket = byLane.get(key);
        if (bucket) bucket.push(ev);
        else byLane.set(key, [ev]);
        added++;
        lastKey = key;
        lastTs = ev.ts;
      }
      if (!byLane) return st;
      const lanes = new Map(st.lanes);
      for (const [key, batch] of byLane) {
        const lane = lanes.get(key) ?? { key, agent: batch[0].agent, events: [], lastTs: batch[0].ts };
        // keep a bounded tail per lane so the wall feed stays light
        const events = lane.events.concat(batch).slice(-60);
        let newest = lane.lastTs;
        for (const ev of batch) if (ev.ts > newest) newest = ev.ts;
        lanes.set(key, { ...lane, events, lastTs: newest });
      }
      pruneLanes(lanes, lastTs, lastKey);
      return { lanes, eventCount: st.eventCount + added };
    }),
}));
