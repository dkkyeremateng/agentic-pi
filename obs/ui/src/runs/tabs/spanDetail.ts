// Derive the Trace detail panel for a selected span — the chips + Input/Output
// blocks the mockup shows. Pure + testable; degrades to raw payloads when no
// text is present.
import type { ObsEvent } from "../../data/types";
import type { Span } from "../../data/derive/trace";
import { laneRollup } from "../../data/derive/laneRollup";
import { summarizeToolArgs, summarizeToolResult } from "../../lib/toolArgs";
import { formatCostPrecise, formatSpanDur, formatTokens } from "../../lib/format";

export interface DetailChip {
  k: string;
  v: string;
  warn?: boolean;
}
export interface IOBlock {
  role: string;
  text: string;
}
// The verdict/metrics strip shown under an agent span (passed/failed turns,
// retry rate, cost vs the run's median turn).
export interface SpanStats {
  turnsPassed: number;
  turnsFailed: number;
  turnsTotal: number;
  retries: number;
  retryRate: number; // retries / turns, 0 when no turns
  costDeltaPct: number | null; // agent mean turn cost vs run median turn cost
}
export interface SpanDetail {
  chips: DetailChip[];
  input?: IOBlock;
  output?: IOBlock;
  meta: { k: string; v: string }[];
  raw: ObsEvent[];
  stats?: SpanStats; // agent spans only
}

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((m, n) => m - n);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** A turn "failed" if its turn_end reports an error/abnormal stop, or an error
 *  event or failing tool occurred inside that turn's window. */
export function turnOutcomes(sess: ObsEvent[]): { passed: number; failed: number } {
  const ordered = [...sess].sort((a, b) => a.ts - b.ts);
  const turns = ordered.filter((e) => e.type === "turn_end");
  let prev = ordered.length ? ordered[0].ts - 1 : 0;
  let passed = 0;
  let failed = 0;
  for (const t of turns) {
    const p = t.payload as Record<string, unknown>;
    const inWindow = ordered.filter((e) => e.ts > prev && e.ts <= t.ts && e !== t);
    const failedTurn =
      p.isError === true ||
      p.ok === false ||
      /error|refus|max_tokens|cancel|abort/i.test(s(p.stopReason)) ||
      inWindow.some(
        (e) =>
          e.type === "error" ||
          (e.type === "tool_end" && (e.payload?.isError === true || e.payload?.ok === false)),
      );
    if (failedTurn) failed++;
    else passed++;
    prev = t.ts;
  }
  return { passed, failed };
}

export function spanDetail(span: Span, events: ObsEvent[]): SpanDetail {
  const sessionId = span.id.split("#")[0];
  const sess = events.filter((e) => e.sessionId === sessionId);
  const latency = formatSpanDur(span.endTs - span.startTs);

  // shared Metadata + Raw (the v4 detail sub-tabs that fit our data model).
  const within = sess.filter((e) => e.ts >= span.startTs && e.ts <= span.endTs);
  const raw = within.slice(0, 12);
  const parent = sess.find((e) => e.parent)?.parent;
  const model = s(sess.find((e) => typeof e.payload?.model === "string")?.payload?.model);
  const meta: { k: string; v: string }[] = [
    { k: "kind", v: span.kind },
    { k: "agent", v: span.agent },
  ];
  if (parent) meta.push({ k: "parent", v: parent });
  if (model) meta.push({ k: "model", v: model });
  meta.push({ k: "session", v: sessionId });
  meta.push({ k: "started", v: new Date(span.startTs).toLocaleTimeString() });
  meta.push({ k: "ended", v: new Date(span.endTs).toLocaleTimeString() });
  meta.push({ k: "events", v: String(within.length) });

  if (span.kind === "agent") {
    const r = laneRollup(sess);
    const retries = events.filter(
      (e) => e.type === "dispatch_retry" && s(e.payload?.agent) === span.agent,
    ).length;
    const chips: DetailChip[] = [
      { k: "span", v: span.agent },
      { k: "latency", v: latency },
      { k: "tokens", v: formatTokens(r.tokens) },
      { k: "cost", v: formatCostPrecise(r.costUsd) },
    ];
    if (r.ctxPct != null) chips.push({ k: "ctx", v: `${r.ctxPct}%` });
    chips.push({ k: "tools", v: String(r.toolCalls) });
    if (retries > 0) chips.push({ k: "retry", v: `×${retries}`, warn: true });

    // verdict/metrics strip: passed vs failed turns, retry rate, cost vs P50.
    const { passed, failed } = turnOutcomes(sess);
    const turnsTotal = passed + failed;
    const agentTurnCosts = sess
      .filter((e) => e.type === "turn_end")
      .map((e) => num((e.payload as Record<string, unknown>).costUsd))
      .filter((c) => c > 0);
    const runTurnCosts = events
      .filter((e) => e.type === "turn_end")
      .map((e) => num((e.payload as Record<string, unknown>).costUsd))
      .filter((c) => c > 0);
    const p50 = median(runTurnCosts);
    const agentMean = agentTurnCosts.length
      ? agentTurnCosts.reduce((a, b) => a + b, 0) / agentTurnCosts.length
      : 0;
    const stats: SpanStats = {
      turnsPassed: passed,
      turnsFailed: failed,
      turnsTotal,
      retries,
      retryRate: turnsTotal ? retries / turnsTotal : 0,
      costDeltaPct: p50 > 0 && agentMean > 0 ? Math.round(((agentMean - p50) / p50) * 100) : null,
    };

    // Input: the dispatch task that launched this agent (emitted on the parent).
    const disp = events.filter((e) => e.type === "dispatch_start" && s(e.payload?.agent) === span.agent).pop();
    const input: IOBlock = disp
      ? { role: "dispatch task", text: s(disp.payload?.task) || "(no task text)" }
      : { role: "session", text: r.model ? `session on ${r.model}` : "session started" };

    // Output: the latest message text, else the latest turn summary, else status.
    const lastMsg = [...sess].reverse().find((e) => e.type === "message" && (e.payload?.text || e.payload?.content));
    const lastTurn = [...sess].reverse().find((e) => e.type === "turn_end");
    let output: IOBlock;
    if (lastMsg) {
      output = { role: "message", text: s(lastMsg.payload.text) || s(lastMsg.payload.content) };
    } else if (lastTurn) {
      const p = lastTurn.payload as Record<string, unknown>;
      const tok = formatTokens(num((p.tokens as { total?: number })?.total));
      output = {
        role: `turn ${num(p.turnIndex)} (latest)`,
        text: `${s(p.stopReason) || "end_turn"} · ${tok} tok · ${formatCostPrecise(num(p.costUsd))}`,
      };
    } else {
      output = { role: "status", text: r.active && !r.ended ? "running…" : "done" };
    }
    return { chips, input, output, meta, raw, stats };
  }

  if (span.kind === "tool") {
    const start = sess.find((e) => e.type === "tool_start" && e.ts === span.startTs);
    const end = sess.find((e) => e.type === "tool_end" && e.ts === span.endTs);
    const { tool, text } = summarizeToolArgs((start?.payload ?? end?.payload) as Record<string, unknown>);
    const chips: DetailChip[] = [
      { k: "tool", v: tool },
      { k: "latency", v: latency },
      { k: "status", v: span.status, warn: span.status === "error" },
    ];
    const input: IOBlock = { role: tool, text: text || "(no args)" };
    const resultText = summarizeToolResult(end?.payload as Record<string, unknown> | undefined);
    const output: IOBlock = {
      role: span.status === "error" ? "error" : "result",
      text: resultText || (span.status === "error" ? "failed" : "ok"),
    };
    return { chips, input, output, meta, raw };
  }

  // llm (turn)
  const end = sess.find((e) => e.type === "turn_end" && e.ts === span.endTs);
  const p = (end?.payload ?? {}) as Record<string, unknown>;
  const chips: DetailChip[] = [
    { k: "turn", v: span.label },
    { k: "latency", v: latency },
    { k: "tokens", v: formatTokens(num((p.tokens as { total?: number })?.total)) },
    { k: "cost", v: formatCostPrecise(num(p.costUsd)) },
  ];
  if (typeof p.contextPct === "number") chips.push({ k: "ctx", v: `${p.contextPct}%` });
  const input: IOBlock = { role: "prompt", text: `turn ${num(p.turnIndex)} · ${s(p.model) || "model"}` };
  const output: IOBlock = {
    role: "completion",
    text: `${s(p.stopReason) || "end_turn"} · ${formatTokens(num((p.tokens as { total?: number })?.total))} tok`,
  };
  return { chips, input, output, meta, raw };
}
