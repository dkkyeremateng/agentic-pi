/**
 * LSP panel — an idle widget listing the language servers relevant to the
 * project's files, each with an install marker (✓ ready / ○ missing) and the
 * extensions it covers here. Asks the bundled lsp skill (skills/lsp/lsp.py) which
 * servers the cwd needs and whether each is installed.
 *
 * Once part of agent-workflow.ts (it fed the footer's inline `LSP:` segment, since
 * removed) and earlier a section of the workflow dashboard. Lifted into its own
 * `pi -e` extension: it never touched orchestrator state — it only scans the cwd
 * and renders. Detection runs SYNCHRONOUSLY before the first paint so the widget
 * appears once at its final height (a later async refresh would grow it, and pi's
 * sticky widget leaves a ghost frame above the grown one). Bounded + best-effort:
 * a missing python3 or skill, or no matching source files, just shows nothing.
 *
 * Usage: pi -e extensions/lsp-panel.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
    renderLspServers,
    type LspServerInfo,
} from "../utils/workflow/workflow-widgets";
import { agentWorkflowLoaded } from "../utils/workflow/workflow-core";

export default function (pi: ExtensionAPI) {
    // Companion to agent-workflow: the panel sat on the workflow dashboard, so it
    // shows only when agent-workflow.ts is also loaded.
    if (!agentWorkflowLoaded()) return;

    pi.on("session_start", async (_event, ctx: any) => {
        // TUI/RPC only — no widget chrome in print/json modes.
        if (!ctx.hasUI) return;

        const lspPy = join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "skills",
            "lsp",
            "lsp.py",
        );
        if (!existsSync(lspPy)) return;

        let servers: LspServerInfo[] = [];
        try {
            const stdout = execFileSync("python3", [lspPy, "servers"], {
                cwd: ctx.cwd,
                timeout: 2000,
                maxBuffer: 1 << 20,
                stdio: ["ignore", "pipe", "ignore"],
                encoding: "utf8",
            });
            const parsed = JSON.parse(stdout);
            if (Array.isArray(parsed?.servers)) servers = parsed.servers;
        } catch {
            // best-effort — leave the panel empty
        }
        if (!servers.length) return;

        // Render once at final size. The factory re-reads `servers` and the live
        // theme on each redraw, so the panel restyles on /theme changes.
        ctx.ui.setWidget("lsp-servers", (_tui: any, theme?: any) => {
            const t = theme || ctx.ui.theme;
            const container = new Container();
            for (const line of renderLspServers(servers, t))
                container.addChild(new Text(line, 1, 0));
            return container;
        });
    });
}
