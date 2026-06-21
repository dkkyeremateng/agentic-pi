import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "http";
import {
    configuredToken,
    presentedToken,
    tokensMatch,
    isAuthorized,
} from "./obs-auth";

const q = (s = "") => new URLSearchParams(s);

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
