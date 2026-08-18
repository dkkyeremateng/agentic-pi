// §4.3 lane keying / root-agent normalization. A "lane" is one agent session
// (one card on the Live wall). Root agents (no `parent`) anchor a lane;
// sub-agents get their own lane but can be grouped under the orchestrator by
// `parent`.
import type { ObsEvent } from "../types";

/** A session is a lane. Keying by sessionId keeps re-used agent names
 *  (two "scout" runs) on distinct cards. */
export function laneKey(ev: ObsEvent): string {
  return ev.sessionId;
}

/** Root = an agent with no parent (the orchestrator / top session). */
export function isRoot(ev: ObsEvent): boolean {
  return !ev.parent;
}

/** Display name for a lane. Root sessions sometimes arrive unnamed; fall back
 *  to a stable label so the card isn't blank. */
export function normalizeAgent(ev: ObsEvent): string {
  const a = (ev.agent || "").trim();
  if (a) return a;
  return isRoot(ev) ? "root" : "agent";
}
