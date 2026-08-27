// ABOUTME: Repairs an `edit` tool call whose `oldText` collapsed a run of
// whitespace, so the edit lands instead of being rejected.
//
// Why this exists. Measured over the obs sink (2026-06-11 -> 2026-08-27, 234
// runs): 991 `edit` calls, 408 rejected — a 41% failure rate — and the largest
// classifiable cause, 205 of them, was `oldText` reproducing column-aligned text
// with its padding flattened. The file holds
//
//     fmt.Fprintln(stdout, " --version         print the version and exit")
//
// and the model sends `" --version print the version and exit"`. Nine spaces
// became one. It is not a reading failure — pi's `read` returns the exact bytes,
// and in the run that prompted this the agent re-read the line and still
// flattened it. Runs of spaces carry no meaning to a model and all of it to a
// byte-for-byte matcher, so this is a reproduction failure that instructions
// argue with rather than fix: 153 of the 408 re-sent an `oldText` that had
// already been rejected.
//
// The repair is deliberately narrow. It widens ONLY interior whitespace runs —
// a run with a non-whitespace character on both sides inside `oldText` — and
// only when the widened pattern matches the file in exactly one place. Both
// limits matter, and the reasoning is in the functions below.

/** One targeted replacement, matching pi's edit tool schema. */
export interface EditPair {
    oldText: string;
    newText: string;
    [k: string]: unknown;
}

/** A repair that was applied, for the audit log. */
export interface Repair {
    /** Index in the call's `edits` array. */
    index: number;
    /** What the model sent. */
    from: string;
    /** The file's actual bytes it was rewritten to. */
    to: string;
}

export interface RepairResult {
    edits: EditPair[];
    repairs: Repair[];
}

// An oldText longer than this is not worth pattern-matching: the regex cost
// grows with it, and a span this large is a whole-file rewrite that `write`
// should be doing. Well above any real targeted edit.
export const MAX_OLD_TEXT_CHARS = 20_000;

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const escape = (s: string): string => s.replace(ESCAPE_RE, "\\$&");

/**
 * A pattern matching `oldText` with every INTERIOR horizontal-whitespace run
 * allowed to be any horizontal-whitespace run. Returns null when there is
 * nothing to widen (then there is nothing this module can fix).
 *
 * Three deliberate limits, each one closing a way this could corrupt a file:
 *
 * - **Mid-line runs only.** A run is widened only when a non-whitespace
 *   character sits before it AND after it on the same line. That excludes
 *   INDENTATION, which is the dangerous case: `newText` is never rewritten, so
 *   repairing a one-space `oldText` to the file's four would make the edit apply
 *   and then replace those four spaces with the model's one -- silently
 *   reindenting the line, and breaking the file outright in Python or YAML.
 *   Replayed over the sink this costs real repairs, and it is worth it: a
 *   rejected edit is recoverable, a quietly dedented block is not.
 * - **No leading or trailing run.** Widening at either end lets the match creep
 *   outwards into neighbouring whitespace. Fixing the first and last characters
 *   of the match makes that impossible.
 * - **Horizontal whitespace only.** `\n` stays literal, so a widened match can
 *   never swallow a line break and join two lines the model meant to keep apart.
 */
export function flexPattern(oldText: string): RegExp | null {
    if (!oldText || oldText.length > MAX_OLD_TEXT_CHARS) return null;

    // Split into whitespace runs and the text between them, so "interior" is a
    // property of position rather than something to infer with lookarounds.
    const parts = oldText.split(/([ \t]+)/);
    let widened = 0;
    let out = "";
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;
        const isRun = i % 2 === 1; // split with one capture group alternates
        const before = parts[i - 1];
        const after = parts[i + 1];
        // Mid-line: text on both sides, and neither boundary is a line break.
        // parts[0] and the last entry are "" when oldText starts or ends with a
        // run (the leading/trailing case); a `before` ending in "\n" means the
        // run is this line's indentation, and an `after` starting with "\n"
        // means it is trailing whitespace. None of those are alignment padding.
        const midLine =
            isRun &&
            Boolean(before) &&
            Boolean(after) &&
            !before.endsWith("\n") &&
            !after.startsWith("\n");
        if (midLine) {
            out += "[ \\t]+";
            widened++;
        } else {
            out += escape(part);
        }
    }
    if (widened === 0) return null;
    return new RegExp(out, "g");
}

/**
 * The file's actual bytes for `oldText`, or null when the repair does not apply.
 *
 * Null in every ambiguous case, by design:
 *
 * - `oldText` already matches -> nothing to repair, and rewriting it could point
 *   the edit at a different occurrence.
 * - the widened pattern matches nowhere -> the mismatch is something else
 *   (stale text, a wrong line), which this module must not guess at.
 * - the widened pattern matches MORE than once -> pi requires `oldText` to be
 *   unique in the file, so repairing here would trade a rejected edit for an
 *   ambiguous one, or worse, apply to the wrong place.
 */
export function findFlexMatch(body: string, oldText: string): string | null {
    if (!body || !oldText) return null;
    if (body.includes(oldText)) return null;
    const re = flexPattern(oldText);
    if (!re) return null;
    const matches = body.match(re);
    if (!matches || matches.length !== 1) return null;
    const found = matches[0];
    // A no-op rewrite means the pattern round-tripped to the same string, which
    // `body.includes` should already have caught. Belt and braces.
    return found === oldText ? null : found;
}

/**
 * Repair every edit in a call that can be repaired, leaving the rest untouched.
 *
 * Each edit is matched against the ORIGINAL file text, which is how pi's edit
 * tool matches them too ("Each edit is matched against the original file, not
 * incrementally"), so repairs cannot interact with each other.
 *
 * `newText` is never touched. The model's replacement is its intent; only its
 * description of what to replace is corrected.
 */
export function repairEdits(body: string, edits: EditPair[]): RepairResult {
    const repairs: Repair[] = [];
    if (!Array.isArray(edits)) return { edits, repairs };
    const out = edits.map((edit, index) => {
        if (!edit || typeof edit.oldText !== "string") return edit;
        const found = findFlexMatch(body, edit.oldText);
        if (found === null) return edit;
        repairs.push({ index, from: edit.oldText, to: found });
        return { ...edit, oldText: found };
    });
    return { edits: out, repairs };
}

/**
 * Like {@link flexPattern} but widening EVERY horizontal run, including a line's
 * indentation. Never used to rewrite an edit — only to locate what the model was
 * plainly aiming at, so the rejection can quote it.
 *
 * Rewriting from this would corrupt files. Replayed over the sink, 219 rejected
 * edits were repairable only by widening indentation, and in **201 of them** the
 * model's `newText` carried the same flattened indent it got wrong in `oldText`:
 * the repair would have made the edit apply and then reindented the line. Four
 * were safe. So the pattern earns its place as a diagnostic and nothing more.
 */
function diagnosticPattern(oldText: string): RegExp | null {
    if (!oldText || oldText.length > MAX_OLD_TEXT_CHARS) return null;
    const parts = oldText.split(/([ \t]+)/);
    let widened = 0;
    let out = "";
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;
        if (i % 2 === 1 && parts[i - 1] && parts[i + 1]) {
            out += "[ \\t]+";
            widened++;
        } else out += escape(part);
    }
    return widened ? new RegExp(out, "g") : null;
}

/**
 * The file text the model was evidently aiming at, when `oldText` differs from it
 * only in whitespace and a repair would NOT be safe. Null when there is no single
 * such span — then we know nothing useful and must not speculate.
 *
 * This is what turns a wasted turn into a productive one. pi's own rejection says
 * the text "must match exactly", which is true and unactionable: 153 of the 408
 * rejections in the sink re-sent an `oldText` that had already been rejected, and
 * one run answered four rejections with five `python3` heredocs hunting an
 * invisible character that was never there. Handing back the file's actual bytes
 * ends that search before it starts.
 */
export function diagnoseMismatch(body: string, oldText: string): string | null {
    if (!body || !oldText) return null;
    if (body.includes(oldText)) return null;
    const re = diagnosticPattern(oldText);
    if (!re) return null;
    const matches = body.match(re);
    if (!matches || matches.length !== 1) return null;
    return matches[0] === oldText ? null : matches[0];
}

/**
 * What the hook should do about one `edit` call. Kept here rather than in the
 * extension so it is testable: an extension module imports pi's runtime, which
 * only resolves inside pi, so the shim around this must stay trivial.
 *
 * Order matters. A call is rejected as a UNIT, so if any one `oldText` cannot
 * land, repairing its siblings buys nothing and the useful answer is the reason
 * the call was always going to fail. Explain first, repair second.
 */
export type EditDecision =
    | { kind: "pass" }
    | { kind: "repair"; edits: EditPair[]; repairs: Repair[] }
    | { kind: "explain"; index: number; actual: string };

export function decideEdit(body: string, edits: EditPair[]): EditDecision {
    if (!Array.isArray(edits) || edits.length === 0) return { kind: "pass" };

    for (let i = 0; i < edits.length; i++) {
        const old = edits[i]?.oldText;
        if (typeof old !== "string" || body.includes(old)) continue;
        // A repairable edit is not a blocker; it is handled below.
        if (repairEdits(body, [edits[i]]).repairs.length) continue;
        const actual = diagnoseMismatch(body, old);
        // No diagnosis means the mismatch is not about whitespace (stale or
        // invented text). pi's own error is better than anything from here.
        if (actual) return { kind: "explain", index: i, actual };
    }

    const { edits: fixed, repairs } = repairEdits(body, edits);
    return repairs.length
        ? { kind: "repair", edits: fixed, repairs }
        : { kind: "pass" };
}

/** The rejection text for an `explain` decision. */
export function explainReason(
    path: string,
    index: number,
    actual: string,
): string {
    return (
        `edits[${index}].oldText is not in ${path}. It differs from the file ` +
        `ONLY in whitespace — the file has:\n\n${actual}\n\n` +
        "Copy that exactly, whitespace included, and adjust newText to match " +
        "the same indentation. Do NOT re-send the oldText above, and do not go " +
        "looking for invisible characters: the difference is the spacing shown " +
        "here."
    );
}

/** A one-line audit record. Whitespace is escaped so a run is visible as a run. */
export function formatRepair(path: string, r: Repair): string {
    const show = (s: string) =>
        JSON.stringify(s.length > 120 ? s.slice(0, 117) + "..." : s);
    return `${path} edits[${r.index}] ${show(r.from)} -> ${show(r.to)}`;
}
