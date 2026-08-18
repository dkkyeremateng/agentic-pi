// Agent scope for the open run's detail tabs. The pick lives in the store so
// narrowing survives a tab switch — you can find a call in Events, flip to
// Trace, and still be looking at the same agent (or the same instance of it).
import { useMemo } from "react";
import { useObs } from "../data/store";
import { Combo, type ComboOption } from "../lib/Combo";
import { agentInstances, decodeScope, resolveScope, scopeOptions, type ScopeOption } from "./agentScope";
import type { ObsEvent } from "../data/types";

export { inScope, shortSession } from "./agentScope";
export type { ScopeOption } from "./agentScope";

/** Picker options straight from an event stream — the shape most tabs hold.
 *  Includes per-instance entries for any role dispatched more than once. */
export function useEventScopes(events: readonly ObsEvent[]): ScopeOption[] {
  return useMemo(() => scopeOptions(agentInstances(events)), [events]);
}

/** Resolve the stored pick against what this tab can offer. A tab whose data
 *  only aggregates per role (Stats, off the digest) passes role-only options
 *  and gets the role-level scope back. */
export function useAgentScope(options: readonly ScopeOption[]): ScopeOption | null {
  const agent = useObs((s) => s.runAgentFilter);
  const sessionId = useObs((s) => s.runAgentSession);
  return useMemo(() => resolveScope({ agent, sessionId }, options), [agent, sessionId, options]);
}

/** The picker — hidden when there's only ever one thing to pick. */
export function AgentFilter({ options, width = 190 }: { options: readonly ScopeOption[]; width?: number | string }) {
  const setScope = useObs((s) => s.setRunAgentScope);
  const scope = useAgentScope(options);
  const comboOptions = useMemo<ComboOption[]>(
    () => [
      { value: "", label: "All agents", sub: String(options.filter((o) => !o.sessionId).length) },
      ...options.map((o) => ({ value: o.value, label: o.label, sub: o.count.toLocaleString() })),
    ],
    [options],
  );
  if (options.length <= 1) return null;
  return (
    <Combo
      value={scope?.value ?? ""}
      options={comboOptions}
      onChange={(v) => {
        const { agent, sessionId } = v ? decodeScope(v) : { agent: "", sessionId: "" };
        setScope(agent, sessionId);
      }}
      width={width}
      ariaLabel="Filter this run by agent"
    />
  );
}
