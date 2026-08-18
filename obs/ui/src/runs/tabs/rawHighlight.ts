// Tiny JSON syntax highlighter for the Raw events tab. Pretty-prints a value and
// wraps tokens in <span class="j-*"> so CSS can colour keys/strings/numbers/etc.
// The input is HTML-escaped first, so the output is safe to inject.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c]);
}

// A quoted string (optionally a key when followed by a colon), a literal
// (true/false/null), or a number. Strings are matched first so digits/keywords
// inside them are never re-tokenised.
const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap occurrences of `term` in <mark>, but only in the text between tags — never
// inside the <span> tags the syntax highlighter emits. The term is HTML-escaped
// so it matches the already-escaped content.
export function markTerm(html: string, term: string): string {
  const t = term.trim();
  if (!t) return html;
  const re = new RegExp(escapeRegExp(esc(t)), "gi");
  return html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith("<") ? part : part.replace(re, (m) => `<mark>${m}</mark>`)))
    .join("");
}

export function highlightJson(value: unknown): string {
  const json = esc(JSON.stringify(value, null, 2) ?? "");
  return json.replace(TOKEN, (_m, str, colon, lit, num) => {
    if (str != null)
      return colon != null
        ? `<span class="j-key">${str}</span>${colon}`
        : `<span class="j-str">${str}</span>`;
    if (lit != null)
      return `<span class="${lit === "null" ? "j-null" : "j-bool"}">${lit}</span>`;
    if (num != null) return `<span class="j-num">${num}</span>`;
    return _m;
  });
}
