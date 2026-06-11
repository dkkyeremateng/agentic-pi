// ABOUTME: Event-bus contract between the standalone `dispatch` extension and any
// workflow dashboard (agent-workflow) that wants to mirror dispatch
// activity. The dispatch extension OWNS dispatch_agent + select_agents and emits a
// phase snapshot on every state change; dashboards subscribe (pi.events.on) and
// render from it. This keeps dispatch decoupled from the workflow UIs — no shared
// mutable state, just notifications over pi.events.

import type { PhaseState } from "./workflow-core";

// Channel emitted by extensions/dispatch.ts on every dispatch state change
// (phase created, running, done/error). Subscribers re-render their dashboard.
export const DISPATCH_UPDATE = "dispatch:update";

// Snapshot payload: the full current dispatch phase list plus timing, so a
// subscriber renders the dashboard directly without tracking incremental deltas.
// Free-form dispatch and the automated pipeline are mutually exclusive in time
// (dispatchAgentCore refuses while s.running), so a subscriber can replace its
// dispatch-origin phases with `phases` wholesale.
export interface DispatchUpdate {
    phases: PhaseState[];
    dispatchMode: boolean;
    dispatchElapsedMs: number;
}
