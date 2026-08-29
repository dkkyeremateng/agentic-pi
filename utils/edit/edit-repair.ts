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
        if (found === null) {
            // The mid-line repair declined. Try the indentation repair, which
            // corrects oldText AND newText together -- the case #115 refused
            // when only oldText was being rewritten. It is the largest single
            // category of failure (see repairIndent).
            const ind = repairIndent(body, edit);
            if (!ind) return edit;
            if (ind.oldText === ind.newText) return edit; // no-op, see below
            repairs.push({ index, from: edit.oldText, to: ind.oldText });
            return { ...edit, oldText: ind.oldText, newText: ind.newText };
        }
        // Never repair an edit into a no-op. When the repaired `oldText` equals
        // `newText`, the whitespace this module normalises away IS the change the
        // model is making -- it is realigning a padded column, and the file
        // already holds the aligned form. Rewriting `oldText` there turns a
        // truthful "Could not find the exact text" (your oldText is stale, the
        // change already landed) into "No changes made ... identical content",
        // which is strictly less informative.
        //
        // Observed in production on run-mte7ns9m-z8377: three edits realigning a
        // `--style` help row were repaired into no-ops, and the agent answered
        // each one with another round of python3 forensics.
        if (typeof edit.newText === "string" && found === edit.newText) return edit;
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
 * Repair an edit whose LEADING whitespace was flattened, correcting `oldText`
 * and `newText` together.
 *
 * This is the biggest single cause of edit failure, and until now the one case
 * the module deliberately refused. Measured across four runs, 80% of failed
 * edits differ from the text the agent had just READ only in whitespace, and the
 * dominant shape is every line's indentation collapsed to one space:
 *
 *   saw:  "\n\t\twantCode         int\n\t\twantStdout       string"
 *   sent: " wantCode int\n wantStdout string"
 *
 * #115 refused indentation repairs for a real reason: rewriting `oldText` alone
 * makes the edit apply and then replaces the file's indentation with the model's
 * flattened version, silently reindenting the block. That objection only holds
 * while `newText` is left alone. Correct BOTH and the intent is preserved.
 *
 * The mapping is by line content, not position, so an inserted line is handled:
 * a `newText` line whose trimmed form appears in `oldText` inherits that line's
 * real indentation from the file; a genuinely new line inherits the indentation
 * of the nearest preceding line that did match.
 *
 * Returns null unless every safety condition holds — see the guards inline.
 */
export function repairIndent(
    body: string,
    edit: EditPair,
): { oldText: string; newText: string } | null {
    const old = edit?.oldText;
    const next = edit?.newText;
    if (typeof old !== "string" || typeof next !== "string") return null;
    if (!old || body.includes(old)) return null;
    if (old.length > MAX_OLD_TEXT_CHARS) return null;

    const oldLines = old.split("\n");
    // Multi-line only. A single line has no indentation structure to restore,
    // and the mid-line repair already covers it.
    if (oldLines.length < 2) return null;

    const trim = (l: string) => l.trim();
    const indentOf = (l: string) => (/^[ \t]*/.exec(l) || [""])[0];

    // Find the run of consecutive file lines whose TRIMMED content equals the
    // trimmed oldText lines, in order. Require exactly one such run: more than
    // one and we cannot know which the model meant, which is the same
    // uniqueness rule the mid-line repair uses.
    const bodyLines = body.split("\n");
    const want = oldLines.map(trim);
    const hits: number[] = [];
    for (let i = 0; i + want.length <= bodyLines.length; i++) {
        let ok = true;
        for (let j = 0; j < want.length; j++)
            if (trim(bodyLines[i + j]) !== want[j]) {
                ok = false;
                break;
            }
        if (ok) hits.push(i);
    }
    if (hits.length !== 1) return null;
    const at = hits[0];
    const fileLines = bodyLines.slice(at, at + want.length);

    // Refuse if this is not actually an indentation problem: when the trimmed
    // lines already sit at the same indentation, something else differs and
    // guessing would be speculation.
    const changed = fileLines.some((l, j) => l !== oldLines[j]);
    if (!changed) return null;
    const onlyIndent = fileLines.every((l, j) => trim(l) === trim(oldLines[j]));
    if (!onlyIndent) return null;

    // Map trimmed content -> the file's real indentation. Ambiguous content
    // (the same trimmed line twice with DIFFERENT indents) is refused rather
    // than guessed.
    const indentFor = new Map<string, string>();
    for (const l of fileLines) {
        const k = trim(l);
        const ind = indentOf(l);
        if (indentFor.has(k) && indentFor.get(k) !== ind) return null;
        indentFor.set(k, ind);
    }

    // Re-indent newText with the same mapping, in three fallbacks. The order
    // matters and each step earns its place:
    //
    //  1. the line's own content is one we recognised -> use ITS indent.
    //  2. newText has the same line count as oldText -> the line is a
    //     modification in place, so take the file line at that position. This
    //     is what a preceding-line heuristic gets wrong: `def f():` sits at
    //     column 0 while its body does not, so "nearest preceding" would
    //     dedent the body of every block it rewrote.
    //  3. otherwise a line is being INSERTED -> the nearest preceding line we
    //     did recognise is the best available guide (an import added among
    //     imports, a case added among cases).
    const newLines = next.split("\n");
    const sameShape = newLines.length === fileLines.length;
    let lastKnown = indentOf(fileLines[0]);
    const rebuilt = newLines.map((l, i) => {
        const k = trim(l);
        if (!k) return l; // blank lines keep whatever they had
        const known = indentFor.get(k);
        if (known !== undefined) {
            lastKnown = known;
            return known + k;
        }
        if (sameShape) {
            const ind = indentOf(fileLines[i]);
            lastKnown = ind;
            return ind + k;
        }
        return lastKnown + k;
    });

    return { oldText: fileLines.join("\n"), newText: rebuilt.join("\n") };
}

/** What will happen to one edit in a batch, decided before the call runs. */
export interface EditOutcome {
    index: number;
    /** applies: matches as sent. repairable: matches once whitespace is widened.
     *  satisfied: the target already holds newText. missing: no match at all. */
    state: "applies" | "repairable" | "satisfied" | "missing";
    /** For `missing`, the file text it evidently meant, when that is knowable. */
    actual?: string;
}

/**
 * Classify every edit in a call BEFORE any of them runs.
 *
 * This exists because of the strongest signal in the run data, which is not
 * about whitespace at all -- it is about batching. pi applies a multi-edit call
 * as a UNIT, so one bad `oldText` discards the good edits beside it, and the
 * failure rate climbs with the batch:
 *
 *     edits per call   calls   failed   rate
 *              1         823      294    36%
 *              2         165       92    56%
 *              3          44       28    64%
 *             4+          39       26    67%
 *
 * Close to what independent per-edit failure predicts when any single miss kills
 * the batch. The agent then re-derives the WHOLE batch from scratch, including
 * the edits that were already correct -- which is the loop, and why fixing the
 * wording of a single-edit rejection never touched it.
 */
export function classifyBatch(body: string, edits: EditPair[]): EditOutcome[] {
    if (!Array.isArray(edits)) return [];
    return edits.map((edit, index) => {
        const old = edit?.oldText;
        if (typeof old !== "string") return { index, state: "missing" as const };
        if (body.includes(old)) return { index, state: "applies" as const };
        const target = findFlexMatch(body, old);
        if (target !== null && target === edit.newText)
            return { index, state: "satisfied" as const };
        if (target !== null) return { index, state: "repairable" as const };
        if (repairIndent(body, edit)) return { index, state: "repairable" as const };
        const actual = diagnoseMismatch(body, old);
        return { index, state: "missing" as const, ...(actual ? { actual } : {}) };
    });
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
    | { kind: "explain"; index: number; actual: string }
    | { kind: "satisfied"; index: number }
    | { kind: "partial"; outcomes: EditOutcome[] };

export function decideEdit(body: string, edits: EditPair[]): EditDecision {
    if (!Array.isArray(edits) || edits.length === 0) return { kind: "pass" };

    // A BATCH that is going to fail is worth intervening on before pi discards
    // it whole. Reporting which indices are fine turns a total loss into partial
    // progress: the agent re-sends only the broken one, as a single edit, where
    // the measured failure rate is 36% rather than the batch's 56-67%.
    //
    // Single-edit calls fall through to the paths below unchanged -- there is no
    // batch to salvage, and their messages are already specific.
    if (edits.length > 1) {
        const outcomes = classifyBatch(body, edits);
        const doomed = outcomes.some(
            (o) => o.state === "missing" || o.state === "satisfied",
        );
        if (doomed) return { kind: "partial", outcomes };
    }

    for (let i = 0; i < edits.length; i++) {
        const old = edits[i]?.oldText;
        if (typeof old !== "string" || body.includes(old)) continue;
        // ALREADY APPLIED. The region the model targeted now holds exactly its
        // `newText`, so the change it is trying to make is already in the file.
        //
        // This has to be said plainly, because the alternative message is what
        // caused a loop. Refusing the repair here is right (#115 -- repairing
        // would make the edit a no-op), but falling through to EXPLAIN then told
        // the model "copy these bytes and adjust newText", which is advice for a
        // problem it does not have. Observed on run-mte9oayl-nlqlm: it answered
        // that three times, twice with a byte-identical oldText, because
        // reproducing the whitespace is the very operation it cannot do. You
        // cannot fix a reproduction failure by asking for more reproduction.
        const target = findFlexMatch(body, old);
        if (target !== null && target === edits[i].newText)
            return { kind: "satisfied", index: i };
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

/**
 * The rejection text for a `satisfied` decision: the change is already in the
 * file. Says so, and gives the agent its next action -- verify -- rather than
 * another string to reproduce.
 */
export function satisfiedReason(path: string, index: number): string {
    return (
        `edits[${index}] is ALREADY APPLIED to ${path}. The text you are trying ` +
        "to produce is what the file already contains, so there is nothing to " +
        "change and no whitespace to correct.\n\nDo NOT retry this edit, and do " +
        "not inspect the file for invisible characters. Move on: run this " +
        "phase's tests to confirm the change is good, and if you were mid-way " +
        "through a list of edits, continue with the next one."
    );
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

/**
 * The rejection text for a `partial` decision.
 *
 * Its whole job is to stop the agent re-deriving edits that were already right.
 * pi's own rejection names one failing index and says the text must match
 * exactly, which leaves the agent to work out for itself whether the other edits
 * in the batch were good -- and in the runs it usually assumed they were not and
 * rewrote everything.
 */
export function partialReason(path: string, outcomes: EditOutcome[]): string {
    const list = (state: EditOutcome["state"]) =>
        outcomes.filter((o) => o.state === state).map((o) => o.index);
    const fine = [...list("applies"), ...list("repairable")].sort((a, b) => a - b);
    const done = list("satisfied");
    const bad = list("missing");
    const lines = [
        `This ${outcomes.length}-edit call was not run: pi applies a multi-edit ` +
            "call as a UNIT, so one bad oldText would discard the rest. Here is " +
            `exactly where each edit stands in ${path}:`,
        "",
    ];
    if (fine.length)
        lines.push(
            `- edits[${fine.join(", ")}] — FINE. Send these again unchanged; do not rewrite them.`,
        );
    if (done.length)
        lines.push(
            `- edits[${done.join(", ")}] — ALREADY APPLIED. The file already contains this change. Drop them.`,
        );
    for (const o of outcomes.filter((x) => x.state === "missing")) {
        lines.push(
            o.actual
                ? `- edits[${o.index}] — NOT FOUND, and differs from the file only in whitespace. The file has:\n\n${o.actual}\n`
                : `- edits[${o.index}] — NOT FOUND. Re-read the file around this point; your oldText is stale or wrong.`,
        );
    }
    lines.push(
        "",
        "Re-send them as SEPARATE single-edit calls, not one batch. A single edit " +
            "that misses costs you one call; a batch that misses costs you all of " +
            "them, which is why this one was stopped.",
    );
    return lines.join("\n");
}

/** A one-line audit record. Whitespace is escaped so a run is visible as a run. */
export function formatRepair(path: string, r: Repair): string {
    const show = (s: string) =>
        JSON.stringify(s.length > 120 ? s.slice(0, 117) + "..." : s);
    return `${path} edits[${r.index}] ${show(r.from)} -> ${show(r.to)}`;
}
