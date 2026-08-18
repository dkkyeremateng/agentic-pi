// config.ts — where this dashboard finds its obs-server.
//
// pi-obs is a standalone static app: ONE build can point at ANY pi agent's
// obs-server. The API base resolves with this precedence (first non-empty wins):
//   1. ?api=<url> in the page URL — persisted to localStorage, then stripped
//      from the address bar. A shareable "open the dashboard against agent X"
//      link; `?api=` (empty) resets to the default.
//   2. localStorage "pi_obs_api_base" — set by (1) or setApiBase().
//   3. build-time VITE_API_BASE — bake a default target into a deploy.
//   4. "/api" — same-origin default: the Vite dev proxy (see vite.config.ts) or
//      obs-server serving the built app under its own origin.
//
// A value may be ABSOLUTE (https://agent.ts.net/api — cross-origin, so the
// server needs permissive CORS + a token) or ROOT-RELATIVE (/api). Trailing
// slashes are trimmed. Everything downstream builds URLs via apiUrl().

const LS_KEY = "pi_obs_api_base";
const DEFAULT_BASE = "/api";

/** Canonical form of a base URL: trimmed, no trailing slash. Pure. */
export function normalizeBase(raw: string | undefined | null): string {
  const s = (raw || "").trim();
  return s ? s.replace(/\/+$/, "") : "";
}

/** Resolve the API base from the override sources + default. Pure — the impure
 *  reads (URL param / localStorage / import.meta.env) are done by the caller. */
export function resolveApiBase(sources: { param?: string | null; stored?: string | null; build?: string | null }): string {
  return normalizeBase(sources.param) || normalizeBase(sources.stored) || normalizeBase(sources.build) || DEFAULT_BASE;
}

// ── impure reads (guarded so the module is import-safe in Node/tests) ──────────

// Read ?api=, persist it (or clear on empty), and strip it from the address bar
// so a refresh keeps the target but the URL stays clean.
function readParam(): string | null {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("api")) return null;
    const p = normalizeBase(u.searchParams.get("api"));
    if (p) localStorage.setItem(LS_KEY, p);
    else localStorage.removeItem(LS_KEY);
    u.searchParams.delete("api");
    window.history.replaceState(null, "", u.toString());
    return p || null;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function readBuild(): string | null {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE ?? null;
  } catch {
    return null;
  }
}

/** The obs-server API base for this session — resolved once at load. */
export const API_BASE = resolveApiBase({ param: readParam(), stored: readStored(), build: readBuild() });

/** Build a full URL for an API path like "/runs" or "/stream?run=x". */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** True when the dashboard talks to a different origin than it was served from
 *  (so a token is likely required and the server needs permissive CORS). */
export function isCrossOrigin(): boolean {
  try {
    if (!/^https?:\/\//i.test(API_BASE)) return false; // relative → same origin
    return new URL(API_BASE).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** Point the dashboard at a different obs-server (settings UI). Persists + reloads. */
export function setApiBase(url: string): void {
  try {
    const b = normalizeBase(url);
    if (b) localStorage.setItem(LS_KEY, b);
    else localStorage.removeItem(LS_KEY);
    window.location.reload();
  } catch {
    /* ignore */
  }
}

/** Reset to the build/default target (settings UI). Persists + reloads. */
export function clearApiBase(): void {
  setApiBase("");
}
