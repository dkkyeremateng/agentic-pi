// Dashboard client for the agent observability server. Vanilla JS, no build.
// Three views over the same SSE stream — Swimlane, Single, Race — and it is
// multi-instance aware: lanes are keyed by project+agent (from each event's
// cwd), so the same agent name in different projects stays on separate lanes.
// A project filter in the header scopes the views to one instance.

const FEED_MAX = 14; // rows kept in a swimlane lane
const EVENTS_CAP = 4000; // events kept per lane

const lanes = new Map(); // key -> { key, agent, project, cwd, events[], rollup, card, btn }
const projects = new Set();
const hidden = new Set(); // lane keys toggled off via the sidebar
let view = "swimlane";
let selected = null; // lane key
let search = "";
let projectFilter = ""; // "" = all projects
let runFilter = ""; // "" = all runs; scopes swimlane/single/race to one run (single project only)
let runFilterAuto = true; // when true, the run filter follows the live (or last) run
let autoscroll = true;
let laneOrd = 0; // creation order, for stable #n suffixing of same-agent instances

const $ = (id) => document.getElementById(id);

// ── lane identity (project + agent) ──────────────────────────────────────────
function projectName(cwd) {
    if (!cwd) return "local";
    const parts = String(cwd).split("/").filter(Boolean);
    return parts[parts.length - 1] || "local";
}
// Key by sessionId too, so parallel (and sequential re-dispatched) instances of
// the SAME agent get their own lane instead of interleaving into one. Each spawned
// agent is a distinct process with a unique sessionId; the orchestrator is one
// session for the whole run, so single-instance agents are unaffected.
function laneKey(ev) {
    return (ev.cwd || "") + "\u0000" + ev.agent + "\u0000" + (ev.sessionId || "");
}

// In-scope instances of one agent (same project+agent, passing the current
// project+run filters), in creation order. Scope-aware so "#n" only appears when
// the agent actually has several instances IN VIEW (e.g. parallel in the selected
// run) — a lone instance in the selected run shows just its name.
function laneSiblings(a) {
    const out = [];
    for (const l of lanes.values())
        if (l.cwd === a.cwd && l.agent === a.agent && laneInScope(l))
            out.push(l);
    return out.sort((x, y) => x.ord - y.ord);
}
// Recompute display labels for an agent instance group and push them to the
// DOM: a bare name when it ran once, "agent #n" when it has several instances.
function refreshGroupLabels(a) {
    const sibs = laneSiblings(a);
    sibs.forEach((l, i) => {
        l.label = sibs.length > 1 ? l.agent + " #" + (i + 1) : l.agent;
        if (l.card && l.card.agentEl) l.card.agentEl.textContent = l.label;
        if (l.btn)
            l.btn.title =
                l.project + " / " + l.label + " click to show/hide";
    });
}

// ── event categories (filter chips) ──────────────────────────────────────────
const CATS = [
    ["session", "session"],
    ["turn", "turn"],
    ["user", "user"],
    ["assistant", "assistant"],
    ["thinking", "thinking"],
    ["tool", "tool call"],
    ["result", "tool result"],
    ["model", "model"],
    ["dispatch", "dispatch"],
    ["compaction", "compaction"],
    ["error", "error"],
];
const filters = new Set(CATS.map((c) => c[0]));

function categoryOf(ev) {
    switch (ev.type) {
        case "session_start":
        case "boot":
        case "session_end":
            return "session";
        case "turn_start":
        case "turn_end":
            return "turn";
        case "message":
            return (ev.payload && ev.payload.kind) || "assistant";
        case "tool_start":
            return "tool";
        case "tool_end":
            return "result";
        case "model_change":
            return "model";
        case "dispatch_start":
        case "dispatch_retry":
        case "dispatch_end":
            return "dispatch";
        case "compaction":
            return "compaction";
        case "error":
            return "error";
        default:
            return "session";
    }
}

