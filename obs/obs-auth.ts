// ABOUTME: Shared-secret auth for the obs server. A single token (PI_OBS_TOKEN)
// ABOUTME: gates the data + control API; unset means auth is disabled (open), so
// ABOUTME: existing loopback/Tailscale setups keep working unchanged.

import { createHash, timingSafeEqual } from "crypto";
import type { IncomingHttpHeaders } from "http";

// The configured shared secret. Empty/unset => auth disabled (the server stays
// open, matching the pre-auth loopback default). Read once at startup and also
// per-call in tests via the optional env arg.
export function configuredToken(env: NodeJS.ProcessEnv = process.env): string {
    return (env.PI_OBS_TOKEN || "").trim();
}

// Pull the presented token from a request. Two transports, because the live
// views use EventSource — which cannot set request headers — so a `?token=`
// query param is the only way to authenticate an SSE stream from the browser:
//   1. `Authorization: Bearer <token>`  (fetch / curl / external clients)
//   2. `?token=<token>` query parameter  (EventSource / SSE)
// The header wins when both are present.
export function presentedToken(
    headers: IncomingHttpHeaders,
    query: URLSearchParams,
): string {
    const auth = headers.authorization;
    const raw = Array.isArray(auth) ? auth[0] : auth;
    if (raw) {
        const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
        if (m) return m[1].trim();
    }
    return (query.get("token") || "").trim();
}

// Hash to a fixed 32-byte digest so timingSafeEqual (which requires equal-length
// buffers) never throws and never leaks the secret's length via an early return.
function digest(s: string): Buffer {
    return createHash("sha256").update(s, "utf8").digest();
}

// Constant-time token check. When no token is configured, every request is
// allowed (auth disabled). Otherwise a non-empty presented token must match the
// configured one byte-for-byte.
export function tokensMatch(expected: string, presented: string): boolean {
    if (!expected) return true; // auth disabled
    if (!presented) return false;
    return timingSafeEqual(digest(expected), digest(presented));
}

// True for the loopback binds that are safe to run without a token (only local
// processes can reach them). Everything else ("0.0.0.0", "::", a LAN IP, a
// hostname) is reachable off-box and must carry a token.
export function isLoopbackHost(host: string): boolean {
    const h = (host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
    // Match the 127.0.0.0/8 loopback block by IP shape only — NOT a `127.` prefix,
    // which would wrongly treat a DNS name like "127.example.com" as loopback.
    return h === "::1" || h === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// Fail-closed bind check: refuse to expose the API off-box without auth. Returns
// a human-readable reason to abort, or null when the bind is allowed. A non-
// loopback bind with no token is blocked unless the operator explicitly opts in
// with PI_OBS_ALLOW_INSECURE=1 (documented, for trusted private networks).
export function insecureBindReason(
    host: string,
    token: string,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    if (isLoopbackHost(host)) return null;
    if (token) return null;
    if (env.PI_OBS_ALLOW_INSECURE === "1" || env.PI_OBS_ALLOW_INSECURE === "true") return null;
    return (
        `refusing to bind ${host} without PI_OBS_TOKEN — the API (including control ` +
        `routes that steer live agents and dispatch agents) would be open to the ` +
        `network. Set PI_OBS_TOKEN, bind loopback (PI_OBS_HOST=127.0.0.1), or set ` +
        `PI_OBS_ALLOW_INSECURE=1 to override on a trusted private network.`
    );
}

// Convenience: is this request authorized for the given configured token?
export function isAuthorized(
    expected: string,
    headers: IncomingHttpHeaders,
    query: URLSearchParams,
): boolean {
    return tokensMatch(expected, presentedToken(headers, query));
}

// Operator allowlist of extra browser origins (PI_OBS_ALLOWED_ORIGINS, a comma
// list of full origins like "https://dash.example") permitted to drive the API
// cross-origin in the open (no-token) mode.
export function allowedOriginSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
    return new Set(
        (env.PI_OBS_ALLOWED_ORIGINS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

// Cross-origin drive-by guard. A CORS `*` policy governs only whether a page may
// READ a response — it never stops the request from REACHING the server, so a
// malicious page a user visits could still drive side-effecting routes on
// 127.0.0.1. The browser stamps a truthful `Origin` on cross-site requests, so we
// only allow ones that are same-origin (Origin host == the request's Host),
// loopback (a remote attacker can never present a loopback Origin), or in the
// operator allowlist. No Origin at all ⇒ a non-browser client (curl, the CLI, a
// server-side proxy) ⇒ allowed. Used only in open mode; a configured token
// already blocks a blind drive-by (it can't read the secret).
export function originAllowed(
    headers: IncomingHttpHeaders,
    allowed: Set<string>,
): boolean {
    const raw = headers.origin;
    const origin = Array.isArray(raw) ? raw[0] : raw;
    if (!origin) return true; // no Origin ⇒ not a cross-site browser request
    if (origin === "null") return false; // opaque origin (file://, sandboxed iframe)
    let u: URL;
    try {
        u = new URL(origin);
    } catch {
        return false;
    }
    if (isLoopbackHost(u.hostname)) return true;
    const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
    if (host && u.host === host) return true; // same-origin as the request target
    return allowed.has(origin);
}
