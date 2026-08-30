// ABOUTME: Reports what the edit hook actually did, from its own audit log.
//
// This replaces an offline analysis that was wrong. That one reconstructed each
// call by comparing `oldText` against the text the agent last READ; the hook
// matches against the file on DISK at call time. Those diverge — in
// run-mtfq7k48-0hmvl six misses had an `oldText` that was present at read time
// and gone by edit time — so the reconstruction credited repairs that could not
// have happened, and every coverage figure derived from it was optimistic by an
// unknown margin.
//
// The hook now writes one DECISION record per edit call, including calls that
// needed nothing, so both numerator and denominator are observed rather than
// inferred. Read them with `npm run edit:coverage`.

export interface CoverageReport {
    /** Every edit call the hook saw. */
    calls: number;
    /** Calls where every edit already matched — the hook did nothing. */
    clean: number;
    /** Calls the hook repaired, and the number of individual edits repaired. */
    repairedCalls: number;
    repairedEdits: number;
    /** Calls that would fail, by the guidance the hook attached. */
    partial: number;
    explain: number;
    satisfied: number;
    /** Individual edits by predicted fate, across every call. */
    states: Record<string, number>;
    /** Calls recorded in observe-only mode, where the hook changed nothing. */
    observed: number;
}

const KINDS = ["pass", "repair", "partial", "explain", "satisfied"] as const;

/**
 * Parse DECISION lines out of the audit log.
 *
 * Tolerant by design: the log also carries human-readable REPAIR/EXPLAIN lines,
 * and a truncated final line is normal while a run is in flight. Anything that
 * does not parse is skipped rather than throwing, because a reporting tool that
 * dies on a partial write is useless exactly when you want it.
 */
export function parseAuditLog(text: string, since = ""): CoverageReport {
    const report: CoverageReport = {
        calls: 0,
        clean: 0,
        repairedCalls: 0,
        repairedEdits: 0,
        partial: 0,
        explain: 0,
        satisfied: 0,
        states: {},
        observed: 0,
    };
    for (const line of (text || "").split(/\r?\n/)) {
        const at = line.indexOf(" DECISION ");
        if (at === -1) continue;
        if (since && line.slice(0, at) < since) continue;
        let rec: any;
        try {
            rec = JSON.parse(line.slice(at + 10));
        } catch {
            continue;
        }
        if (!rec || typeof rec.kind !== "string") continue;
        report.calls++;
        if (rec.observed) report.observed++;
        if (rec.kind === "pass") report.clean++;
        else if (rec.kind === "repair") {
            report.repairedCalls++;
            report.repairedEdits += Array.isArray(rec.repaired)
                ? rec.repaired.length
                : 0;
        } else if ((KINDS as readonly string[]).includes(rec.kind))
            (report as any)[rec.kind]++;
        for (const s of Array.isArray(rec.states) ? rec.states : [])
            report.states[s] = (report.states[s] || 0) + 1;
    }
    return report;
}

/** Render the report. Percentages are of edits, not calls, since a call is
 *  all-or-nothing but the interesting unit is the individual edit. */
export function formatCoverage(r: CoverageReport): string {
    const edits = Object.values(r.states).reduce((a, b) => a + b, 0);
    const pct = (n: number) => (edits ? `${Math.round((100 * n) / edits)}%` : "-");
    // A mixed report would be meaningless: half the calls repaired, half left
    // alone, one set of percentages over both. Say which it is.
    const mode =
        r.observed === 0
            ? ""
            : r.observed === r.calls
              ? "  [OBSERVE-ONLY: the hook recorded these and changed nothing]\n"
              : `  [MIXED: ${r.observed} of ${r.calls} calls were observe-only — do not read these as one population]\n`;
    const lines = [
        `edit calls seen by the hook: ${r.calls}  (${edits} individual edits)`,
        mode.trimEnd(),
        "",
        `  needed nothing        ${String(r.clean).padStart(4)} calls`,
        `  repaired              ${String(r.repairedCalls).padStart(4)} calls  (${r.repairedEdits} edits)`,
        `  batch triaged         ${String(r.partial).padStart(4)} calls`,
        `  already applied       ${String(r.satisfied).padStart(4)} calls`,
        `  explained only        ${String(r.explain).padStart(4)} calls`,
        "",
        "  per-edit fate:",
    ];
    for (const [k, v] of Object.entries(r.states).sort((a, b) => b[1] - a[1]))
        lines.push(`    ${String(v).padStart(4)}  ${pct(v).padStart(4)}  ${k}`);
    const fixable = (r.states.repairable || 0) + (r.states.applies || 0);
    if (edits)
        lines.push(
            "",
            `  ${pct(fixable)} of edits would land (as sent, or after repair);`,
            `  ${pct(r.states.missing || 0)} miss for reasons this hook cannot fix.`,
        );
    return lines.join("\n");
}
