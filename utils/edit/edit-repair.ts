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
    /** Which side was corrected. `oldText` is the usual case (the model's
     *  description of what to replace); `newText` means the edit matched fine
     *  and the replacement itself carried flattened padding. Reading the log
     *  without this, a newText repair looks like an oldText one and the entry
     *  makes no sense against the file. */
    field?: "oldText" | "newText";
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
 * `newText` is corrected only where the model plainly did not mean to change it:
 * repairIndent rebuilds it alongside a repaired `oldText`, and
 * repairCarriedWhitespace restores a padded line carried through unchanged.
 * Anything the model actually rewrote is its intent and is left alone.
 */
export function repairEdits(body: string, edits: EditPair[]): RepairResult {
    const repairs: Repair[] = [];
    if (!Array.isArray(edits)) return { edits, repairs };
    const out = edits.map((edit, index) => {
        if (!edit || typeof edit.oldText !== "string") return edit;
        // An edit that MATCHES can still be wrong: newText may carry a flattened
        // copy of a line it is not changing. Handled first because every other
        // repair below is about an oldText that fails to match.
        const carried = repairCarriedWhitespace(body, edit);
        if (carried !== null) {
            repairs.push({
                index,
                field: "newText",
                from: edit.newText as string,
                to: carried,
            });
            return { ...edit, newText: carried };
        }
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

    // Compare lines with their INTERNAL whitespace runs collapsed as well as
    // their indentation stripped. Matching on trim() alone misses the commonest
    // real shape, where the model flattened both at once:
    //
    //   saw:  '\t"hello":    greet.Hello,'
    //   sent: ' "hello": greet.Hello,'
    //
    // trim() leaves the interior padding intact, so those two never matched and
    // the repair declined. Nine of the ten edit misses in run-mtevhlm5-v6271
    // were this.
    const key = (l: string) => l.trim().replace(/[ \t]+/g, " ");
    const indentOf = (l: string) => (/^[ \t]*/.exec(l) || [""])[0];

    // Find the run of consecutive file lines whose TRIMMED content equals the
    // trimmed oldText lines, in order. Require exactly one such run: more than
    // one and we cannot know which the model meant, which is the same
    // uniqueness rule the mid-line repair uses.
    const bodyLines = body.split("\n");
    const want = oldLines.map(key);
    const hits: number[] = [];
    for (let i = 0; i + want.length <= bodyLines.length; i++) {
        let ok = true;
        for (let j = 0; j < want.length; j++)
            if (key(bodyLines[i + j]) !== want[j]) {
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
    const onlyWhitespace = fileLines.every((l, j) => key(l) === key(oldLines[j]));
    if (!onlyWhitespace) return null;

    // Map trimmed content -> the file's real indentation. Ambiguous content
    // (the same trimmed line twice with DIFFERENT indents) is refused rather
    // than guessed.
    // Key -> the file's WHOLE line, not merely its indentation. A newText line
    // the model only mangled can then be restored verbatim, interior alignment
    // included; without that, rebuilding it as indent + the model's trimmed text
    // would keep the flattened padding and silently de-align the file -- the
    // regression #118's audit exists to catch.
    const lineFor = new Map<string, string>();
    for (const l of fileLines) {
        const k = key(l);
        if (lineFor.has(k) && lineFor.get(k) !== l) return null;
        lineFor.set(k, l);
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
        const k = key(l);
        if (!k) return l; // blank lines keep whatever they had
        const exact = lineFor.get(k);
        if (exact !== undefined) {
            // The model changed nothing here but the whitespace: put the file's
            // own line back, byte for byte.
            lastKnown = indentOf(exact);
            return exact;
        }
        // A line whose CONTENT the model really changed: keep its text, give it
        // the file's indentation.
        const text = l.trim();
        if (sameShape) {
            const ind = indentOf(fileLines[i]);
            lastKnown = ind;
            return ind + text;
        }
        return lastKnown + text;
    });

    return { oldText: fileLines.join("\n"), newText: rebuilt.join("\n") };
}

/**
 * Restore alignment the model flattened on a line it was not trying to change.
 *
 * The gap this closes. Every other repair here fixes an `oldText` that will not
 * MATCH. This one fixes an edit that matches perfectly and writes the wrong
 * bytes: the model reproduces the surrounding context inside `newText` and
 * flattens a padded column on the way through. The edit applies, gofmt is happy,
 * and the only symptom is a test comparing exact output.
 *
 * Measured on run-mtfx17xn-wpdrq. Adding a `--style` help row flattened the
 * neighbouring row it merely carried along:
 *
 *     want:  " --version         print the version and exit"
 *     got:   " --version print the version and exit"
 *
 * `TestRun/help_flag` then failed for three minutes -- 40 turns, 45 tool calls,
 * $2.31, 44% of that implementer's entire cost -- including a hex dump of the
 * mismatched bytes added to the test file and reverted afterwards. It recovered
 * without editing the expectation, which is the good outcome, at the price of
 * the most expensive stretch in the run.
 *
 * Only ever NARROWS-to-a-single-space are repaired, and only on a line carried
 * through from `oldText`:
 *
 * - **A run the model WIDENED is never touched.** Widening is what deliberate
 *   re-alignment looks like (a longer entry arrives, the column moves), and
 *   reverting it would fight the edit's actual intent.
 * - **A run narrowed to something other than one space is never touched**, for
 *   the same reason: re-aligning to a NEW column is a real edit, while collapsing
 *   to exactly one space is the signature of a model that cannot see the run at
 *   all. That is the shape in every occurrence measured.
 * - The line must appear in `oldText`, so the model is re-transcribing context
 *   rather than authoring it.
 *
 * Returns the corrected `newText`, or null when there is nothing safe to do.
 */
export function repairCarriedWhitespace(
    body: string,
    edit: EditPair,
): string | null {
    const old = edit?.oldText;
    const next = edit?.newText;
    if (typeof old !== "string" || typeof next !== "string") return null;
    if (!old || !next || old.length > MAX_OLD_TEXT_CHARS) return null;
    // ONLY for an edit that already matches. When it does, `oldText` is a literal
    // slice of the file, so it is the truth to restore from and no search of the
    // body is needed. A non-matching edit is repairIndent's job, and that path
    // already rebuilds newText.
    if (!body.includes(old)) return null;

    const key = (l: string) => l.trim().replace(/[ \t]+/g, " ");

    // Content -> the file's own line. Ambiguous content (the same collapsed text
    // at two different widths) is refused rather than guessed, matching the
    // uniqueness rule the other repairs use.
    const lineFor = new Map<string, string>();
    for (const l of old.split("\n")) {
        const k = key(l);
        if (!k) continue;
        if (lineFor.has(k) && lineFor.get(k) !== l) {
            lineFor.set(k, "\0ambiguous");
            continue;
        }
        lineFor.set(k, l);
    }

    // Offsets where a padded column lands, across the lines of oldText. Used to
    // tell alignment from data inside a string literal -- see isFlattened.
    const columns = columnOffsets(old.split("\n"));

    let changed = false;
    const out = next.split("\n").map((sent) => {
        const k = key(sent);
        if (!k) return sent;
        const file = lineFor.get(k);
        if (file === undefined || file === "\0ambiguous" || file === sent)
            return sent;
        if (!isFlattened(sent, file, columns)) return sent;
        changed = true;
        return file;
    });
    return changed ? out.join("\n") : null;
}

/**
 * True when `sent` is `file` with one or more whitespace runs collapsed to a
 * single space, and nothing else different.
 *
 * Both lines have the same collapsed form by the time this is called, so their
 * split alternates identically: text at even indices, runs at odd. Every text
 * part must be equal, every run either identical or a collapse to one space, and
 * at least one must actually have collapsed.
 */
function isFlattened(
    sent: string,
    file: string,
    columns: Map<number, number>,
): boolean {
    const a = sent.split(/([ \t]+)/);
    const b = file.split(/([ \t]+)/);
    if (a.length !== b.length) return false;
    const inString = literalMask(file);
    let collapsed = 0;
    let at = 0; // offset of b[i] within `file`
    for (let i = 0; i < a.length; i++) {
        const start = at;
        at += b[i].length;
        if (a[i] === b[i]) continue;
        // A differing TEXT part means this is a real content change, not padding.
        if (i % 2 === 0) return false;
        // A run the model made WIDER, or re-aligned to some other width, is the
        // edit's intent. Only the collapse-to-one-space signature is repaired.
        if (a[i] !== " ") return false;
        // Whitespace INSIDE a string literal is data, not layout. Replaying this
        // over the sink caught the case that makes the distinction non-optional:
        //
        //     sent:  stdin:           " Ada \n",
        //     file:  stdin:           "  Ada  \n",
        //
        // Those are different test INPUTS. "Restoring" the padding would rewrite
        // what the case feeds in while every gate stayed green -- precisely the
        // silent damage this module exists to prevent. Two of the ten historical
        // edits this repair fired on were exactly that.
        let literal = false;
        for (let k = start; k < at; k++) if (inString[k]) literal = true;
        // Padding inside a literal is repaired only when it forms a COLUMN: some
        // other line in this edit puts its text at the same offset. That is what
        // alignment IS, and it is the one signal that separates the two cases,
        // which are otherwise identical line-for-line.
        if (literal && (columns.get(at) || 0) < 2) return false;
        collapsed++;
    }
    return collapsed > 0;
}

/**
 * How many of these lines start a text token at each offset, counting only
 * tokens preceded by a run of two or more spaces.
 *
 * This is the test for "is that padding, or is it data". Both look identical on
 * one line -- a Go help row and a table-driven test's stdin field are each a
 * string literal with runs inside it -- but alignment exists to put the NEXT
 * token at a shared offset across neighbouring lines, and data does not:
 *
 *     " --version         print the version and exit"     both put their text
 *     " --help            show this help"                 at offset 20 -> column
 *
 *     stdin:           "  Ada  \\n",                        nothing shares an
 *     stdin:           "   \\n\\t",                          offset -> data
 */
function columnOffsets(lines: string[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const line of lines) {
        for (const m of line.matchAll(/[ \t]{2,}(?=[^ \t])/g)) {
            const end = (m.index ?? 0) + m[0].length;
            counts.set(end, (counts.get(end) || 0) + 1);
        }
    }
    return counts;
}

/**
 * Per-character "is inside a string literal" for one line.
 *
 * Deliberately crude: one line at a time, no knowledge of the language, quotes
 * closed by their own kind, backslash escapes honoured. An unterminated quote
 * (an apostrophe in a comment, a literal spanning lines) marks the rest of the
 * line as string, which only ever makes the caller DECLINE a repair. Erring
 * toward "this is data, leave it alone" is the correct bias for a mask whose
 * only job is to veto rewrites.
 */
function literalMask(line: string): boolean[] {
    const mask = new Array<boolean>(line.length).fill(false);
    let quote = "";
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            mask[i] = true;
            if (c === "\\") {
                if (i + 1 < line.length) mask[++i] = true;
                continue;
            }
            if (c === quote) quote = "";
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            quote = c;
            mask[i] = true;
        }
    }
    return mask;
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
        `That ${outcomes.length}-edit call failed as a UNIT: pi applies a ` +
            "multi-edit call all-or-nothing, so one bad oldText discarded the " +
            `rest. Here is exactly where each edit stands in ${path}:`,
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
        "Re-send them as SEPARATE single-edit calls, not one batch. A single " +
            "edit that misses costs you one call; a batch that misses costs you " +
            "all of them.",
    );
    return lines.join("\n");
}

/**
 * The guidance to APPEND to pi's own error, for a decision that is not a repair.
 *
 * Why appended rather than substituted for the call. Every non-repair decision
 * used to return `block: true`, which stops pi's edit from running at all. That
 * looked harmless -- the edit was going to fail anyway -- but a blocked tool
 * reads to the agent as a tool that does not work, and the measurements say it
 * responded by leaving: python3-heredoc calls per edit call went 1.5, 1.1, 1.9,
 * 1.7 across four runs and then **3.5** in the run with the most blocking. Once
 * the agent is manipulating files with shell scripts, this module sees nothing,
 * the diff audit does not run until review, and whitespace damage lands silently
 * -- which is exactly the class of bug we have been chasing all along.
 *
 * So the call now goes through, pi reports its own failure in its own words, and
 * this rides along underneath. Same information, without teaching the agent that
 * `edit` is unreliable.
 */
export function guidanceFor(
    path: string,
    decision: EditDecision,
): string | null {
    switch (decision.kind) {
        case "satisfied":
            return satisfiedReason(path, decision.index);
        case "explain":
            return explainReason(path, decision.index, decision.actual);
        case "partial":
            return partialReason(path, decision.outcomes);
        default:
            return null;
    }
}

/** One machine-readable record of what the hook saw and decided. */
export interface AuditRecord {
    path: string;
    /** Length of the file as the hook read it — the cheapest divergence signal. */
    bodyLen: number;
    kind: EditDecision["kind"];
    /** How many edits the call carried, and what each would do. */
    states: EditOutcome["state"][];
    /** Repairs actually applied, as index numbers. */
    repaired: number[];
}

/**
 * Build the record for one edit call.
 *
 * This exists because every coverage number I have reported for this module was
 * measured the wrong way. The analysis compared each `oldText` against the text
 * the agent last READ; the hook matches against the file on DISK at call time.
 * When those diverge — and run-mtfq7k48-0hmvl shows them diverging often, with
 * six misses whose oldText was present at read time and gone by edit time — the
 * offline analysis reports repairs that could never have happened, and the
 * "coverage 23% -> 45% -> 63%" figures are optimistic by an unknown margin.
 *
 * Logging the hook's OWN view removes the inference. Every edit call is
 * recorded, including the ones needing nothing, so the denominator is real
 * rather than reconstructed.
 */
export function auditRecord(
    path: string,
    body: string,
    edits: EditPair[],
    decision: EditDecision,
): AuditRecord {
    return {
        path,
        bodyLen: body.length,
        kind: decision.kind,
        states: classifyBatch(body, edits).map((o) => o.state),
        repaired:
            decision.kind === "repair" ? decision.repairs.map((r) => r.index) : [],
    };
}

/** A one-line audit record. Whitespace is escaped so a run is visible as a run. */
export function formatRepair(path: string, r: Repair): string {
    const show = (s: string) =>
        JSON.stringify(s.length > 120 ? s.slice(0, 117) + "..." : s);
    return `${path} edits[${r.index}].${r.field ?? "oldText"} ${show(r.from)} -> ${show(r.to)}`;
}
