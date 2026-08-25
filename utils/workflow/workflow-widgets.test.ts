import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    renderLspServers,
    renderTodos,
    renderStatusWidget,
    STATUS_WIDGET_MAX_LINES,
    QUIET_THRESHOLD_MS,
    shouldRepaint,
    displayElapsedMs,
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
        elapsedMs: 134000, width: 100,
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

    it("puts each agent's own cost and context on its row, aligned", () => {
        const tok = (cost: number) => ({
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
            costUsd: cost, contextWindow: 256_000,
        });
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 53000,
                    contextPct: 8.2, tokens: tok(0.0031) }),
                phase({ status: "running", elapsed: 9000, contextPct: 41.5, tokens: tok(0.1288) }),
            ],
        } as any, theme);
        const scout = out.find((l) => l.includes("Scout"))!;
        const impl = out.find((l) => l.includes("Implementer"))!;
        assert.match(scout, /8\.2%\/256K/);
        assert.match(impl, /41\.5%\/256K/);
        // The "$" column is straight so it can be scanned down the roster, and
        // so is the context that follows it -- costs have different decimal
        // counts, so alignment has to come from padding, not from the values.
        assert.equal(scout.indexOf("$"), impl.indexOf("$"), "cost column");
        assert.equal(scout.indexOf("8.2%"), impl.indexOf("41.5%"), "context column");
    });

    it("keeps the model an agent ran on after it finishes", () => {
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000,
                    activeModel: "prov/small" }),
                phase({ status: "running", activeModel: "prov/big" }),
            ],
        } as any, theme);
        assert.match(out.find((l) => l.includes("Scout"))!, /◆ prov\/small/);
        assert.match(out.find((l) => l.includes("Implementer"))!, /◆ prov\/big/);
    });

    it("flags a model that was fallen back to, rather than chosen", () => {
        // The column earns its width exactly when the model is NOT the one you
        // configured, so a fallback must not look like a normal run.
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [phase({ status: "done", elapsed: 5000, activeModel: "prov/other",
                modelFallback: "prov/other" })],
        } as any, theme);
        const row = out.find((l) => l.includes("Implementer"))!;
        assert.match(row, /⚠ prov\/other/, row);
        assert.ok(!row.includes("◆"), "not the ordinary marker");
    });

    it("leaves a queued agent's cost and context blank, not zeroed", () => {
        // "$0.00 · 0.0%/256K" on a queued row is columns of "hasn't started",
        // which is what made the old cards mostly zeros.
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [phase({ status: "running" }), phase({ agent: "shipper", label: "Ship" })],
        } as any, theme);
        const ship = out.find((l) => l.includes("Shipper"))!;
        assert.ok(!ship.includes("$"), ship);
        assert.ok(!ship.includes("%"), ship);
        assert.equal(ship, ship.trimEnd(), "no trailing padding either");
    });

    it("lists the whole selected team, not just the running agent", () => {
        // During a run the question is "where is the pipeline up to", which needs
        // the whole chain: what is done, what is in flight, what is still queued.
        const out = renderStatusWidget({
            ...base,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 53000 }),
                phase({ status: "running", elapsed: 14000 }),
                phase({ agent: "reviewer", label: "Review" }),
                phase({ agent: "shipper", label: "Ship" }),
            ],
            activity: ["→ read plan.md"],
            maxLines: 20,
        } as any, theme);
        for (const name of ["Scout", "Implementer", "Reviewer", "Shipper"]) {
            assert.ok(out.some((l) => l.includes(name)), `missing ${name}`);
        }
        assert.ok(out.some((l) => l.includes("done")), "finished phase shows done");
        assert.ok(out.some((l) => l.includes("queued")), "unstarted phases read queued");
        assert.ok(out.some((l) => l.includes("▸")), "the running one is marked");
    });

    it("yields roster rows to the trail when the budget is tight", () => {
        // Knowing WHAT is happening beats knowing who is queued, so the roster
        // gives up rows first and counts what it dropped.
        const out = renderStatusWidget({
            ...base,
            phases: Array.from({ length: 12 }, (_, i) =>
                phase({ agent: `a${i}`, label: `P${i}`, status: i === 0 ? "running" : "pending" })),
            activity: ["one", "two", "three"],
            maxLines: 10,
        } as any, theme);
        assert.ok(out.length <= 10);
        assert.ok(out.some((l) => /\+\d+ more/.test(l)), "overflow counted");
        assert.ok(out.some((l) => l.includes("three")), "trail keeps its floor");
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

    it("shows each agent's model and context window, aligned", () => {
        const out = renderStatusWidget({
            ...base, team: "", phases: [], running: false, maxLines: 20,
            roster: [
                { name: "Scout", model: "prov/small", contextWindow: 256_000 },
                { name: "Implementer", model: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
            ],
        } as any, theme);
        const scout = out.find((l) => l.includes("Scout"))!;
        const impl = out.find((l) => l.includes("Implementer"))!;
        assert.match(scout, /prov\/small/);
        assert.match(scout, /256K/);
        assert.match(impl, /1\.0M/, "a megatoken window reads as 1.0M, not 1000K");
        // The window column starts at the same offset on both rows, so a
        // differently-modelled agent is obvious rather than buried.
        assert.equal(scout.indexOf("256K"), impl.indexOf("1.0M"));
    });

    it("omits the window when none is known, without leaving a gap", () => {
        const out = renderStatusWidget({
            ...base, team: "", phases: [], running: false, maxLines: 20,
            roster: [{ name: "Scout", model: "prov/small" }],
        } as any, theme);
        const row = out.find((l) => l.includes("Scout"))!;
        assert.match(row, /prov\/small/);
        assert.ok(!/\d+K|\d\.\dM/.test(row), row);
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

    it("lists the todo ledger and marks the phase being worked on", () => {
        const items = [
            { label: "Phase 1: tokens — tests: grep audit", done: true },
            { label: "Phase 2: component rules", done: false },
            { label: "Phase 3: literal audit", done: false },
        ];
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 20,
            todos: { done: 1, total: 3, items, inProgress: 1 },
            activity: ["→ read"],
        } as any, theme);
        const heading = out.find((l) => /Todos 1\/3/.test(l))!;
        assert.ok(heading, "the block is labelled, not just bracketed rows");
        // The heading sits at the widget's left margin and the items are indented
        // under it, so it reads as a section rather than another list entry.
        const item = out.find((l) => l.includes("[x] Phase 1"))!;
        assert.ok(
            heading.search(/\S/) < item.search(/\S/),
            `heading (${heading.search(/\S/)}) must outdent items (${item.search(/\S/)})`,
        );
        assert.ok(out.some((l) => l.includes("[x] Phase 1")), "done item");
        assert.ok(out.some((l) => l.includes("[•] Phase 2")), "the one in flight");
        assert.ok(out.some((l) => l.includes("[ ] Phase 3")), "not started");
        // The ledger carries its test evidence; the widget shows the title only.
        assert.ok(!out.some((l) => l.includes("grep audit")), "evidence stripped");
    });

    it("styles the ledger apart from the tool trail", () => {
        // The trail is "dim". If a ledger state renders dim too it reads as more
        // log, which is the thing this block exists NOT to be.
        const tagged = {
            fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
            bold: (s: string) => `*${s}*`,
        };
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 20,
            todos: {
                done: 1, total: 3, inProgress: 1,
                items: [
                    { label: "Phase 1", done: true },
                    { label: "Phase 2", done: false },
                    { label: "Phase 3", done: false },
                ],
            },
            activity: ["→ read plan.md"],
        } as any, tagged);
        const row = (s: string) => out.find((l) => l.includes(s))!;
        assert.match(row("Phase 1"), /<success>/, "done stands apart");
        assert.match(row("Phase 2"), /<accent>/, "in flight is the accent colour");
        assert.match(row("Phase 2"), /\*/, "in flight is the only bold text");
        assert.match(row("Phase 3"), /<muted>/, "not started is muted");
        for (const p of ["Phase 1", "Phase 2", "Phase 3"]) {
            assert.ok(!row(p).includes("<dim>"), `${p} must not read as trail`);
        }
        assert.match(row("read plan.md"), /<dim>/, "the trail itself stays dim");
    });

    it("lists the review checklist the same way as the todos", () => {
        const out = renderStatusWidget({
            ...base, phases: [phase({ agent: "reviewer", status: "running" })],
            maxLines: 24,
            todos: {
                done: 1, total: 2, inProgress: 1,
                items: [{ label: "Phase 1", done: true }, { label: "Phase 2", done: false }],
            },
            review: {
                done: 1, total: 3, inProgress: 1, active: true,
                items: [
                    { label: "Matches the plan", done: true },
                    { label: "No debug leftovers", done: false },
                    { label: "Docs updated", done: false },
                ],
            },
        } as any, theme);
        assert.ok(out.some((l) => /Todos 1\/2/.test(l)), "todos heading");
        assert.ok(out.some((l) => /Review 1\/3/.test(l)), "review heading");
        assert.ok(out.some((l) => l.includes("[x] Matches the plan")), "checked item");
        assert.ok(out.some((l) => l.includes("[•] No debug leftovers")), "item in flight");
        assert.ok(out.some((l) => l.includes("[ ] Docs updated")), "unchecked item");
    });

    it("gives the todos the rows first when both ledgers cannot fit", () => {
        // A long review checklist must not push the todo ledger out; todos are
        // the run's own plan, review is commentary on it.
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 12,
            todos: {
                done: 0, total: 2, inProgress: 1,
                items: [{ label: "Phase 1", done: false }, { label: "Phase 2", done: false }],
            },
            review: {
                done: 0, total: 15, inProgress: 1,
                items: Array.from({ length: 15 }, (_, i) => ({ label: `Check ${i}`, done: false })),
            },
            activity: ["a", "b", "c"],
        } as any, theme);
        // Phase 1 is the first unfinished entry, so it carries [•] not [ ].
        assert.ok(out.some((l) => l.includes("Phase 1")), "todos still listed");
        assert.ok(out.some((l) => l.includes("Phase 2")), "the whole todo ledger survives");
        assert.ok(out.some((l) => /Review 0\/15/.test(l)), "review keeps its heading");
        assert.ok(!out.some((l) => l.includes("Check 14")), "review collapsed, not truncated");
        assert.ok(out.length <= 12);
    });

    it("runs the tool trail flush, outdented from the status block", () => {
        // The trail is the agent's raw output, not another field of the dashboard.
        // At the ledger's indent the two read as one block, which is what this
        // outdent exists to undo -- so a future reindent must not pull it back in.
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [phase({ status: "running" })],
            todos: {
                done: 1, total: 2, inProgress: 1,
                items: [{ label: "Phase 1", done: true }, { label: "Phase 2", done: false }],
            },
            activity: ["→ read path=.agent/plan.md", "✓ read"],
        } as any, theme);
        const indent = (s: string) => s.search(/\S/);
        const trail = out.find((l) => l.includes("read path="))!;
        const entry = out.find((l) => l.includes("[x] Phase 1"))!;
        const heading = out.find((l) => /Todos 1\/2/.test(l))!;
        assert.ok(
            indent(trail) < indent(heading),
            `trail (${indent(trail)}) must outdent the heading (${indent(heading)})`,
        );
        assert.ok(
            indent(heading) < indent(entry),
            `heading (${indent(heading)}) must outdent its entries (${indent(entry)})`,
        );
        assert.equal(indent(trail), indent(out[0]), "trail sits at the header's margin");
    });

    it("marks every phase a parallel wave is on", () => {
        const items = [
            { label: "Phase 1", done: false },
            { label: "Phase 2", done: false },
            { label: "Phase 3", done: false },
        ];
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 20,
            todos: { done: 0, total: 3, items, inProgress: 2 },
        } as any, theme);
        assert.equal(out.filter((l) => l.includes("[•]")).length, 2);
    });

    it("collapses the ledger to a count when the rows are not there", () => {
        // A truncated ledger reads as the whole list, which is worse than a count.
        const items = Array.from({ length: 20 }, (_, i) => ({
            label: `Phase ${i}`, done: false,
        }));
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 10,
            todos: { done: 0, total: 20, items, inProgress: 1 },
            activity: ["a", "b", "c"],
        } as any, theme);
        assert.ok(out.some((l) => l.includes("Todos 0/20")), "fell back to the count");
        assert.ok(!out.some((l) => l.includes("[ ] Phase 19")), "no partial ledger");
    });

    it("collapses a finished ledger to its count and gives the rows away", () => {
        // Every box ticked is settled history. The heading already says 3/3, so
        // listing three [x] rows under it spends the trail's space to repeat
        // itself -- and the trail is the part that is still changing.
        const items = [
            { label: "Phase 1: tokens", done: true },
            { label: "Phase 2: rules", done: true },
            { label: "Phase 3: audit", done: true },
        ];
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 10,
            todos: { done: 3, total: 3, items, inProgress: 1 },
            activity: ["a", "b", "c", "d", "e"],
        } as any, theme);
        assert.ok(out.some((l) => /Todos 3\/3/.test(l)), "the count survives");
        assert.ok(!out.some((l) => l.includes("[x]")), "no rows repeating it");
        // The reclaimed rows go to the trail, not to whitespace.
        for (const a of ["a", "b", "c", "d", "e"]) {
            assert.ok(out.some((l) => l.trim() === a), `trail kept ${a}`);
        }
    });

    it("still lists a ledger with one box left", () => {
        const out = renderStatusWidget({
            ...base, phases: [phase({ status: "running" })], maxLines: 20,
            todos: {
                done: 1, total: 2, inProgress: 1,
                items: [{ label: "Phase 1", done: true }, { label: "Phase 2", done: false }],
            },
        } as any, theme);
        assert.ok(out.some((l) => l.includes("[x] Phase 1")), "listed, not collapsed");
        assert.ok(out.some((l) => l.includes("[•] Phase 2")));
    });

    it("aligns the cost column on its decimal point, not just its $", () => {
        // formatCostUsd varies the decimals with the magnitude, so padding one
        // end leaves the digits staggered and the column unscannable.
        const tok = (cost: number) => ({
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
            costUsd: cost, contextWindow: 256_000,
        });
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000,
                    contextPct: 9, tokens: tok(0.009) }),
                phase({ status: "running", contextPct: 17, tokens: tok(0.098) }),
            ],
        } as any, theme);
        const scout = out.find((l) => l.includes("Scout"))!;
        const impl = out.find((l) => l.includes("Implementer"))!;
        assert.match(scout, /\$0\.0090/);
        assert.match(impl, /\$0\.098/);
        assert.equal(scout.indexOf("$"), impl.indexOf("$"), "$ column");
        assert.equal(
            scout.indexOf("."), impl.indexOf("."),
            `decimal point: ${JSON.stringify(scout)} vs ${JSON.stringify(impl)}`,
        );
        // The column START, not the "%": the values have different digit counts.
        assert.equal(
            scout.indexOf("9.0%"), impl.indexOf("17.0%"), "context still follows",
        );
    });

    it("hoists the model to the header when every agent resolved the same one", () => {
        // One identifier repeated down the roster is thirty-odd columns per row
        // saying what the header can say once.
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000,
                    activeModel: "prov/big" }),
                phase({ status: "running", activeModel: "prov/big" }),
            ],
        } as any, theme);
        assert.match(out[0], /◆ prov\/big/, "header carries it");
        assert.ok(!out.find((l) => l.includes("Scout"))!.includes("prov/big"));
        assert.ok(!out.find((l) => l.includes("Implementer"))!.includes("prov/big"));
    });

    it("keeps the model per row the moment two agents differ", () => {
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000,
                    activeModel: "prov/small" }),
                phase({ status: "running", activeModel: "prov/big" }),
            ],
        } as any, theme);
        assert.ok(!out[0].includes("◆"), "nothing hoisted");
        assert.match(out.find((l) => l.includes("Scout"))!, /◆ prov\/small/);
        assert.match(out.find((l) => l.includes("Implementer"))!, /◆ prov\/big/);
    });

    it("keeps the model per row when one agent fell back, even if all agree", () => {
        // The fallback marker is the whole reason this column exists; hoisting a
        // single "◆ prov/other" to the header would erase it.
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000,
                    activeModel: "prov/other", modelFallback: true }),
                phase({ status: "running", activeModel: "prov/other" }),
            ],
        } as any, theme);
        assert.ok(!out[0].includes("◆"), "nothing hoisted");
        assert.match(out.find((l) => l.includes("Scout"))!, /⚠ prov\/other/);
    });

    it("does not hoist a model that differs below the visible roster", () => {
        // The roster is a prefix when it overflows; collapsing on what is on
        // screen would hide the disagreement that made the column worth showing.
        const out = renderStatusWidget({
            ...base, maxLines: 8,
            phases: [
                ...Array.from({ length: 8 }, (_, i) =>
                    phase({ agent: `a${i}`, label: `A${i}`, status: "done", elapsed: 1000,
                        activeModel: "prov/big" })),
                phase({ agent: "zz", label: "Zz", activeModel: "prov/other" }),
            ],
        } as any, theme);
        assert.ok(!out[0].includes("◆ prov/big"), "not hoisted");
    });

    it("says how long a running agent has been silent", () => {
        // "running 21m · 3 tools" reads identically whether the agent is working
        // or wedged on a tool call that will never return.
        const out = renderStatusWidget({
            ...base, maxLines: 20, now: 600_000,
            phases: [phase({ status: "running", elapsed: 300_000, toolCount: 3,
                lastOutputAt: 600_000 - 240_000 })],
        } as any, theme);
        assert.match(out.find((l) => l.includes("Implementer"))!, /quiet 4m/);
    });

    it("stays silent about silence below the threshold", () => {
        // Ordinary tool calls and turn boundaries are quiet for tens of seconds;
        // a row that flags those is a row nobody reads.
        const out = renderStatusWidget({
            ...base, maxLines: 20, now: 600_000,
            phases: [phase({ status: "running", elapsed: 300_000, toolCount: 3,
                lastOutputAt: 600_000 - (QUIET_THRESHOLD_MS - 1000) })],
        } as any, theme);
        assert.ok(!out.find((l) => l.includes("Implementer"))!.includes("quiet"));
    });

    it("colours a quiet row so it stops looking like a healthy one", () => {
        const tagged = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
        const row = (lastOutputAt: number) => {
            const out = renderStatusWidget({
                ...base, maxLines: 20, now: 600_000,
                phases: [phase({ status: "running", elapsed: 300_000, lastOutputAt })],
            } as any, tagged);
            return out.find((l) => l.includes("Implementer"))!;
        };
        assert.match(row(599_000), /<accent>\s*● running/, "working reads normal");
        assert.match(row(300_000), /<warning>\s*● running/, "quiet stands out");
    });

    it("never calls a finished or queued agent quiet", () => {
        // Only a RUNNING agent can be silent; a done one is supposed to be.
        const out = renderStatusWidget({
            ...base, maxLines: 20, now: 600_000,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000,
                    lastOutputAt: 100_000 }),
                phase({ agent: "shipper", label: "Ship", lastOutputAt: 100_000 }),
                phase({ status: "running", elapsed: 1000 }),
            ],
        } as any, theme);
        assert.ok(!out.some((l) => l.includes("quiet")), out.join("\n"));
    });

    it("colours a context percentage that is close to the window", () => {
        // At one flat colour an agent about to overflow reads exactly like an
        // idle one, which is the failure this column exists to catch.
        const tagged = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
        const tok = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, contextWindow: 256_000 };
        const row = (contextPct: number) => {
            const out = renderStatusWidget({
                ...base, maxLines: 20,
                phases: [phase({ status: "running", contextPct, tokens: tok })],
            } as any, tagged);
            return out.find((l) => l.includes("Implementer"))!;
        };
        assert.match(row(41.5), /<muted>\s*41\.5%/);
        assert.match(row(78), /<warning>\s*78\.0%/);
        assert.match(row(93.2), /<error>\s*93\.2%/);
    });

    it("omits ledger counts that have nothing in them", () => {
        const out = renderStatusWidget({
            ...base,
            phases: [phase({ status: "running" })],
            todos: { done: 0, total: 0 },
            review: { done: 0, total: 0 },
        } as any, theme);
        assert.ok(!out.some((l) => l.toLowerCase().includes("todos")));
        assert.ok(!out.some((l) => l.toLowerCase().includes("review")));
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

    it("totals the agents' spend on the header, including the one still running", () => {
        // Summed from the phases, not from the run accumulator: that only takes a
        // phase's cost once the phase FINISHES, so it would omit whatever the
        // running agent has already spent and disagree with the column below.
        const tok = (c: number) => ({
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
            costUsd: c, contextWindow: 256_000,
        });
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [
                phase({ agent: "scout", label: "Scout", status: "done", elapsed: 5000, tokens: tok(0.25) }),
                phase({ status: "running", elapsed: 9000, tokens: tok(0.75) }),
                phase({ agent: "shipper", label: "Ship" }),
            ],
        } as any, theme);
        assert.match(out[0], /\$1\.00/, `header total: ${out[0]}`);
    });

    it("omits the total before any agent has spent anything", () => {
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [phase({ status: "running" }), phase({ agent: "shipper", label: "Ship" })],
        } as any, theme);
        assert.ok(!out[0].includes("$"), `header: ${out[0]}`);
    });

    it("keeps context off the header row", () => {
        // They live on the roster rows (per agent, the useful cut) and in the
        // footer (session totals). A third copy on the header is noise.
        const tok = (c: number) => ({
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
            costUsd: c, contextWindow: 256_000,
        });
        const out = renderStatusWidget({
            ...base, maxLines: 20,
            phases: [phase({ status: "running", elapsed: 9000, contextPct: 41.5, tokens: tok(0.13) })],
        } as any, theme);
        // Context is per-agent by nature -- each has its own window -- so a single
        // figure here would answer a question nobody asked. The rows carry it.
        assert.ok(!out[0].includes("%"), `header carries context: ${out[0]}`);
        assert.match(out[0], /2m 14s/, "elapsed stays");
        // ...and the roster row still has both.
        const row = out.find((l) => l.includes("Implementer"))!;
        assert.match(row, /\$0\.13/);
        assert.match(row, /41\.5%/);
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
// ── run duration ────────────────────────────────────────────────────────────
// runElapsedMs is assigned only at terminal points (completion, abort, error)
// plus once per turn -- it is a RECORD, not a clock. Reading it mid-run is why
// the header duration sat at 0 or froze at the last turn boundary.
describe("displayElapsedMs", () => {
    const NOW = 1_000_000;

    it("ticks from the start timestamp while a run is live", () => {
        const ms = displayElapsedMs(
            { running: true, runStartedAt: NOW - 52_000, runElapsedMs: 0 },
            NOW,
        );
        assert.equal(ms, 52_000, "must not read the not-yet-assigned total");
    });

    it("uses the recorded total once the run has ended", () => {
        // The report and the completion notice quote runElapsedMs; a widget that
        // kept counting past the end would disagree with both.
        const ms = displayElapsedMs(
            { running: false, runStartedAt: NOW - 999_000, runElapsedMs: 126_000 },
            NOW,
        );
        assert.equal(ms, 126_000);
    });

    it("follows the dispatch clock in dispatch mode", () => {
        assert.equal(
            displayElapsedMs(
                {
                    running: true, dispatchMode: true, runStartedAt: NOW - 999_000,
                    runElapsedMs: 0, dispatchStartedAt: NOW - 9_000, dispatchElapsedMs: 0,
                },
                NOW,
            ),
            9_000,
        );
    });

    it("reports zero rather than epoch-since when no run has started", () => {
        // runStartedAt is 0 on a fresh state; subtracting it would render the
        // milliseconds since 1970 as a duration.
        assert.equal(
            displayElapsedMs({ running: true, runStartedAt: 0, runElapsedMs: 0 }, NOW),
            0,
        );
    });
});

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
