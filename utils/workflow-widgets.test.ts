import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    renderLspServers,
    renderTodos,
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
