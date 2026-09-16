// ABOUTME: Repairs a `grep` pattern whose parentheses do not balance, so the
// search runs instead of dying in the regex parser.
//
// Why this exists. pi wraps a grep pattern in a non-capturing group before
// handing it to ripgrep, so an unbalanced paren is not merely unbalanced, it is
// a parse error — and the error quotes a pattern the agent never wrote:
//
//     pattern sent: func (.*Stop
//     rg reported:  (?:func (.*Stop)   error: unclosed group
//
// Measured over the obs sink, 13 grep calls died this way, every one of them on
// the same two shapes: a Go receiver (`func (.*Stop`, `func (.* Close`) and a
// call site (`Publish(`, `ConfirmDeposit(`). Both are cases where the agent
// meant the paren literally and the surrounding `.*` shows it still wanted a
// regex, so switching the call to a literal search would answer a question
// nobody asked. Escaping exactly the parens that do not pair leaves every
// deliberate group intact and turns each of these into the search that was
// meant.
//
// A wasted grep is not free: a turn costs ~3.2 cents whatever it contains, and
// this one also hands back a pattern the agent must first work out it did not
// write.

/** A pattern longer than this is not worth scanning; well past any real search. */
export const MAX_PATTERN_CHARS = 2_000;

/**
 * Indices of the parentheses in `pattern` that have no partner, in ascending
 * order.
 *
 * Escapes and character classes are skipped, because a paren inside either is
 * already literal: `\(` pairs with nothing by design, and `[()]` is a set, not a
 * group. Treating those as unbalanced would escape a backslash that is already
 * there and change a pattern that works.
 */
export function unbalancedParens(pattern: string): number[] {
    const open: number[] = [];
    const stray: number[] = [];
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") {
            i++; // whatever follows is literal, including a paren
            continue;
        }
        if (inClass) {
            if (c === "]") inClass = false;
            continue;
        }
        if (c === "[") {
            inClass = true;
            continue;
        }
        if (c === "(") open.push(i);
        else if (c === ")") {
            if (open.length) open.pop();
            else stray.push(i);
        }
    }
    return [...open, ...stray].sort((a, b) => a - b);
}

/**
 * `pattern` with its unpaired parentheses escaped, or null when the call should
 * be left exactly as sent.
 *
 * Null in every case where the change would be a guess:
 *
 * - the pattern already compiles -> it is a working regex and whatever it finds
 *   is what the agent asked for. Balanced-but-odd patterns are not our business.
 * - nothing is unbalanced -> the breakage is something else (a bad quantifier, a
 *   stray backreference) and escaping parens would not fix it.
 * - the escaped pattern still does not compile -> the parens were not the only
 *   problem, so rewriting buys a different error rather than a result.
 *
 * Compilation is checked with JavaScript's engine while the search runs under
 * Rust's. The dialects differ at the edges, but not about whether a group is
 * closed, and the asymmetry is the safe way round: JS is the stricter of the two
 * here, so the worst case is declining to fix something ripgrep would have
 * accepted anyway.
 */
export function balanceGroups(pattern: string): string | null {
    if (!pattern || pattern.length > MAX_PATTERN_CHARS) return null;
    if (!pattern.includes("(") && !pattern.includes(")")) return null;
    if (compiles(pattern)) return null;

    const bad = unbalancedParens(pattern);
    if (!bad.length) return null;

    let fixed = pattern;
    // Right to left: an earlier index stays valid only while nothing before it
    // has grown.
    for (let i = bad.length - 1; i >= 0; i--)
        fixed = fixed.slice(0, bad[i]) + "\\" + fixed.slice(bad[i]);

    return compiles(fixed) ? fixed : null;
}

function compiles(pattern: string): boolean {
    try {
        new RegExp(pattern);
        return true;
    } catch {
        return false;
    }
}

/** A one-line audit record of a repaired pattern. */
export function formatBalance(from: string, to: string): string {
    return `grep pattern ${JSON.stringify(from)} -> ${JSON.stringify(to)}`;
}
