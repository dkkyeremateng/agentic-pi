// ABOUTME: Registers the `remember` tool — lets a spawned agent save a durable,
// ABOUTME: general lesson to its OWN memory for future runs. The lesson is STAGED
// ABOUTME: now (in the run's .agent/) and only COMMITTED to agents/memory/<agent>.md
// ABOUTME: at finalize if the run succeeds (see utils/workflow/memory.ts). On the
// ABOUTME: next run the agent's memory is injected into its prompt. Off when
// ABOUTME: PI_AGENT_MEMORY=0. Loaded into sub-agents via subagentExtArgs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { memoryEnabled, stageLearning } from "../utils/workflow/memory";

export default function (pi: ExtensionAPI) {
    if (!memoryEnabled()) return;
    pi.registerTool({
        name: "remember",
        label: "Remember a lesson",
        description:
            "Save a durable, GENERAL lesson for your FUTURE runs — a reusable insight about how to do your job better (e.g. a pitfall to check, a step you skipped). NOT task/PR/repo specifics. It is staged now and kept only if THIS run succeeds, then injected into your prompt next time. One imperative sentence.",
        parameters: Type.Object({
            learning: Type.String({
                description: "One durable, general, imperative lesson (< 280 chars).",
            }),
        }),
        async execute(_id: any, params: any, _signal: any, _onUpdate: any, _ctx: any) {
            const text = (item: string) => ({ content: [{ type: "text", text: item }], details: undefined });
            const learning = String((params as { learning?: unknown })?.learning || "").trim();
            if (!learning) return text("nothing to remember (empty learning).");
            try {
                // Which agent this process IS — always set by dispatchEnv, independent
                // of PI_OBS. Falls back to PI_OBS_AGENT, then a generic bucket.
                const agent = (process.env.PI_AGENT_NAME || process.env.PI_OBS_AGENT || "agent").trim().toLowerCase();
                stageLearning(process.cwd(), agent, learning);
                return text("Saved to your memory (pending this run's success).");
            } catch (e) {
                return text("could not save the lesson: " + String((e as Error)?.message || e));
            }
        },
    });
}
