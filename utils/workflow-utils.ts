// ABOUTME: Pure utility functions for the workflow orchestrator — no pi runtime dependencies.
// ABOUTME: Extracted and exported so they can be unit-tested independently.

export type Verdict = "pass" | "fail" | "paused" | "unknown";

export type CritiqueVerdict =
    | "approved"
    | "approved-with-reservations"
    | "revise"
    | "unknown";

/**
 * Detect the validator's verdict from its output.
 * Prefers the explicit VERDICT: marker; falls back to scanning only the first
 * 20 lines to avoid false matches in the agent's reasoning text.
 */
export function detectVerdict(output: string): Verdict {
    // Prefer the explicit machine-readable marker the validator is asked to emit.
    // Search the full output — the marker may appear anywhere.
    const marker = output.match(/VERDICT:\s*(PASS|FAIL|PAUSED)/i);
    if (marker) return marker[1].toLowerCase() as Verdict;

    // Fallback heuristic: only scan the first 20 lines to avoid matching
    // "pass" or "fail" inside the agent's reasoning text.
    const head = output.split("\n").slice(0, 20).join("\n");
    if (/\bpaused\b/i.test(head)) return "paused";
    const m = head.match(/\b(pass|fail)\b/i);
    if (!m) return "unknown";
    return m[1].toLowerCase() === "pass" ? "pass" : "fail";
}

/**
 * Detect the ship step's outcome: PR opened or paused (no remote).
 * Prefers the explicit SHIP: marker; falls back to the first 20 lines only.
 */
/**
 * Detect the critic's verdict from its output.
 * Prefers the explicit REVISE BEFORE DOCUMENTING / APPROVED WITH RESERVATIONS /
 * APPROVED marker; falls back to scanning only the first 20 lines.
 */
export function detectCritique(output: string): CritiqueVerdict {
    const marker = output.match(
        /REVISE\s+BEFORE\s+(?:IMPLEMENTING|DOCUMENTING)|APPROVED\s+WITH\s+RESERVATIONS|APPROVED/i,
    );
    if (marker) {
        const v = marker[0].toUpperCase();
        if (v.startsWith("REVISE")) return "revise";
        if (v.startsWith("APPROVED WITH")) return "approved-with-reservations";
        return "approved";
    }

    // Fallback: scan only the first 20 lines and require the verdict to appear
    // on its own line (optionally under a ## heading) to avoid matching the word
    // "approved" buried in the critic's reasoning text.
    const head = output.split("\n").slice(0, 20).join("\n");
    if (/^.*\brevise\s+before\s+(?:implementing|documenting)\b.*$/im.test(head))
        return "revise";
    if (/^.*\bapproved\s+with\s+reservations\b.*$/im.test(head))
        return "approved-with-reservations";
    // "APPROVED" must stand alone on its line (ignoring surrounding whitespace)
    // to avoid matching e.g. "not approved" or "should be approved if".
    if (/^\s*approved\s*$/im.test(head)) return "approved";
    return "unknown";
}

export function detectShip(output: string): "shipped" | "paused" {
    const marker = output.match(/SHIP:\s*(SHIPPED|PAUSED)/i);
    if (marker)
        return marker[1].toLowerCase() === "paused" ? "paused" : "shipped";
    // Fallback: only check the first 20 lines to avoid false positives.
    const head = output.split("\n").slice(0, 20).join("\n");
    if (/\bpaused\b/i.test(head) || /\bno\b[^.\n]{0,16}\bremote\b/i.test(head))
        return "paused";
    return "shipped";
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
    let s = picked.join(" ").trim() || text.trim().slice(0, maxLen);
    s = s.replace(/\s+/g, " ");
    return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * Best-effort "N passed / M failed" signal from a tester report.
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

    // Structured patterns — model/provider followed by an error keyword,
    // with optional quoted model name in between.
    if (
        /(?:model|provider)\s*[""''"']?\s*[^\n]{0,80}?(?:not\s+found|unknown|invalid|unavailable|does\s+not\s+exist|is\s+not\s+supported|no\s+such|not\s+supported|cannot\s+be\s+found)/.test(
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

    // Broad proximity catch-all: "model" and an error keyword within 120 chars.
    // This is the safety net for any format we haven't anticipated.
    const modelIdx = combined.indexOf("model");
    if (modelIdx >= 0) {
        const window = combined.slice(
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

export function outcomeLine(status: string, passes: number): string {
    switch (status) {
        case "shipped":
            return "SHIPPED — the validator approved the change and opened a draft pull request.";
        case "paused-no-remote":
            return "PAUSED — no GitHub remote. The work is committed on a local feature branch; add a remote and re-run validation to open the PR.";
        case "failed-after-retries":
            return `FAILED — the change did not pass validation after ${passes} attempt(s).`;
        case "needs-review":
            return "NEEDS REVIEW — the validator did not return a clear PASS/FAIL/PAUSED verdict; check the validation section.";
        default:
            return status.toUpperCase();
    }
}
