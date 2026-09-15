// ABOUTME: Pure utility functions for the workflow orchestrator — no pi runtime dependencies.
// ABOUTME: Extracted and exported so they can be unit-tested independently.

export type Verdict = "pass" | "fail" | "paused" | "unknown";

export type CritiqueVerdict =
    | "approved"
    | "approved-with-reservations"
    | "revise"
    | "unknown";

const TRIVIAL_PING_RE =
    /^(ping|pong|hi|hello|hey|yo|test|status|health\s?check|you\s+there|are\s+you\s+(there|up|alive)|ping\s+(all\s+)?(agents?|everyone|all))$/i;

/**
 * True when the entire request is a trivial ping / greeting / health check. In
 * that case the workflow health-checks every agent (in parallel) instead of
 * running the real pipeline.
 */
export function isTrivialPing(request: string): boolean {
    const r = request
        .trim()
        .replace(/[!.?,…]+$/u, "")
        .trim();
    return r.length > 0 && r.length <= 40 && TRIVIAL_PING_RE.test(r);
}

/**
 * A regex for a `LABEL: VALUE` marker, tolerant of the markdown an agent wraps
 * around it but never of the prose around that.
 *
 * Built rather than hand-written because the hand-written pair got the same
 * detail wrong twice: the decoration group sat directly against the value, so
 * `**VERDICT:** PASS` -- a form the doc comment claimed to support -- did not
 * match. The space after `**` killed it, the call fell through to the fallback
 * heuristic, and the tests passed only because that heuristic happened to find
 * the right bare word. It does not always:
 *
 *     "All targeted tests pass.\n\n**VERDICT:** FAIL"  ->  pass
 *
 * A validator that says FAIL read as PASS is the worst outcome this module can
 * produce, and validator output routinely opens with prose about tests passing.
 *
 * `\s*` after the colon is deliberate (a value on the next line is still a
 * value); it cannot run away, because whitespace alone cannot skip a word.
 */
function markerPattern(label: string, values: string): RegExp {
    return new RegExp(
        // optional markdown heading, then decoration that may open before the
        // label and close after it, or wrap the whole `LABEL: VALUE` pair
        `(?:#{1,6}[ \\t]*)?[\`*_]{0,2}${label}[\`*_]{0,2}[ \\t]*:` +
            // the value may be on the next line, decorated, or both -- and the
            // decoration may be followed by space before the value itself
            `\\s*[\`*_]{0,2}[ \\t]*(${values})[\`*_]{0,2}`,
        "gi",
    );
}

/**
 * The fallback for output with no marker at all: a line that is NOTHING BUT the
 * bare word, give or take decoration.
 *
 * Deliberately far stricter than "the word appears in the first 20 lines". That
 * version inverted verdicts, and the failing shape is the common one -- any
 * sentence mentioning passing tests ahead of the marker won. Returning
 * `unknown` costs a retry with `noVerdictRetryNote`; guessing wrong ships a
 * failing run.
 */
function bareLineValue(output: string, values: RegExp): string | null {
    for (const line of output.split("\n").slice(0, 20)) {
        const m = /^[ \t>#*_`-]*([A-Za-z]+)[ \t*_`.:]*$/.exec(line);
        if (m && values.test(m[1])) return m[1].toLowerCase();
    }
    return null;
}

/**
 * Detect the validator's verdict from its output.
 * Prefers the explicit VERDICT: marker; falls back to scanning only the first
 * 20 lines to avoid false matches in the agent's reasoning text.
 */
export function detectVerdict(output: string): Verdict {
    // Prefer the explicit machine-readable marker the validator is asked to emit.
    // Take the LAST occurrence: the authoritative verdict is emitted at the end, so
    // an earlier one in the reasoning (e.g. "this would be VERDICT: FAIL if …") must
    // not override the final line.
    // Matches:
    //   VERDICT: PASS
    //   **VERDICT:** PASS or **VERDICT: PASS** or VERDICT: **PASS** or VERDICT: `PASS`
    //   ## Verdict: PASS
    //   "verdict": "pass"
    const textMarkers = [
        ...output.matchAll(markerPattern("VERDICT", "PASS|FAIL|PAUSED")),
    ];
    const jsonMarkers = [
        ...output.matchAll(/"verdict"[ \t]*:[ \t]*['"](PASS|FAIL|PAUSED)['"]/gi),
    ];
    const markers = [...textMarkers, ...jsonMarkers].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    if (markers.length)
        return markers[markers.length - 1][1].toLowerCase() as Verdict;

    // No marker: accept only a line that is nothing but the bare word. Anything
    // looser inverts verdicts -- see bareLineValue.
    return (bareLineValue(output, /^(pass|fail|paused)$/i) as Verdict) ?? "unknown";
}

// The explicit review markers, in priority order at any given position:
//   1. REVISE BEFORE <verb> — a multi-word phrase that can't occur by accident, so
//      it stays loose (it may appear mid-sentence).
//   2. APPROVED WITH RESERVATIONS — word-guarded so "unapproved with …" can't hit.
//   3. a bare APPROVED that OPENS its line (optionally decorated with a heading,
//      bold markers, or a "Verdict:" label, per agents/reviewer.md's output format).
// (3) is deliberately line-anchored: an unguarded substring match made "not
// approved", "unapproved", and "…once fixed it can be approved" all read as an
// approval — and, because the LAST marker wins, one of those in the prose after an
// explicit REVISE BEFORE MERGE silently reopened the review gate.
const CRITIQUE_MARKER_RE =
    /REVISE\s+BEFORE\s+(?:MERGE|MERGING|IMPLEMENTING|DOCUMENTING|PUBLISHING)|(?<![A-Za-z])APPROVED\s+WITH\s+RESERVATIONS(?![A-Za-z])|^[ \t]*(?:#{1,6}[ \t]*)?\**(?:VERDICT[ \t]*:[ \t]*)?\**APPROVED(?![A-Za-z])(?![ \t*]*WITH[ \t]+RESERVATIONS)/gim;

/**
 * Detect a review verdict from an agent's output (the reviewer's code review, or a
 * critic-style document review). Prefers the explicit REVISE BEFORE
 * MERGE/IMPLEMENTING/DOCUMENTING/PUBLISHING / APPROVED WITH RESERVATIONS / APPROVED
 * marker; falls back to scanning only the first 20 lines.
 */
export function detectCritique(output: string): CritiqueVerdict {
    // Take the LAST marker: the authoritative verdict is emitted at the end, so an
    // earlier mention in the reasoning must not override the final call.
    const markers = [...output.matchAll(CRITIQUE_MARKER_RE)];
    if (markers.length) {
        // Strip any leading decoration ("## ", "**") the marker consumed.
        const v = markers[markers.length - 1][0].toUpperCase().replace(/^[^A-Z]+/, "");
        if (v.startsWith("REVISE")) return "revise";
        if (v.startsWith("APPROVED WITH")) return "approved-with-reservations";
        return "approved";
    }

    // Fallback: scan only the first 20 lines and require the verdict to appear
    // on its own line (optionally under a ## heading) to avoid matching the word
    // "approved" buried in the agent's reasoning text.
    const head = output.split("\n").slice(0, 20).join("\n");
    if (
        /^.*\brevise\s+before\s+(?:merge|merging|implementing|documenting|publishing)\b.*$/im.test(
            head,
        )
    )
        return "revise";
    if (/^.*\bapproved\s+with\s+reservations\b.*$/im.test(head))
        return "approved-with-reservations";
    // "APPROVED" must stand alone on its line (ignoring surrounding whitespace)
    // to avoid matching e.g. "not approved" or "should be approved if".
    if (/^\s*approved\s*$/im.test(head)) return "approved";
    return "unknown";
}

/**
 * Detect the ship step's outcome: was a PR opened, or is the work committed
 * locally only? The "paused" return is about the PR, NOT about the run — a run
 * with no remote still completes (see outcomeLine's `shipped-local`).
 *
 * `SHIP: LOCAL` is the current marker; `SHIP: PAUSED` is the older spelling of the
 * same thing and is still accepted, both from in-flight sessions and from any
 * shipper prompt that has not been updated.
 */
export function detectShip(output: string): "shipped" | "paused" {
    // Take the LAST marker: the authoritative outcome is emitted at the end.
    const textMarkers = [
        ...output.matchAll(markerPattern("SHIP", "SHIPPED|PAUSED|LOCAL")),
    ];
    const jsonMarkers = [
        ...output.matchAll(/"ship"[ \t]*:[ \t]*['"](SHIPPED|PAUSED|LOCAL)['"]/gi),
    ];
    const markers = [...textMarkers, ...jsonMarkers].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    if (markers.length) {
        const v = markers[markers.length - 1][1].toLowerCase();
        return v === "paused" || v === "local" ? "paused" : "shipped";
    }
    // No marker. Default to "paused", i.e. committed locally with no PR.
    //
    // The old default was "shipped", which asserts a pull request exists. That is
    // the claim a reader cannot check without leaving the report, and it was wrong
    // for every unmatched local run. Understating is recoverable -- someone opens
    // the PR -- while overstating sends people looking for a PR that was never
    // created.
    const head = output.split("\n").slice(0, 20).join("\n");
    if (/\bshipped\b/i.test(head) && !/\bno\b[^.\n]{0,16}\bremote\b/i.test(head))
        return "shipped";
    return "paused";
}

// Format a duration: plain seconds under a minute, "Nm Ss" (or "Nm") above it.
export function secs(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * First substantive paragraph of an agent's output, for a one-line digest.
 * Skips blank lines, markdown headings, and horizontal rules at the start.
 */
export function digest(text: string, maxLen = 280): string {
    const picked: string[] = [];
    for (const raw of text.split("\n")) {
        const l = raw.trim();
        if (!l) {
            if (picked.length) break;
            continue;
        }
        if (/^#{1,6}\s/.test(l)) continue;
        if (/^[-*_]{3,}$/.test(l)) continue;
        picked.push(l.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, ""));
        if (picked.join(" ").length >= maxLen) break;
    }
    let s =
        picked.join(" ").trim() ||
        text.trim().slice(0, maxLen) ||
        "[no output]";
    s = s.replace(/\s+/g, " ");
    return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * Best-effort "N passed / M failed" signal from a validator's suite output.
 */
export function testSignal(output: string): string {
    const pass = output.match(/(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i);
    const fail = output.match(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?/i);
    if (!pass && !fail) return "";
    const parts: string[] = [];
    if (pass) parts.push(`${pass[1]} passed`);
    if (fail) parts.push(`${fail[1]} failed`);
    return ` (${parts.join(", ")})`;
}

/**
 * Detect whether a failed agent run was caused by the model being unavailable,
 * unknown, or misconfigured. Matches common error patterns from pi's stderr and
 * the appended `[stderr]` block in the agent output.
 *
 * Uses broad proximity-based matching because pi's exact error format varies
 * across providers and versions (e.g. `Error: Model "x" not found`,
 * `model x is not supported`, `unknown model: x`, etc.).
 */
export function isModelFailure(output: string): boolean {
    const combined = output.toLowerCase();

    // Dead giveaway: pi suggests --list-models when it can't resolve a model.
    if (/--list[- ]models/.test(combined)) return true;

    // HTTP error codes that indicate a bad/unknown model or request — 404 Not
    // Found, 400 Bad Request (invalid model). NOT 502: a Bad Gateway is a transient
    // upstream/gateway hiccup, handled by isTransientError (retry the same model),
    // not a model misconfiguration (which would fall back to a different model).
    if (
        /\b(?:404|400)\b[^\n]{0,40}(?:request\s+failed|not\s+found|bad\s+request|error)/.test(
            combined,
        )
    )
        return true;
    if (
        /(?:request\s+failed|error|failed)[^\n]{0,40}\b(?:404|400)\b/.test(
            combined,
        )
    )
        return true;

    // Structured pattern — a QUOTED model/provider name followed by an error
    // keyword ('Error: Model "gpt-5" not found', 'provider "openai" is not
    // supported'). The quotes make this unambiguous even outside an error line.
    if (
        /(?:model|provider)\s*[""''"'`][^\n""''"'`]{0,80}[""''"'`][^\n]{0,40}?(?:not\s+found|unknown|invalid|unavailable|does\s+not\s+exist|is\s+not\s+supported|no\s+such|not\s+supported|cannot\s+be\s+found)/.test(
            combined,
        )
    )
        return true;

    // Reverse order: error keyword before model/provider
    if (
        /(?:unknown|invalid|unsupported|unavailable)\s+(?:model|provider)/.test(
            combined,
        )
    )
        return true;

    // "failed to load/resolve/find/connect" + model
    if (
        /failed\s+to\s+(?:load|resolve|find|connect)[^\n]{0,40}model/.test(
            combined,
        )
    )
        return true;

    // Auth/key errors mentioning model
    if (
        /(?:api\s+key|authentication|unauthorized|forbidden)[^\n]{0,60}model/.test(
            combined,
        )
    )
        return true;
    if (
        /model[^\n]{0,60}(?:api\s+key|authentication|unauthorized|forbidden)/.test(
            combined,
        )
    )
        return true;

    // Everything below is proximity-based and would otherwise fire on ordinary
    // domain prose ("the data model is invalid" routed a LOGICAL failure into a
    // fallback-model retry), so it only looks at lines that actually read like an
    // error report.
    const errorish = combined
        .split("\n")
        .filter((l) => /error|fail|exception/.test(l))
        .join("\n");
    if (!errorish) return false;

    // Unquoted model/provider followed by an error keyword.
    if (
        /(?:model|provider)\s*[^\n]{0,80}?(?:not\s+found|unknown|invalid|unavailable|does\s+not\s+exist|is\s+not\s+supported|no\s+such|not\s+supported|cannot\s+be\s+found)/.test(
            errorish,
        )
    )
        return true;

    // Broad proximity catch-all: "model" and an error keyword within 120 chars.
    // This is the safety net for any format we haven't anticipated.
    const modelIdx = errorish.indexOf("model");
    if (modelIdx >= 0) {
        const window = errorish.slice(
            Math.max(0, modelIdx - 60),
            modelIdx + 120,
        );
        if (
            /not\s+found|unknown|invalid|unavailable|does\s+not\s+exist|is\s+not\s+supported|no\s+such|not\s+supported|cannot\s+be\s+found/.test(
                window,
            )
        )
            return true;
    }

    return false;
}

/**
 * Detect a TRANSIENT agent failure worth retrying with the SAME model — an
 * interrupted/incomplete stream, a dropped connection, or a temporary
 * server/rate-limit response. Distinct from isModelFailure (model misconfig →
 * fall back to another model) and from logical failures (bad output, test fail →
 * don't retry). Excludes our own watchdog timeout, which is intentional.
 */
export function isTransientError(output: string): boolean {
    const s = (output || "").toLowerCase();
    // Our watchdog kill is intentional — never retry it as if it were transient.
    if (/killed by pi_workflow_agent_timeout/.test(s)) return false;

    // Interrupted / incomplete stream (e.g. "Stream ended without finish_reason").
    if (/stream ended without finish[_ ]reason/.test(s)) return true;
    if (/stream (?:ended|closed|disconnected|interrupted|error|reset)/.test(s))
        return true;
    if (
        /premature close|unexpected end of (?:json|stream|input|data)|incomplete (?:response|stream|chunked)/.test(
            s,
        )
    )
        return true;

    // Dropped connection / socket.
    if (
        /connection (?:reset|closed|refused|aborted|error)|socket hang ?up|econnreset|etimedout|enotfound|epipe|econnrefused|eai_again/.test(
            s,
        )
    )
        return true;
    if (
        /fetch failed|network (?:error|timeout)|request timed out|read timed out|timeout exceeded/.test(
            s,
        )
    )
        return true;

    // Temporary server / rate-limit / gateway responses. 502 Bad Gateway is a
    // transient upstream hiccup (common on proxy/router providers), not a model
    // misconfig — retry the same model rather than falling back.
    if (/\b(?:429|502|503|504|529)\b/.test(s)) return true;
    if (
        /rate.?limit|too many requests|overloaded|temporarily unavailable|service unavailable|please try again|try again later/.test(
            s,
        )
    )
        return true;

    return false;
}

// ── Roadmap milestones ───────────────────────────────────────────────────────

export interface RoadmapMilestone {
    number: number;
    title: string;
    body: string; // the milestone's own section, so the prompt can quote it verbatim
}

/**
 * The first milestone in a roadmap whose checkbox is still unchecked — i.e. the
 * one to plan next.
 *
 * Computed here rather than left to the planner to work out by reading the file.
 * Asking a model to scan a long roadmap and identify "the first `- [ ]`" is a
 * judgement call it can get wrong (and a wrong answer plans the wrong milestone,
 * silently). It is also what makes the milestone number authoritative for ticking
 * off later, instead of depending on the planner echoing it back.
 *
 * A milestone with no checkbox at all is treated as NOT started: an author who
 * omitted the box has not claimed the work is done.
 */
export function nextMilestone(roadmap: string): RoadmapMilestone | null {
    const lines = (roadmap || "").split(/\r?\n/);
    const heads: { number: number; title: string; at: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^#{1,6}\s*milestone\s+(\d+)\s*[:—-]?\s*(.*)$/i.exec(lines[i]);
        if (m) {
            heads.push({
                number: parseInt(m[1], 10),
                title: m[2].trim(),
                at: i,
            });
        }
    }
    for (let h = 0; h < heads.length; h++) {
        const start = heads[h].at;
        const end = h + 1 < heads.length ? heads[h + 1].at : lines.length;
        const section = lines.slice(start, end);
        const box = section.find((l) => /^\s*-\s*\[[ xX]\]/.test(l));
        if (box && !/^\s*-\s*\[ \]/.test(box)) continue; // done
        return {
            number: heads[h].number,
            title: heads[h].title,
            body: section.join("\n").trim(),
        };
    }
    return null;
}

//
// The milestone the plan claimed, from the header the planner writes
// ("Milestone: 2 of 9"). Deliberately reads the PLAN rather than picking the
// roadmap's first unchecked box: the plan is the record of what this run actually
// built, and those two can differ — a request can name a specific milestone, and a
// roadmap can gain a milestone mid-flight.
//
// Only the first 40 lines are scanned, so a "Milestone: 3" inside a Deferred
// section listing the milestones this plan did NOT cover cannot be mistaken for
// the one it did.
export function parsePlanMilestone(plan: string): number | null {
    for (const line of (plan || "").split(/\r?\n/).slice(0, 40)) {
        const m = /^\s*(?:[-*]\s*)?(?:\*\*)?milestone(?:\*\*)?\s*[:—-]\s*(?:\*\*)?\s*#?(\d+)\b/i.exec(
            line,
        );
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

/**
 * Flip milestone `n`'s checkbox to done in a roadmap, stamping the evidence that
 * justified it.
 *
 * The evidence is the point. Auto-ticking an unattributed box would let the
 * roadmap drift from what actually shipped, with no way to audit it later; a tick
 * that says which run and which verdict closed it stays checkable. Never unticks,
 * never renumbers, never touches another milestone, and leaves an already-checked
 * box alone (so a re-run cannot restamp history).
 */
export function markMilestoneDone(
    roadmap: string,
    n: number,
    evidence: string,
): { text: string; changed: boolean } {
    const lines = (roadmap || "").split(/\r?\n/);
    const heading = new RegExp(`^#{1,6}\\s*milestone\\s+${n}\\b`, "i");
    let inTarget = false;

    for (let i = 0; i < lines.length; i++) {
        if (/^#{1,6}\s*milestone\s+\d+\b/i.test(lines[i])) {
            // Entering a new milestone section ends the previous one, so a
            // milestone with no checkbox can never leak the flip into the next.
            inTarget = heading.test(lines[i]);
            continue;
        }
        if (!inTarget) continue;
        const box = /^(\s*-\s*)\[([ xX])\](\s*)(.*)$/.exec(lines[i]);
        if (!box) continue;
        if (box[2] !== " ") return { text: roadmap, changed: false }; // already done
        lines[i] = `${box[1]}[x]${box[3]}complete — ${evidence}`;
        return { text: lines.join("\n"), changed: true };
    }
    return { text: roadmap, changed: false };
}

/**
 * Whether a finished run is a strong enough claim to tick a milestone off.
 *
 * Conjunctive on purpose. "Shipped" alone is not enough: a roster with no
 * validator never independently checked the work, and a plan whose phases are not
 * all done did not deliver the milestone even if what it did deliver passed.
 */
export function milestoneEarned(opts: {
    status: string;
    hadValidator: boolean;
    phasesTotal: number;
    phasesDone: number;
}): boolean {
    const { status, hadValidator, phasesTotal, phasesDone } = opts;
    if (!hadValidator) return false;
    // "paused-no-remote" is the pre-rename spelling of "shipped-local"; accepted so
    // a roadmap ticked by an older run still reads consistently.
    if (
        status !== "shipped" &&
        status !== "shipped-local" &&
        status !== "paused-no-remote"
    )
        return false;
    return phasesTotal > 0 && phasesDone >= phasesTotal;
}

/**
 * Warning shown once at run start when the working directory is not a git repo.
 *
 * The workflow degrades cleanly without one — createCheckpoint returns null and
 * ensureWorkBranch no-ops — but it degrades SILENTLY, so the first sign of trouble
 * is an agent's own `git status` failing mid-run with "fatal: not a git repository"
 * and taking its whole bash call down with it. Say it up front instead, and name
 * what is actually lost: /revert has nothing to restore, and a build roster has no
 * way to commit, branch, or open a PR.
 *
 * Returns "" when there is nothing to warn about.
 */
export function gitPreflightNote(
    isGitRepo: boolean,
    willBuild: boolean,
    hasCommits = true,
): string {
    if (!isGitRepo) {
        const lost = willBuild
            ? "/revert has no checkpoint to restore, no per-phase commits are made, and the shipper cannot branch or open a PR"
            : "/revert has no checkpoint to restore";
        return `Not a git repository — ${lost}. Run \`git init\` here (or start the workflow inside the target repo) if you want those.`;
    }
    // A repo with NO commits is the more dangerous state, and the one that used to
    // pass silently: `rev-parse --is-inside-work-tree` succeeds, so everything looks
    // healthy, while `rev-parse HEAD` fails and takes the safety net with it.
    // createCheckpoint stores an empty head, ensureWorkBranch returns null, and a
    // whole run can complete with every file untracked and no rollback point.
    // Observed live: five phases and 189 minutes with zero commits.
    if (!hasCommits) {
        const lost = willBuild
            ? "there is no base commit to branch from, so no work branch is created, per-phase checkpoints have nothing to build on, and /revert cannot restore anything"
            : "/revert has no base commit to restore to";
        return `Git repository has no commits — ${lost}. Make an initial commit (\`git commit --allow-empty -m "init"\`) before a build run.`;
    }
    return "";
}

/**
 * The one-line outcome at the top of the report.
 *
 * `needs-review` has TWO causes and used to name only one of them. It is set both
 * when the validator returns no parseable verdict AND when the validator passed
 * but the reviewer blocked -- and it always printed "the validator did not return
 * a clear PASS/FAIL/PAUSED verdict".
 *
 * On run-mtgg9k2p-vmgn1 that line was simply false. The validator opened its
 * output with `VERDICT: PASS`; the REVIEWER returned `REVISE BEFORE MERGE` over a
 * stale help-output fixture, which is a correct block. The report said the
 * validator had failed to answer, and reading it sent this investigation into the
 * verdict parser -- which was working -- while the actual blocker sat unnamed in
 * the review section. The header of the report is the one line everyone reads;
 * it has to say which gate stopped the run.
 *
 * The verdict is enough to tell them apart, so no new plumbing: a real verdict
 * with `needs-review` means something after the validator objected.
 */
export function outcomeLine(
    status: string,
    passes: number,
    verdict = "",
): string {
    switch (status) {
        case "shipped":
            return "SHIPPED — the validator approved the change and opened a draft pull request.";
        case "shipped-local":
        // Pre-rename spelling, kept so historical reports still render.
        case "paused-no-remote":
            return "COMPLETE — the change is built, reviewed, and committed on a local feature branch. No git remote is configured, so no pull request was opened; add one and push the branch when you want a PR.";
        case "failed-after-retries":
            return `FAILED — the change did not pass validation after ${passes} attempt(s).`;
        case "needs-review":
            if (verdict.toLowerCase() === "pass")
                return "NEEDS REVIEW — the validator PASSED, but the reviewer asked for changes before merge, so nothing was documented or shipped. The blocking findings are in the review section, not the validation one.";
            if (verdict.toLowerCase() === "paused")
                return "NEEDS REVIEW — the validator PAUSED rather than deciding; check the validation section for what it was waiting on.";
            return "NEEDS REVIEW — the validator did not return a clear PASS/FAIL/PAUSED verdict; check the validation section.";
        default:
            return status.toUpperCase();
    }
}

export interface FileCollision {
    file: string;
    agents: string[];
}

function cleanCandidatePath(raw: string, cwd = ""): string | null {
    if (!raw) return null;
    let s = raw.trim();
    s = s.replace(/^["'`(<[{]+|[)"'`>\]}.,:;]+$/g, "");
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return null;
    if (s.startsWith("file://")) s = s.slice(7);
    s = s.replace(/\\/g, "/");
    // Resolve an absolute path against the run's cwd BEFORE stripping slashes.
    // Stripping alone left `/Users/me/repo/src/a.ts` and `src/a.ts` as different
    // keys, so two workers naming the same file two ways were never flagged.
    if (cwd) {
        const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
        if (s === root) return null;
        if (s.startsWith(root + "/")) s = s.slice(root.length + 1);
    }
    s = s.replace(/^\.\//, "");
    s = s.replace(/^\/+/, "");
    const parts = s.split("/");
    const last = parts[parts.length - 1];
    if (!last || !last.includes(".")) return null;
    if (/^\d+\.\d+(\.\d+)?$/.test(last)) return null;
    if (/^(e\.g\.|i\.e\.|etc\.)$/i.test(last)) return null;
    const ext = last.split(".").pop()?.toLowerCase();
    if (!ext || ext.length > 8 || !/^[a-z0-9]+$/i.test(ext)) return null;
    return s;
}

/**
 * Extracts referenced file paths from an agent task description or prompt.
 * Recognizes backticked files (`src/app.ts`), file:// paths, relative paths
 * with directories (utils/workflow/foo.ts), and well-known source file patterns.
 */
export function extractReferencedFiles(text: string, cwd = ""): string[] {
    if (!text) return [];
    // Remove http:// and https:// URLs first so they are never parsed as local files.
    const sanitized = text.replace(/https?:\/\/[^\s"'`<>]+/gi, " ");
    const files = new Set<string>();

    const backtickRegex = /`([^`\n\r]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickRegex.exec(sanitized)) !== null) {
        const candidate = cleanCandidatePath(match[1], cwd);
        if (candidate) files.add(candidate);
    }

    const fileUriRegex = /file:\/\/[^\s"'`<>]+/g;
    while ((match = fileUriRegex.exec(sanitized)) !== null) {
        const candidate = cleanCandidatePath(match[0], cwd);
        if (candidate) files.add(candidate);
    }

    const pathRegex = /(?:(?:\.{1,2}\/|[a-zA-Z0-9_@-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,10}|\b[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|sh|ya?ml|toml|css|html)\b)/g;
    while ((match = pathRegex.exec(sanitized)) !== null) {
        const candidate = cleanCandidatePath(match[0], cwd);
        if (candidate) files.add(candidate);
    }

    return Array.from(files).sort();
}

/**
 * Detects potential file collisions across concurrent tasks in a parallel wave.
 * Returns a list of files that are referenced by more than one agent.
 */
export function detectFileCollisions(
    items: { agent: string; task: string }[],
    cwd = "",
): FileCollision[] {
    // Key by the item's INDEX, not its agent name. `dispatchParallelCore` never
    // dedupes agents, and the commonest wave is several `phase-implementer`s --
    // so a name-keyed set collapsed the two-workers-one-file case to size 1 and
    // never flagged it. That is exactly the case worth flagging.
    const fileToItems = new Map<string, Set<number>>();
    items.forEach((item, i) => {
        // Bare filenames count. A mention ("see package.json") can produce a
        // warning that was not a real overlap, and that costs a line of noise;
        // skipping them loses `package.json` / `go.mod` collisions, which are the
        // shared-file clobbers this exists to catch. The detector only WARNS, so
        // the cheap error is the right one to make. The wording says "referenced
        // by", which stays true either way.
        for (const file of extractReferencedFiles(item.task, cwd)) {
            let set = fileToItems.get(file);
            if (!set) {
                set = new Set();
                fileToItems.set(file, set);
            }
            set.add(i);
        }
    });
    // Disambiguate identical agent names so the warning names distinct workers.
    const counts = new Map<string, number>();
    for (const it of items)
        counts.set(it.agent, (counts.get(it.agent) ?? 0) + 1);
    const seen = new Map<string, number>();
    const label = items.map((it) => {
        if ((counts.get(it.agent) ?? 0) < 2) return it.agent;
        const n = (seen.get(it.agent) ?? 0) + 1;
        seen.set(it.agent, n);
        return `${it.agent} #${n}`;
    });

    const collisions: FileCollision[] = [];
    for (const [file, idxs] of fileToItems.entries())
        if (idxs.size > 1)
            collisions.push({
                file,
                agents: Array.from(idxs)
                    .sort((a, b) => a - b)
                    .map((i) => label[i]),
            });
    return collisions.sort((a, b) => a.file.localeCompare(b.file));
}
