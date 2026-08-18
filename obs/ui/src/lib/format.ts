// Small pure formatters shared across views. No deps.

export function formatCost(usd: number): string {
  if (!usd) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Higher-precision cost for detail chips (matches the mockup's $0.4410). */
export function formatCostPrecise(usd: number): string {
  if (!usd) return "$0";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Compact token count: 19500 → "19.5k", 12000000 → "12.0M". Agentic runs reach
 *  millions of tokens once cache reads are counted, so "k" alone stops scanning
 *  (12M would read "12000.0k"). */
export function formatTokens(n: number): string {
  if (!n) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m${String(rem).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Span/latency duration — sub-second precision, then m/s. */
export function formatSpanDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const s = Math.round(d / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/** Compact run timestamp: time-of-day if today, "Mon D" this year, else "Mon D, YYYY". */
export function formatWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const md = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.getFullYear() === n.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** Project = trailing path segment of the run's cwd. */
export function projectOf(cwd?: string): string {
  if (!cwd) return "—";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

/** Stable 1..5 color bucket for an agent name (matches --a1..--a5). */
export function agentColor(agent: string): number {
  let h = 0;
  for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
  return (h % 5) + 1;
}

export type RunStatus = "live" | "pass" | "fail" | "open";

export function runStatus(verdictStatus: string | undefined, live: boolean): RunStatus {
  // A terminal verdict wins over recency: a just-scored run reads pass/fail
  // even while its last events are still inside the live window.
  const v = (verdictStatus || "").toLowerCase();
  if (v === "pass") return "pass";
  if (v === "fail") return "fail";
  return live ? "live" : "open";
}
