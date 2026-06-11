// ABOUTME: Registers the `ask_user` tool — lets the agent ask the user a
// clarifying question (pick-list via ctx.ui.select, or free text via ctx.ui.editor)
// and block on the answer, instead of guessing. Fires a desktop notification while
// waiting. Interactive-only: in a non-interactive context (a spawned sub-agent or
// print/json mode) it returns guidance to proceed with a default rather than hang.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { emitNotification } from "../utils/shared/notify";

const OTHER = "Other (type my own answer)";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user",
        label: "Ask the user",
        description:
            "Ask the user a clarifying question and wait for their answer. Use when the request is ambiguous, a choice is needed, or before a destructive / outward-facing action (e.g. opening a PR, deleting). Provide `options` for a pick-list, or omit them for a free-text answer. Returns the user's answer as text. Prefer this over guessing.",
        parameters: Type.Object({
            question: Type.String({
                description: "The question to put to the user",
            }),
            options: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        "Choices to pick from; omit for a free-text answer",
                }),
            ),
            allow_other: Type.Optional(
                Type.Boolean({
                    description:
                        "With options, also allow a typed free-text answer (default true)",
                }),
            ),
        }),
        async execute(_id: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
            const { question, options, allow_other } = params as {
                question: string;
                options?: string[];
                allow_other?: boolean;
            };
            const text = (t: string) => ({
                content: [{ type: "text", text: t }],
                details: undefined,
            });

            // Non-interactive (sub-agent subprocess, print/json mode): can't prompt.
            if (!ctx?.hasUI || typeof ctx?.ui?.select !== "function") {
                return text(
                    "ask_user is unavailable here (no interactive UI). Proceed with a sensible default and note the assumption, or surface the question in your final answer for the user to resolve.",
                );
            }

            emitNotification(`pi needs your input: ${question}`);

            try {
                if (Array.isArray(options) && options.length > 0) {
                    const allowOther = allow_other !== false;
                    const choices = allowOther ? [...options, OTHER] : options;
                    const picked = await ctx.ui.select(question, choices);
                    if (picked === undefined)
                        return text(
                            "The user dismissed the question without answering.",
                        );
                    if (allowOther && picked === OTHER) {
                        const typed = await ctx.ui.editor(question, "");
                        return typed && typed.trim()
                            ? text(`User answered: ${typed.trim()}`)
                            : text(
                                  "The user dismissed the question without answering.",
                              );
                    }
                    return text(`User selected: ${picked}`);
                }

                const typed = await ctx.ui.editor(question, "");
                return typed && typed.trim()
                    ? text(`User answered: ${typed.trim()}`)
                    : text(
                          "The user dismissed the question without answering.",
                      );
            } catch (e: any) {
                return text(
                    `Could not ask the user (${e?.message || e}). Proceed with a sensible default and note the assumption.`,
                );
            }
        },
    });
}
