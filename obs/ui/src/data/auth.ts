// Client-side token handling for the obs server's shared-secret auth.
// The server gates every /api route when PI_OBS_TOKEN is set; here we attach the
// token as an Authorization header on fetch and as a ?token= query on SSE
// (EventSource can't set headers). Token source, in order: localStorage (set
// via the 401 prompt — beats a stale build-time value), else a build-time
// VITE_PI_OBS_TOKEN. Empty when the server is open, in which case these
// helpers are no-ops.

const KEY = "pi_obs_token";

export function obsToken(): string {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.VITE_PI_OBS_TOKEN;
    return (localStorage.getItem(KEY) || fromEnv || "").trim();
  } catch {
    return "";
  }
}

export function setObsToken(token: string): void {
  try {
    localStorage.setItem(KEY, token.trim());
  } catch {
    /* ignore unavailable storage */
  }
}

/** Authorization header for fetch, or {} when no token is configured. */
export function authHeaders(): Record<string, string> {
  const t = obsToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** Append ?token= (or &token=) for EventSource URLs that can't send headers. */
export function withToken(url: string): string {
  const t = obsToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

// Request a token from the user. Rather than the unstyleable native prompt(),
// fire an event the in-app <TokenGate> modal listens for. Guarded so a burst of
// parallel 401s opens the gate once, not once per request.
export const TOKEN_REQUIRED_EVENT = "pi-obs:token-required";
let prompting = false;
export function promptForToken(): void {
  if (prompting || typeof window === "undefined") return;
  prompting = true;
  window.dispatchEvent(new CustomEvent(TOKEN_REQUIRED_EVENT));
}

// Resolve an open token prompt: a non-empty token is stored and the page is
// reloaded so every fetcher/EventSource retries with it; null re-arms the gate
// so a later 401 can prompt again.
export function resolveTokenPrompt(token: string | null): void {
  const t = (token || "").trim();
  if (t) {
    setObsToken(t);
    if (typeof window !== "undefined") window.location.reload();
  } else {
    prompting = false;
  }
}
