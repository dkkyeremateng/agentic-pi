import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    renderLspServers,
    renderTodos,
    renderStatusWidget,
    STATUS_WIDGET_MAX_LINES,
    shouldRepaint,
    repaintIntervalFor,
    phaseTitleOnly,
    renderRichCard,
    type LspServerInfo,
} from "./workflow-widgets";

// A theme that returns text unchanged so assertions read on the raw content.
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("renderLspServers", () => {
    it("returns [] when there are no relevant servers", () => {
        assert.deepEqual(renderLspServers([], theme), []);
        assert.deepEqual(renderLspServers(undefined as any, theme), []);
    });

    it("renders a header plus one row per server", () => {
        const servers: LspServerInfo[] = [
            {
                server: "typescript-language-server",
                extensions: [".ts", ".tsx", ".js"],
                installed: true,
            },
            { server: "gopls", extensions: [".go"], installed: false },
        ];
        const out = renderLspServers(servers, theme);
        assert.equal(out.length, 3); // header + 2 rows
        assert.match(out[0], /LSP Servers/);
        assert.match(out[1], /✓ typescript-language-server\s+\.ts \.tsx \.js/);
        assert.ok(!out[1].includes("not installed"));
        assert.match(out[2], /○ gopls\s+\.go\s+not installed/);
    });
});

describe("renderTodos", () => {
    const items = [
        { label: "Phase 1: A", done: true },
        { label: "Phase 2: B", done: false },
        { label: "Phase 3: C", done: false },
    ];

    it("returns [] when there are no items", () => {
        assert.deepEqual(renderTodos([], theme), []);
        assert.deepEqual(renderTodos(undefined as any, theme), []);
    });

    it("marks done [x], the first pending [•] while running, others [ ]", () => {
        const out = renderTodos(items, theme, { running: true });
        assert.match(out[0], /# Todos/);
        assert.match(out[1], /\[x\] Phase 1: A/);
        assert.match(out[2], /\[•\] Phase 2: B/); // first unfinished = in progress
        assert.match(out[3], /\[ \] Phase 3: C/);
    });

    it("uses [ ] (not [•]) for the first pending when not running", () => {
        const out = renderTodos(items, theme, { running: false });
        assert.match(out[2], /\[ \] Phase 2: B/);
        assert.ok(!out.some((l) => l.includes("[•]")));
    });

    it("clips long labels to the width", () => {
        const out = renderTodos([{ label: "x".repeat(200), done: false }], theme, {
            width: 40,
        });
        assert.ok(out[1].includes("…"));
        assert.ok(out[1].length < 200);
    });

    it("uses a custom title when given (e.g. the reviewer's # Review)", () => {
        const out = renderTodos(items, theme, { title: " # Review" });
        assert.match(out[0], /# Review/);
        assert.ok(!out[0].includes("# Todos"));
    });

    // The empty block used to contribute 0 rows and then jump to N+1 the instant
    // the planner wrote the ledger. pi-tui only force-clears on SHRINK, so that
    // growth is what stranded a second "# Todos" header on screen.
    it("reserves the block with a placeholder instead of collapsing to nothing", () => {
        const out = renderTodos([], theme, { placeholder: "waiting for the plan…" });
        assert.equal(out.length, 2);
        assert.match(out[0], /# Todos/);
        assert.match(out[1], /waiting for the plan…/);
    });

    it("still returns [] with no placeholder, so # Review can splice blindly", () => {
        assert.deepEqual(renderTodos([], theme, { title: " # Review" }), []);
    });

    it("emits exactly one header once the ledger arrives", () => {
        const out = renderTodos(items, theme, {
            running: true,
            placeholder: "waiting for the plan…",
        });
        assert.equal(out.filter((l) => l.includes("# Todos")).length, 1);
        assert.ok(!out.some((l) => l.includes("waiting for the plan")));
    });

    // The placeholder must not cost a row when the ledger lands: 1 header + 1
    // placeholder, then 1 header + N items. Any run with >= 1 phase only ever
    // grows, never shrinks, which is the direction pi-tui handles cleanly.
    it("never shrinks when the placeholder is replaced by a one-phase ledger", () => {
        const before = renderTodos([], theme, { placeholder: "waiting…" }).length;
        const after = renderTodos([{ label: "Phase 1", done: false }], theme, {
            placeholder: "waiting…",
        }).length;
        assert.equal(before, 2);
        assert.equal(after, 2);
    });
});

// ── compact status widget ───────────────────────────────────────────────────
// The sticky widget is a status LINE, not a dashboard. pi budgets extension
// widgets at MAX_WIDGET_LINES = 10; the old five-card view was ~40 rows, and a
// sticky region that size is what made the renderer strand rows. These tests pin
// the two properties that keep it out of that regime: bounded height, and no line
// that can wrap.
describe("renderStatusWidget", () => {
    const phase = (o: any) => ({
        agent: "implementer", label: "Implement", status: "pending",
        elapsed: 0, toolCount: 0, ...o,
    });
    const base = {
        team: "plan-build", running: true, lastStatus: "", iteration: 1, maxLoops: 3,
        elapsedMs: 134000, costUsd: 0.41, contextPct: 12.4, width: 100,
    };

    it("stays within the line budget even with everything to show", () => {
        const out = renderStatusWidget({
            ...base,
            phases: Array.from({ length: 8 }, (_, i) =>
                phase({ agent: `a${i}`, label: `P${i}`, status: "running", elapsed: 1000 })),
            todos: { done: 2, total: 3 },
            review: { done: 4, total: 7 },
            activity: ["→ read styles.css"],
        } as any, theme);
        assert.ok(out.length <= STATUS_WIDGET_MAX_LINES, `${out.length} lines`);
    });

    it("never emits a line wider than the width it was given", () => {
        // A line one column over wraps to a second physical row while pi counts
        // one, and every row below is then drawn one place off -- permanently.
        const out = renderStatusWidget({
            ...base,
            width: 40,
            phases: [phase({ status: "running", elapsed: 21000, toolCount: 5,
                activeModel: "some/extremely/long/model/identifier/that/will/not/fit" })],
            todos: { done: 2, total: 3 },
            activity: ["→ " + "x".repeat(300)],
        } as any, theme);
        for (const l of out) assert.ok(l.length <= 40, `line ${l.length} > 40: ${l}`);
    });

    it("counts extra parallel agents instead of listing them", () => {
        const out = renderStatusWidget({
            ...base,
            phases: Array.from({ length: 6 }, (_, i) =>
                phase({ agent: `seeker${i}`, status: "running", elapsed: 5000 })),
        } as any, theme);
        assert.ok(out.some((l) => /\+\d+ more running/.test(l)));
    });

    it("shows an idle line with no run in flight", () => {
        const out = renderStatusWidget({
            ...base, team: "", phases: [], running: false, agentCount: 12, teamCount: 4,
        } as any, theme);
        assert.equal(out.length, 2, "no roster passed -> just the header and hint");
        assert.match(out[0], /agent-workflow/);
        assert.match(out[0], /12 agents/);
    });

    it("lists the whole roster on startup when there is room", () => {
        const roster = Array.from({ length: 13 }, (_, i) => ({
            name: `agent${i}`, model: "prov/model",
        }));
        const out = renderStatusWidget({
            ...base, team: "", phases: [], running: false,
            agentCount: 13, teamCount: 6, roster, maxLines: 30,
        } as any, theme);
        for (const r of roster) {
            assert.ok(out.some((l) => l.includes(r.name)), `missing ${r.name}`);
        }
    });

    it("counts the roster overflow rather than dropping it silently", () => {
        const roster = Array.from({ length: 13 }, (_, i) => ({
            name: `agent${i}`, model: "prov/model",
        }));
        const out = renderStatusWidget({
            ...base, team: "", phases: [], running: false,
            agentCount: 13, teamCount: 6, roster, maxLines: 10,
        } as any, theme);
        assert.ok(out.length <= 10);
        assert.ok(out.some((l) => /\+\d+ more/.test(l)), "overflow is counted");
    });

    it("omits ledger counts that have nothing in them", () => {
        const out = renderStatusWidget({
            ...base,
            phases: [phase({ status: "running" })],
            todos: { done: 0, total: 0 },
            review: { done: 0, total: 0 },
        } as any, theme);
        assert.ok(!out.some((l) => l.includes("todos")));
        assert.ok(!out.some((l) => l.includes("review")));
    });

    it("shows an activity tail, newest closest to the prompt", () => {
        const out = renderStatusWidget({
            ...base,
            phases: [phase({ status: "running" })],
            activity: ["first", "second", "third"],
        } as any, theme);
        const idx = ["first", "second", "third"].map((s) => out.findIndex((l) => l.includes(s)));
        assert.ok(idx.every((i) => i >= 0), "all activity rows present");
        assert.deepEqual([...idx].sort((a, b) => a - b), idx, "oldest first, newest last");
    });

    it("keeps the budget when the tail is long AND many agents run", () => {
        // The tail and the running-agent list compete for the same rows; neither
        // may push the widget past pi's MAX_WIDGET_LINES.
        const out = renderStatusWidget({
            ...base,
            phases: Array.from({ length: 6 }, (_, i) =>
                phase({ agent: `a${i}`, status: "running", elapsed: 1000 })),
            activity: Array.from({ length: 12 }, (_, i) => `line ${i}`),
            todos: { done: 1, total: 3 },
        } as any, theme);
        assert.ok(out.length <= STATUS_WIDGET_MAX_LINES, `${out.length} lines`);
    });

    it("grows the tail to fill a taller budget", () => {
        const trail = Array.from({ length: 60 }, (_, i) => `step ${i}`);
        const small = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], activity: trail.slice(-5),
        } as any, theme);
        const tall = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], activity: trail.slice(-40),
            maxLines: 44,
        } as any, theme);
        assert.ok(small.length <= STATUS_WIDGET_MAX_LINES, "default stays in budget");
        assert.ok(tall.length > STATUS_WIDGET_MAX_LINES, "grows when given room");
        assert.ok(tall.length <= 44, "never exceeds the budget it was given");
    });

    it("surfaces the retry attempt when the validator has looped", () => {
        const out = renderStatusWidget({
            ...base, iteration: 2, phases: [phase({ status: "running" })],
        } as any, theme);
        assert.match(out[0], /attempt 2\/3/);
    });
});

// ── absolute-repaint pulse ──────────────────────────────────────────────────
// pi clears stale rows only via clearOnShrink, i.e. when the composed frame gets
// SHORTER. A dashboard of stable height never shrinks, so nothing is ever
// cleared and rows left behind by a pushed-up live region persist for the whole
// session. The pulse makes the frame shrink on purpose, on a clock.
describe("repaintIntervalFor", () => {
    it("stays silent while the widget is inside pi's budget", () => {
        // A repaint here would be flicker for nothing: the renderer does not
        // strand rows at this size.
        assert.equal(repaintIntervalFor(4), 0);
        assert.equal(repaintIntervalFor(STATUS_WIDGET_MAX_LINES), 0);
    });

    it("arms itself the moment the widget grows past the budget", () => {
        // Growing to fill a tall terminal re-enters the regime where a displaced
        // live region leaves rows behind; only an absolute repaint clears them.
        assert.ok(repaintIntervalFor(STATUS_WIDGET_MAX_LINES + 1) > 0);
        assert.ok(repaintIntervalFor(60) > 0);
    });

    it("lets an explicit setting win in both directions", () => {
        assert.equal(repaintIntervalFor(60, 0), 0, "suppress on a large widget");
        assert.equal(repaintIntervalFor(4, 1500), 1500, "force on a small one");
    });
});

describe("shouldRepaint", () => {
    it("never pulses on the first call — nothing is stale yet", () => {
        const s = { last: 0 };
        assert.equal(shouldRepaint(s, 1000, 4000), false);
        assert.equal(s.last, 1000, "first call seeds the clock");
    });

    it("holds until the interval has elapsed, then pulses once", () => {
        const s = { last: 0 };
        shouldRepaint(s, 1000, 4000);
        assert.equal(shouldRepaint(s, 4999, 4000), false);
        assert.equal(shouldRepaint(s, 5000, 4000), true);
        assert.equal(shouldRepaint(s, 5001, 4000), false, "does not pulse twice in a row");
    });

    it("is disabled by a non-positive interval", () => {
        const s = { last: 0 };
        for (const t of [1000, 99999, 1e9]) {
            assert.equal(shouldRepaint(s, t, 0), false);
        }
    });

    it("pulses at a steady rate regardless of how often it is called", () => {
        // Busy run: called every 80ms. Idle run: every 500ms. Both should repaint
        // on the same wall-clock cadence -- that is why this is timed, not a
        // build counter.
        const rate = (step: number) => {
            const s = { last: 0 };
            let n = 0;
            for (let now = 0; now <= 20_000; now += step) if (shouldRepaint(s, now, 4000)) n++;
            return n;
        };
        assert.equal(rate(80), rate(500));
    });
});

describe("renderRichCard per-agent cache hit rate", () => {
    const card = (tokens: any): string =>
        renderRichCard({
            agentKey: "implementer",
            def: { description: "builds", contextWindow: 1_000_000 },
            phases: [
                {
                    agent: "implementer",
                    label: "Implementer",
                    status: "running",
                    contextPct: 2,
                    tokens,
                } as any,
            ],
            colWidth: 70,
            theme,
            model: "m",
            showContext: true,
        }).join("\n");

    it("shows CH on the usage line (cached input / all input)", () => {
        // 13000 / (13000 + 7000) = 65%
        const out = card({ input: 7000, cacheRead: 13000, output: 100, cacheWrite: 0, costUsd: 0.27, contextWindow: 1_000_000 });
        assert.match(out, /CH 65%/);
    });

    it("omits CH when the agent has read no cache", () => {
        const out = card({ input: 7000, cacheRead: 0, output: 100, cacheWrite: 0, costUsd: 0.1, contextWindow: 1_000_000 });
        assert.doesNotMatch(out, /CH /);
    });
});

describe("renderRichCard parallel same-agent instances", () => {
    // Two `seeker` phases running concurrently, one already finished. Each card
    // must reflect ITS OWN phase — the finished one shows "done", the other
    // "running" — instead of both collapsing to the still-running phase.
    const doneSeeker = {
        agent: "seeker",
        label: "Seeker",
        status: "done",
        elapsed: 30_000,
        toolCount: 4,
        contextPct: 1,
        tokens: { input: 1000, cacheRead: 0, output: 50, cacheWrite: 0, costUsd: 0.5, contextWindow: 1_000_000 },
    } as any;
    const runningSeeker = {
        agent: "seeker",
        label: "Seeker",
        status: "running",
        elapsed: 44_000,
        toolCount: 2,
        contextPct: 2,
        tokens: { input: 2000, cacheRead: 0, output: 80, cacheWrite: 0, costUsd: 1.61, contextWindow: 1_000_000 },
    } as any;
    const phases = [doneSeeker, runningSeeker];
    const render = (phase: any) =>
        renderRichCard({
            agentKey: "seeker",
            def: { description: "web research", contextWindow: 1_000_000 },
            phases,
            colWidth: 70,
            theme,
            model: "m",
            phase,
        }).join("\n");

    it("marks the finished instance done while the other still runs", () => {
        const doneCard = render(doneSeeker);
        assert.match(doneCard, /✓ done/);
        assert.doesNotMatch(doneCard, /running/);
    });

    it("keeps the still-running instance on running with its own cost", () => {
        const runningCard = render(runningSeeker);
        assert.match(runningCard, /● running/);
        // Each card reads its OWN phase's cost, not a shared one.
        assert.match(runningCard, /\$1\.61/);
        assert.doesNotMatch(render(doneSeeker), /\$1\.61/);
    });

    it("without a bound phase, collapses to the running phase (legacy by-name)", () => {
        const byName = renderRichCard({
            agentKey: "seeker",
            def: { description: "web research", contextWindow: 1_000_000 },
            phases,
            colWidth: 70,
            theme,
            model: "m",
        }).join("\n");
        assert.match(byName, /● running/);
    });
});

describe("renderTodos shows the phase title, not its test evidence", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

    it("drops the ledger's `— tests: …` suffix so the title survives clipping", () => {
        // A real done line: at 80 columns the old panel showed a clipped shell
        // command instead of the phase name.
        const items = [
            {
                done: true,
                label:
                    "Phase 0 — `test/fakes-model-the-knob` (prerequisite) — tests: .venv/bin/python -m pytest tests/test_journal.py (90 passed); full suite 896 passed (sha e5fe5bf)",
            },
            { done: false, label: "Phase 1 — `fix/window-and-math-bugs` (wrong numbers)" },
        ];
        const out = renderTodos(items, theme, { running: true, width: 80 });
        assert.match(out[1], /Phase 0 — `test\/fakes-model-the-knob` \(prerequisite\)/);
        assert.ok(!/pytest/.test(out[1]), "the command is gone");
        assert.ok(!/…/.test(out[1]), "and the title no longer needs clipping");
        assert.match(out[2], /Phase 1 — `fix\/window-and-math-bugs`/);
    });

    it("handles an ASCII hyphen separator and leaves plain titles alone", () => {
        assert.equal(phaseTitleOnly("Phase 2: Do it - tests: npm test"), "Phase 2: Do it");
        assert.equal(phaseTitleOnly("Phase 3: Plain title"), "Phase 3: Plain title");
        assert.equal(phaseTitleOnly("  spaced  "), "spaced");
    });

    it("still clips a genuinely long title", () => {
        const items = [{ done: false, label: "Phase 1 — " + "x".repeat(200) }];
        const out = renderTodos(items, theme, { width: 40 });
        assert.ok(out[1].includes("…"));
        assert.ok(out[1].length < 60);
    });
});

// ── parallel waves in the Todos panel ───────────────────────────────────────
// A wave can run several phases at once. Marking only the first unfinished one
// made a parallel wave look serial: two workers building phases 1 and 2 showed
// phase 1 running and phase 2 pending.

describe("renderTodos marks every in-flight phase", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const items = [
        { label: "Phase 1: State machine", done: false },
        { label: "Phase 2: Sandbox contract", done: false },
        { label: "Phase 3: Docker provider", done: false },
    ];
    const marks = (out: string[]) =>
        out.slice(1).map((l) => l.trim().slice(0, 3));

    it("marks two rows when two workers are running", () => {
        const out = renderTodos(items, theme, { running: true, inProgress: 2 });
        assert.deepEqual(marks(out), ["[•]", "[•]", "[ ]"]);
    });

    it("marks one row when a single phase is running", () => {
        const out = renderTodos(items, theme, { running: true, inProgress: 1 });
        assert.deepEqual(marks(out), ["[•]", "[ ]", "[ ]"]);
    });

    it("defaults to one when the caller cannot count workers", () => {
        const out = renderTodos(items, theme, { running: true });
        assert.deepEqual(marks(out), ["[•]", "[ ]", "[ ]"]);
    });

    it("treats 0 while running as 1 — the coordinator is between waves", () => {
        const out = renderTodos(items, theme, { running: true, inProgress: 0 });
        assert.deepEqual(marks(out), ["[•]", "[ ]", "[ ]"]);
    });

    it("never marks a completed phase, and skips past it", () => {
        const mixed = [
            { label: "Phase 1: done", done: true },
            { label: "Phase 2: running", done: false },
            { label: "Phase 3: running", done: false },
            { label: "Phase 4: pending", done: false },
        ];
        const out = renderTodos(mixed, theme, { running: true, inProgress: 2 });
        assert.deepEqual(marks(out), ["[x]", "[•]", "[•]", "[ ]"]);
    });

    it("never marks more rows than remain unfinished", () => {
        const nearlyDone = [
            { label: "Phase 1: done", done: true },
            { label: "Phase 2: last one", done: false },
        ];
        const out = renderTodos(nearlyDone, theme, { running: true, inProgress: 5 });
        assert.deepEqual(marks(out), ["[x]", "[•]"]);
    });

    it("marks nothing when the run is not active", () => {
        const out = renderTodos(items, theme, { running: false, inProgress: 2 });
        assert.deepEqual(marks(out), ["[ ]", "[ ]", "[ ]"]);
    });
});
