// Types mirrored from the obs-server (utils/obs/obs-events.ts,
// obs-run-index.ts, obs-server-core.ts). Once the server is running we can
// regenerate these from /api/openapi.yaml via openapi-typescript; until then
// these hand-written shapes are the contract.

export type ObsEventType =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "tool_start"
  | "tool_end"
  | "message"
  | "error"
  | "lifecycle"
  | "tool"
  | "turn"
  | (string & {});

export interface ObsEvent {
  v: number;
  seq: number;
  ts: number;
  sessionId: string;
  agent: string;
  cwd?: string;
  runId?: string;
  parent?: string;
  name?: string;
  type: ObsEventType;
  payload: Record<string, unknown>;
}

export interface RunVerdict {
  status: string; // "pass" | "fail" | "open"
  outcome?: string;
  note?: string;
  source?: string; // "workflow" | "cli" | "api"
  ts: number;
}

export interface RunMeta {
  runId: string;
  firstTs: number;
  lastTs: number;
  // Active makespan (ms): union of leaf turn/tool spans — idle gaps and any
  // abandoned/lingering tail removed, concurrent work counted once. The run's
  // meaningful latency; lastTs - firstTs over-reports idle time. Optional so runs
  // from an older server (no field) fall back to wall-clock.
  activeMs?: number;
  events: number;
  agents: string[];
  cwd?: string;
  name?: string;
  request?: string; // root's first prompt — title fallback for unnamed runs
  costUsd: number;
  tokens?: number;
  toolCalls?: number;
  models?: string[];
  modelCost?: Record<string, number>;
  errors: number;
  verdict?: RunVerdict;
  startOffset: number;
  endOffset: number;
}

export interface AgentRollup {
  agent: string;
  events: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  tokens: number;
  costUsd: number;
  lastType: string;
  lastTs: number;
  active: boolean;
}

export interface LiveSummary {
  sessions: number;
  totalEvents: number;
  totalTokens: number;
  totalCostUsd: number;
  totalErrors: number;
  agents: AgentRollup[];
  firstTs?: number;
  lastTs?: number;
}

export type VerdictStatus = "pass" | "fail" | "open";

// LLM run explanation (GET /api/runs/:id/explain). `enabled:false` when the
// server isn't configured for it (PI_OBS_LLM off).
export interface RunExplain {
  enabled: boolean;
  hint?: string; // shown when enabled === false
  error?: string; // provider/spawn error (enabled, but the call failed)
  narrative?: string;
  recommendations?: string[];
  model?: string;
  ts?: number;
  cached?: boolean;
}

// LLM-as-judge rubric score (GET /api/runs/:id/judge). Same opt-in shape as
// RunExplain: enabled:false when PI_OBS_LLM is off; error on a provider failure.
export interface JudgeCriterion {
  name: string;
  score: number; // 0..100
  reason: string;
}
export interface RunJudgement {
  enabled: boolean;
  hint?: string;
  error?: string;
  score?: number; // 0..100 overall
  reason?: string;
  criteria?: JudgeCriterion[];
  model?: string;
  ts?: number;
  cached?: boolean;
}

// Prompt/config registry (GET /api/prompts) — per-agent boot snapshots,
// versioned across runs.
export interface PromptVersion {
  promptHash: string;
  promptChars: number;
  model: string;
  tools: string[];
  skills: string[];
  contextFiles: string[];
  firstTs: number;
  lastTs: number;
  runs: string[];
  sessions: number;
}
export interface AgentPrompts {
  agent: string;
  versions: PromptVersion[]; // newest first
}

// Chat (POST /api/chat → SSE). One frame per event from pi's --mode json stream.
export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; phase: "start" | "end"; name: string; detail?: string }
  | { type: "done"; text: string; costUsd: number; tokens?: number; model?: string }
  | { type: "approval"; toolCallId: string; name: string; input?: unknown } // agent is waiting for human allow/deny
  | { type: "error"; error: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  costUsd?: number;
  tokens?: number; // total tokens for the turn (input + output)
  model?: string;
  tools?: string[]; // tools the agent ran during this turn (in order, capped)
  stopped?: boolean; // the user interrupted this turn
  images?: { url: string; name?: string }[]; // image attachments (served by the obs-server)
  error?: string;
}
export interface ChatSession {
  id: string; // also pi's --session-id (continuity)
  title: string;
  model: string; // "" = server default
  toolsEnabled: boolean;
  createdTs: number;
  messages: ChatMessage[];
  // Attach to a LIVE run: messages are steered into the running agent (via its
  // control channel) and its reply streams back. Only sessions that are alive
  // right now are attachable. attachedSessionId is the live obs session id.
  attachedRunId?: string;
  attachedSessionId?: string; // the live agent's obs session id to steer
  attachedAgent?: string; // which agent (label only)
  attachedCwd?: string; // the agent's cwd (label only)
  attachedTools?: string[]; // the live agent's toolset, captured at attach (label only)
  attachedLive?: boolean; // true = steer the live agent (vs a plain spawned chat)
  deliverMode?: "steer" | "followUp"; // how a steered message is delivered (default followUp)
  requireApproval?: boolean; // gate the live agent's risky tools on human approval
}

/** An agent running right now with an open control channel — attachable. */
export interface LiveSession {
  sessionId: string;
  agent: string;
  runId?: string;
  cwd: string;
  model?: string;
  tools?: string[];
  startedTs: number;
}

// Prompt playground one-shot completion (POST /api/playground).
export interface PlaygroundResp {
  enabled: boolean;
  hint?: string;
  error?: string;
  output?: string;
  model?: string;
  ts?: number;
}

// One-sentence LLM summary of an arbitrary chunk (POST /api/summarize).
export interface SummarizeResp {
  enabled: boolean;
  hint?: string;
  error?: string;
  summary?: string;
  cached?: boolean;
}

// ── digest (utils/obs/obs-explain.ts) ──
export interface AgentDigest {
  agent: string;
  instances: number;
  firstTs: number;
  lastTs: number;
  turns: number;
  costUsd: number;
  tokens: number;
  turnMs: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  compactions: number;
  prefillAvgMs: number;
  maxContextPct: number | null;
  model?: string;
}

export interface ToolDigest {
  tool: string;
  calls: number;
  totalMs: number;
  errors: number;
}

export type AnomalyKind =
  | "retry"
  | "dispatch-error"
  | "truncated"
  | "tool-error"
  | "provider-error"
  | "slow-tool"
  | "slow-turn"
  | "cost-outlier"
  | "compaction"
  | "context";

export interface Anomaly {
  kind: AnomalyKind;
  agent?: string;
  detail: string;
}

export interface RunDigest {
  runId: string;
  name?: string;
  cwd?: string;
  startTs: number;
  endTs: number;
  wallMs: number;
  activeMs?: number; // active makespan (see RunMeta.activeMs); optional for old servers
  busyMs?: number; // leaf work summed without collapsing overlap; busyMs/activeMs = parallelism
  verdict?: { status: string; outcome?: string; note?: string; source?: string };
  // verdicts scoped to a single agent's run, keyed by agent name
  agentVerdicts?: Record<string, { status: string; outcome?: string; note?: string; source?: string }>;
  totals: {
    costUsd: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    turns: number;
    toolCalls: number;
    toolErrors: number;
    providerErrors: number;
    retries: number;
    compactions: number;
  };
  models: string[];
  agents: AgentDigest[];
  tools: ToolDigest[];
  anomalies: Anomaly[];
}
