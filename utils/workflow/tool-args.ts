// ABOUTME: Coercion for tool arguments some models send in the wrong shape.
// Runs from a tool's `prepareArguments`, which is the only hook early enough to
// matter: pi validates arguments against the schema BEFORE the `tool_call`
// extension hook fires (see pi-agent-core `prepareToolCall` — prepareArguments,
// then validateToolArguments, then beforeToolCall), so a schema-invalid argument
// is already rejected by the time an extension could see it.
//
// The failure it exists for: models sometimes send an array parameter as a
// JSON-encoded STRING. pi hit this in its own edit tool and fixed it there
// (`prepareEditArguments`: "Some models (Opus 4.6, GLM-5.1) send edits as a JSON
// string instead of an array"), but the fix is per-tool, so every tool we
// register carries the bug independently. Measured over a month of runs
// (2026-07-27 -> 08-27), `dispatch_parallel` was called 6 times and **2 of those
// failed** on `agents.0: must be object` — a 33% failure rate on a tool whose
// failures are expensive, since each one is a whole wave of parallel work that
// did not start.

/**
 * Return `args` with `key` parsed from a JSON string into an array, when that is
 * what it is. Everything else passes through untouched.
 *
 * Deliberately narrow:
 *
 * - only acts when the value is a **string** that parses to an **array**; a
 *   string that parses to an object or a number is left alone, because that is
 *   not the failure this is for and the schema should reject it.
 * - never throws. Malformed JSON returns the input unchanged so the schema
 *   produces its normal validation error, which is more useful than a parse
 *   error from here.
 * - does not validate the array's CONTENTS. Schema validation runs immediately
 *   after and is better at it; this only fixes the container.
 */
export function coerceJsonArrayArg<T>(args: T, key: string): T {
    if (!args || typeof args !== "object") return args;
    const rec = args as Record<string, unknown>;
    const raw = rec[key];
    if (typeof raw !== "string") return args;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return args;
    }
    if (!Array.isArray(parsed)) return args;
    // A fresh object rather than a mutation: `prepareArguments` compares its
    // result against the input by identity to decide whether anything changed.
    return { ...rec, [key]: parsed } as T;
}
