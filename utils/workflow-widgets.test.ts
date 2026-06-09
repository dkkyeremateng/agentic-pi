import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLspServers, type LspServerInfo } from "./workflow-widgets";

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
