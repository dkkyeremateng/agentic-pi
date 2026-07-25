import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "http";
import {
    configuredToken,
    presentedToken,
    tokensMatch,
    isAuthorized,
    isLoopbackHost,
    insecureBindReason,
    allowedOriginSet,
    originAllowed,
} from "./obs-auth";

const q = (s = "") => new URLSearchParams(s);

test("isLoopbackHost recognizes loopback binds only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "LOCALHOST", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
    // a DNS name starting "127." must NOT be treated as loopback (was a bypass)
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", "127.example.com", "127evil.com"]) assert.equal(isLoopbackHost(h), false, h);
});

test("insecureBindReason: loopback or token ⇒ allowed; non-loopback + no token ⇒ blocked", () => {
    assert.equal(insecureBindReason("127.0.0.1", "", {}), null); // loopback, no token: fine
    assert.equal(insecureBindReason("0.0.0.0", "secret", {}), null); // non-loopback but token set: fine
    assert.match(insecureBindReason("0.0.0.0", "", {})!, /refusing to bind/); // blocked
    assert.match(insecureBindReason("192.168.1.5", "", {})!, /PI_OBS_TOKEN/);
    // explicit opt-in overrides
    assert.equal(insecureBindReason("0.0.0.0", "", { PI_OBS_ALLOW_INSECURE: "1" }), null);
});

test("configuredToken reads + trims PI_OBS_TOKEN, empty when unset", () => {
    assert.equal(configuredToken({} as NodeJS.ProcessEnv), "");
    assert.equal(
        configuredToken({ PI_OBS_TOKEN: "  s3cret  " } as NodeJS.ProcessEnv),
        "s3cret",
    );
});

test("presentedToken parses an Authorization: Bearer header", () => {
    const h: IncomingHttpHeaders = { authorization: "Bearer abc123" };
    assert.equal(presentedToken(h, q()), "abc123");
    // case-insensitive scheme + surrounding whitespace
    assert.equal(presentedToken({ authorization: "  bearer  xy " }, q()), "xy");
});

test("presentedToken falls back to the ?token= query for EventSource", () => {
    assert.equal(presentedToken({}, q("token=fromquery")), "fromquery");
});

test("presentedToken prefers the header over the query", () => {
    const h: IncomingHttpHeaders = { authorization: "Bearer hdr" };
    assert.equal(presentedToken(h, q("token=qry")), "hdr");
});

test("presentedToken is empty when neither is present", () => {
    assert.equal(presentedToken({}, q()), "");
    // a non-Bearer Authorization header is ignored
    assert.equal(presentedToken({ authorization: "Basic xyz" }, q()), "");
});

test("tokensMatch: no configured token means auth is disabled (open)", () => {
    assert.equal(tokensMatch("", ""), true);
    assert.equal(tokensMatch("", "anything"), true);
});

test("tokensMatch: configured token requires an exact match", () => {
    assert.equal(tokensMatch("secret", "secret"), true);
    assert.equal(tokensMatch("secret", "wrong"), false);
    assert.equal(tokensMatch("secret", ""), false);
    // different lengths must not throw (sha256 digest is fixed-length)
    assert.equal(tokensMatch("short", "a-much-longer-presented-token"), false);
});

test("isAuthorized wires header/query extraction to the match", () => {
    const expected = "tok";
    assert.equal(isAuthorized(expected, { authorization: "Bearer tok" }, q()), true);
    assert.equal(isAuthorized(expected, {}, q("token=tok")), true);
    assert.equal(isAuthorized(expected, {}, q("token=nope")), false);
    assert.equal(isAuthorized(expected, {}, q()), false);
    // open server: any request authorizes
    assert.equal(isAuthorized("", {}, q()), true);
});

test("allowedOriginSet parses the comma list, ignoring blanks", () => {
    assert.deepEqual(
        [...allowedOriginSet({ PI_OBS_ALLOWED_ORIGINS: "https://a.example, https://b.example ,, " } as NodeJS.ProcessEnv)],
        ["https://a.example", "https://b.example"],
    );
    assert.equal(allowedOriginSet({} as NodeJS.ProcessEnv).size, 0);
});

test("originAllowed blocks cross-site drive-by, allows same-origin/loopback/allowlist", () => {
    const none = new Set<string>();
    const host = "127.0.0.1:7616";
    // no Origin ⇒ non-browser client (curl/CLI/proxy) ⇒ allowed
    assert.equal(originAllowed({ host }, none), true);
    // a malicious site the user visits ⇒ blocked (this is the drive-by vector)
    assert.equal(originAllowed({ host, origin: "https://evil.example" }, none), false);
    // same-origin as the request target ⇒ allowed (the bundled dashboard)
    assert.equal(originAllowed({ host, origin: "http://127.0.0.1:7616" }, none), true);
    // any loopback origin ⇒ allowed (local dev tooling on another port; a remote
    // attacker can never present a loopback Origin — the browser sets it)
    assert.equal(originAllowed({ host, origin: "http://localhost:5174" }, none), true);
    assert.equal(originAllowed({ host, origin: "http://127.0.0.1:5173" }, none), true);
    // an opaque origin (file://, sandboxed iframe) ⇒ blocked
    assert.equal(originAllowed({ host, origin: "null" }, none), false);
    // a garbage Origin header ⇒ blocked
    assert.equal(originAllowed({ host, origin: "!!!not-a-url" }, none), false);
    // operator allowlist ⇒ that exact origin is allowed, others still blocked
    const allow = new Set(["https://dash.example"]);
    assert.equal(originAllowed({ host, origin: "https://dash.example" }, allow), true);
    assert.equal(originAllowed({ host, origin: "https://other.example" }, allow), false);
});
