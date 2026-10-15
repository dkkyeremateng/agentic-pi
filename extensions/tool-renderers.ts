/**
 * Tool renderers — draw the workflow's own tool calls (dispatch_agent,
 * dispatch_parallel, select_agents, run_agent_workflow) in sessions where the
 * extension that registers them is NOT loaded, such as a workflow session
 * resumed with a plain `pi --resume` or exported with /export. Without it those
 * calls fall back to pi's generic JSON rendering.
 *
 * Uses pi 1.0.1+ `pi.registerToolRenderer()`, which can render tools that are not
 * registered. It only fills in: `next()` is whatever the registered tool (or an
 * earlier resolver) would use, so inside a run.sh session — where dispatch.ts and
 * agent-workflow.ts register these tools themselves — this changes nothing.
 *
 * Load it everywhere by linking it into pi's global extensions directory:
 *   ln -s "$PWD/extensions/tool-renderers.ts" ~/.pi/agent/extensions/
 */

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
    displayName,
    renderDispatchAgentCall,
    renderDispatchAgentResult,
    renderDispatchParallelCall,
    renderDispatchParallelResult,
    renderRunWorkflowCall,
    renderRunWorkflowResult,
    renderSelectAgentsCall,
    renderSelectAgentsResult,
    WORKFLOW_REPORT_MAX,
} from "../utils/workflow/workflow-core";

// The roster is session state of agent-workflow.ts; a resumed transcript has
// none, so the run header just omits the optional Scout step.
const noMembers = () => [];

const RENDERERS: Record<string, ToolRenderers> = {
    dispatch_agent: {
        renderCall: (args, theme) => renderDispatchAgentCall(args, theme, Text),
        renderResult: (result, options, theme) =>
            renderDispatchAgentResult(result, options, theme, Text, Markdown, getMarkdownTheme()),
    },
    dispatch_parallel: {
        renderCall: (args, theme) => renderDispatchParallelCall(args, theme, Text),
        renderResult: (result, options, theme) =>
            renderDispatchParallelResult(result, options, theme, Text, Markdown, getMarkdownTheme()),
    },
    select_agents: {
        renderCall: (args, theme) => renderSelectAgentsCall(args, theme, Text, displayName),
        renderResult: (result, options, theme) => renderSelectAgentsResult(result, options, theme, Text),
    },
    run_agent_workflow: {
        renderCall: (args, theme) =>
            renderRunWorkflowCall("run_agent_workflow", args, theme, noMembers, Text),
        renderResult: (result, options, theme) =>
            renderRunWorkflowResult(
                "agent-workflow",
                result,
                options,
                theme,
                Text,
                Markdown,
                getMarkdownTheme(),
                WORKFLOW_REPORT_MAX,
            ),
    },
};

export default function (pi: ExtensionAPI) {
    pi.registerToolRenderer((toolName, next) => next() ?? RENDERERS[toolName]);
}
