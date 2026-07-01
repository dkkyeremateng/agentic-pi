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
