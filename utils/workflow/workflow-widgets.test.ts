import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    renderLspServers,
    renderTodos,
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
