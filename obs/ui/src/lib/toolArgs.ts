// Turn a tool event payload into a human-readable one-liner: the tool name +
// its salient argument (bash → command, read/edit → file path, web_fetch →
// url, …), tolerating the several shapes the collector emits (args object,
// argsText JSON string, or a flat `arg` preview).

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function extractArgs(p: Record<string, unknown>): Record<string, unknown> {
  if (p.args && typeof p.args === "object") return p.args as Record<string, unknown>;
  const at = p.argsText;
  if (typeof at === "string") {
    try {
      const o = JSON.parse(at);
      if (o && typeof o === "object") return o as Record<string, unknown>;
    } catch {
      /* not JSON — fall through */
    }
  } else if (at && typeof at === "object") {
    return at as Record<string, unknown>;
  }
  return {};
}

// Priority order of argument keys to surface as the summary.
const SALIENT = ["command", "cmd", "file_path", "filePath", "path", "url", "pattern", "query", "prompt", "task"];

const MAX = 600;
function clamp(t: string): string {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > MAX ? one.slice(0, MAX - 1) + "…" : one;
}

export function summarizeToolArgs(payload: Record<string, unknown> | undefined): { tool: string; text: string } {
  const p = payload ?? {};
  const tool = s(p.toolName) || s(p.tool) || s(p.name) || "tool";
  const args = extractArgs(p);

  // salient key from the structured args, else the same key at payload top-level
  // (the collector sometimes flattens e.g. `command` onto the event payload).
  for (const k of SALIENT) {
    const fromArgs = args[k];
    if (typeof fromArgs === "string" && fromArgs) return { tool, text: clamp(fromArgs) };
    const fromTop = p[k];
    if (typeof fromTop === "string" && fromTop) return { tool, text: clamp(fromTop) };
  }
  // edit-style tools: the file is the salient part, not the diff text
  if (typeof args.old_string === "string" && typeof args.file_path === "string") {
    return { tool, text: clamp(args.file_path) };
  }
  // generic: a short "key: value" join of scalar args
  const parts = Object.entries(args)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}: ${v}`);
  if (parts.length) return { tool, text: clamp(parts.join(" · ")) };

  // last resort: the collector's flat preview string
  return { tool, text: clamp(s(p.arg)) || tool };
}

// ── result summary (tool_end) ──

function textField(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
    return (c as { text: string }).text;
  }
  return "";
}

/** Extract `result.content[].text` (the MCP result shape) — tolerating a JSON
 *  string, a content array, a single content object, or a content string.
 *  Returns "" when there's no structured content text. */
function contentTextOf(raw: unknown): string {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return "";
    try {
      obj = JSON.parse(t);
    } catch {
      return "";
    }
  }
  if (!obj || typeof obj !== "object") return "";
  const content = (obj as Record<string, unknown>).content;
  if (Array.isArray(content)) return content.map(textField).filter(Boolean).join("\n");
  return textField(content);
}

/** A plain-text result (stdout / a `{text}` wrapper) — but not raw JSON. */
function plainTextOf(raw: unknown): string {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.startsWith("{") || t.startsWith("[") ? "" : t;
  }
  if (raw && typeof raw === "object") return textField(raw);
  return "";
}

const MAX_LINES = 8;
const MAX_RESULT = 600;
function clampResult(t: string): string {
  const trimmed = t.trim();
  const all = trimmed.split("\n");
  let out = all.slice(0, MAX_LINES).join("\n");
  if (out.length > MAX_RESULT) out = out.slice(0, MAX_RESULT - 1) + "…";
  else if (all.length > MAX_LINES) out += "\n…";
  return out;
}

/** A human-readable summary of a tool_end result for the I/O Output block.
 *  Prefers the structured `result.content[].text`, then an explicit summary,
 *  then any plain stdout/text. */
export function summarizeToolResult(payload: Record<string, unknown> | undefined): string {
  const p = payload ?? {};
  for (const raw of [p.result, p.resultText]) {
    const t = contentTextOf(raw);
    if (t) return clampResult(t);
  }
  if (typeof p.summary === "string" && p.summary) return clampResult(p.summary);
  for (const raw of [p.result, p.resultText, p.output, p.stdout, p.text]) {
    const t = plainTextOf(raw);
    if (t) return clampResult(t);
  }
  return "";
}
