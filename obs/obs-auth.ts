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

// Convenience: is this request authorized for the given configured token?
export function isAuthorized(
    expected: string,
    headers: IncomingHttpHeaders,
    query: URLSearchParams,
): boolean {
    return tokensMatch(expected, presentedToken(headers, query));
}
