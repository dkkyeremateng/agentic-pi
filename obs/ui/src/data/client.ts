// Typed fetchers over the obs-server /api surface. Same-origin in prod
// (served at /app), dev-proxied to 127.0.0.1:7616 by vite.config.ts.
import type {
  AgentPrompts,
  ChatEvent,
  ChatSession,
  LiveSession,
  LiveSummary,
  ObsEvent,
  PlaygroundResp,
  RunDigest,
  RunExplain,
  RunJudgement,
  RunMeta,
  SummarizeResp,
  VerdictStatus,
} from "./types";

import { authHeaders, withToken, promptForToken } from "./auth";
// Resolved obs-server base (same-origin "/api" by default; overridable so one
// build can target any pi agent — see config.ts). Every fetcher below uses it.
import { API_BASE as API } from "./config";

// EventSource can only GET, so chat messages ride the query string; proxies and
// servers commonly cap request lines around 16k, so reject well before that
// with an actionable error instead of an opaque EventSource failure.
const MAX_SSE_URL = 12000;

// Shared response gate for every fetcher. Three statuses carry an actionable
// meaning worth translating; anything else non-2xx becomes a descriptive Error.
//   401 — the server wants its shared-secret token → open the TokenGate.
//   403 — the server's cross-origin guard (open/no-token mode) rejected this
//         browser Origin → tell the user how to allow it (token, or allowlist).
//   503 — the LLM/chat spawn cap is saturated → suggest a retry.
function ensureOk(res: Response, ctx: string): Response {
  if (res.status === 401) {
    promptForToken();
    throw new Error(`401 unauthorized — ${ctx}`);
  }
  if (res.status === 403) {
    throw new Error(
      `403 forbidden — the obs-server rejected this dashboard's origin. ` +
        `Set PI_OBS_TOKEN on the server (then enter it here), or add this ` +
        `origin to PI_OBS_ALLOWED_ORIGINS on the server. (${ctx})`,
    );
  }
  if (res.status === 503) {
    throw new Error(
      `503 — the obs-server is busy (too many concurrent LLM/chat requests); retry shortly. (${ctx})`,
    );
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${ctx}`);
  return res;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API}${path}`, { signal, headers: authHeaders() });
  ensureOk(res, `${API}${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  summary: (signal?: AbortSignal) => get<LiveSummary>("/summary", signal),

  runs: (params: { project?: string; since?: number; limit?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.project) q.set("project", params.project);
    if (params.since != null) q.set("since", String(params.since));
    if (params.limit != null) q.set("limit", String(params.limit));
    const qs = q.toString();
    return get<RunMeta[]>(`/runs${qs ? `?${qs}` : ""}`, signal);
  },

  run: (id: string, signal?: AbortSignal) => get<RunMeta>(`/runs/${encodeURIComponent(id)}`, signal),

  runEvents: (id: string, signal?: AbortSignal) =>
    get<ObsEvent[]>(`/runs/${encodeURIComponent(id)}/events`, signal),

  digest: (id: string, signal?: AbortSignal) =>
    get<RunDigest>(`/runs/${encodeURIComponent(id)}/digest?format=json`, signal),

  explain: (id: string, signal?: AbortSignal) =>
    get<RunExplain>(`/runs/${encodeURIComponent(id)}/explain`, signal),

  judge: (id: string, signal?: AbortSignal) =>
    get<RunJudgement>(`/runs/${encodeURIComponent(id)}/judge`, signal),

  summarize: async (text: string, kind: string, signal?: AbortSignal) => {
    const res = await fetch(`${API}/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text, kind }),
      signal,
    });
    ensureOk(res, `${API}/summarize`);
    return res.json() as Promise<SummarizeResp>;
  },

  search: (q: string, limit = 300, signal?: AbortSignal) =>
    get<ObsEvent[]>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`, signal),

  prompts: (signal?: AbortSignal) => get<AgentPrompts[]>("/prompts", signal),

  // Stream a chat turn over SSE (GET + EventSource — proxies cleanly through the
  // vite dev server, which buffers POST streams). Resolves on the terminal
  // done/error frame; closes the source so EventSource doesn't auto-reconnect
  // and re-spawn pi.
  chatStream: (
    req: { sessionId: string; text: string; model?: string; tools?: boolean; cwd?: string; forkFrom?: string; imageIds?: string[] },
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ) =>
    new Promise<void>((resolve, reject) => {
      const q = new URLSearchParams({ sessionId: req.sessionId, text: req.text });
      if (req.model) q.set("model", req.model);
      if (req.tools) q.set("tools", "1");
      if (req.cwd) q.set("cwd", req.cwd);
      if (req.forkFrom) q.set("forkFrom", req.forkFrom);
      if (req.imageIds?.length) q.set("imageIds", req.imageIds.join(","));
      const url = withToken(`${API}/chat?${q.toString()}`);
      if (url.length > MAX_SSE_URL) {
        reject(new Error(`message too large (${url.length} chars encoded, limit ${MAX_SSE_URL}) — shorten it or attach it as a file`));
        return;
      }
      const es = new EventSource(url);
      let finished = false;
      const end = () => {
        finished = true;
        es.close();
      };
      // stop: closing the source drops the server connection, whose `close`
      // handler kills the spawned pi process (no orphan).
      if (signal) {
        if (signal.aborted) {
          end();
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          if (finished) return;
          end();
          resolve();
        });
      }
      es.onmessage = (m) => {
        let e: ChatEvent;
        try {
          e = JSON.parse(m.data) as ChatEvent;
        } catch {
          return;
        }
        onEvent(e);
        if (e.type === "done" || e.type === "error") {
          end();
          resolve();
        }
      };
      es.onerror = () => {
        if (finished) return; // normal close after the terminal frame
        end();
        // EventSource can't expose the HTTP status; the usual cause is the
        // server missing /api/chat (needs a restart) or chat being disabled.
        reject(new Error("couldn't reach /api/chat — restart the server (./run.sh --restart) and ensure PI_OBS_LLM=1"));
      };
    }),

  // Upload an image attachment; returns an id the chat endpoints resolve, plus
  // a URL to render a thumbnail.
  uploadImage: async (file: File) => {
    const dataB64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    const res = await fetch(`${API}/chat-upload`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: file.name, mimeType: file.type, dataB64 }),
    });
    ensureOk(res, `${API}/chat-upload`);
    const { id, name } = (await res.json()) as { id: string; name: string };
    return { id, name, url: `${API}/uploads/${id}` };
  },

  // Server-side chat persistence (survives cache clear; shared across browsers).
  getChats: (signal?: AbortSignal) => get<{ chats: ChatSession[] }>("/chats", signal),
  putChats: async (chats: ChatSession[]) => {
    const res = await fetch(`${API}/chats`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ chats }),
    });
    ensureOk(res, `${API}/chats`);
    return res.json() as Promise<{ ok: boolean; count: number }>;
  },

  // Agents running right now with a control channel — the only attachable ones.
  liveSessions: (signal?: AbortSignal) => get<LiveSession[]>("/live-sessions", signal),

  // Approve/deny a tool the live agent paused on (HITL gate).
  chatApprove: async (sessionId: string, toolCallId: string, decision: "allow" | "deny") => {
    const q = new URLSearchParams({ sessionId, toolCallId, decision });
    const res = await fetch(`${API}/chat-approve?${q.toString()}`, { headers: authHeaders() });
    ensureOk(res, `${API}/chat-approve`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  // Steer a LIVE agent: send a prompt into the running session and stream its
  // reply back. Same SSE/EventSource transport as chatStream (GET so it proxies
  // through the vite dev server). Resolves on the terminal done/error frame.
  chatLiveStream: (
    req: { sessionId: string; text: string; deliverAs?: "steer" | "followUp"; approve?: boolean; imageIds?: string[] },
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ) =>
    new Promise<void>((resolve, reject) => {
      const q = new URLSearchParams({ sessionId: req.sessionId, text: req.text });
      if (req.deliverAs) q.set("deliverAs", req.deliverAs);
      if (req.approve) q.set("approve", "1");
      if (req.imageIds?.length) q.set("imageIds", req.imageIds.join(","));
      const url = withToken(`${API}/chat-live?${q.toString()}`);
      if (url.length > MAX_SSE_URL) {
        reject(new Error(`message too large (${url.length} chars encoded, limit ${MAX_SSE_URL}) — shorten it`));
        return;
      }
      const es = new EventSource(url);
      let finished = false;
      const end = () => {
        finished = true;
        es.close();
      };
      // stop: closing the source makes the server signal the agent to abort.
      if (signal) {
        if (signal.aborted) {
          end();
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          if (finished) return;
          end();
          resolve();
        });
      }
      es.onmessage = (m) => {
        let e: ChatEvent;
        try {
          e = JSON.parse(m.data) as ChatEvent;
        } catch {
          return;
        }
        onEvent(e);
        if (e.type === "done" || e.type === "error") {
          end();
          resolve();
        }
      };
      es.onerror = () => {
        if (finished) return;
        end();
        reject(new Error("couldn't reach /api/chat-live — is the server running and the session still live?"));
      };
    }),

  playground: async (system: string, input: string, model?: string) => {
    const res = await fetch(`${API}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ system, input, ...(model ? { model } : {}) }),
    });
    ensureOk(res, `${API}/playground`);
    return res.json() as Promise<PlaygroundResp>;
  },

  // Relay a payload to the user's webhook via the server (avoids browser CORS).
  notify: async (url: string, payload: unknown) => {
    const res = await fetch(`${API}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ url, payload }),
    });
    ensureOk(res, `${API}/notify`);
    return res.json() as Promise<{ ok: boolean; status?: number; error?: string }>;
  },

  setVerdict: async (id: string, status: VerdictStatus, note?: string, agent?: string) => {
    const res = await fetch(`${API}/runs/${encodeURIComponent(id)}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ status, note, ...(agent ? { agent } : {}) }),
    });
    ensureOk(res, `${API}/runs/${encodeURIComponent(id)}/verdict`);
    return res.json();
  },
};
