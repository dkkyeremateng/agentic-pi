import { test } from "node:test";
import assert from "node:assert/strict";
import { hostAllowed, isPrivateIp, notifyAllowlist } from "./obs-ssrf";

test("isPrivateIp flags loopback / private / link-local / metadata (IPv4)", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
        assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
    }
});

test("isPrivateIp allows routable public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "192.169.0.1"]) {
        assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
    }
});

test("isPrivateIp handles IPv6 loopback / ULA / link-local / mapped", () => {
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("::"), true);
    assert.equal(isPrivateIp("fc00::1"), true);
    assert.equal(isPrivateIp("fd12:3456::1"), true);
    assert.equal(isPrivateIp("fe80::1"), true);
    assert.equal(isPrivateIp("ff02::1"), true);
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true); // mapped loopback (dotted)
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false); // mapped public (dotted)
    assert.equal(isPrivateIp("2606:4700:4700::1111"), false); // public
    assert.equal(isPrivateIp("[::1]"), true); // bracketed
});

test("isPrivateIp catches the HEX mapped-IPv6 forms new URL() emits (regression)", () => {
    // new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"
    assert.equal(isPrivateIp("::ffff:7f00:1"), true); // 127.0.0.1
    assert.equal(isPrivateIp("::ffff:a9fe:a9fe"), true); // 169.254.169.254 (metadata)
    assert.equal(isPrivateIp("::ffff:a00:1"), true); // 10.0.0.1
    assert.equal(isPrivateIp("::ffff:c0a8:101"), true); // 192.168.1.1
    assert.equal(isPrivateIp("::ffff:808:808"), false); // 8.8.8.8 (public)
});

test("isPrivateIp treats empty/garbage as private (fail closed)", () => {
    assert.equal(isPrivateIp(""), true);
    assert.equal(isPrivateIp("not-an-ip"), true);
    assert.equal(isPrivateIp("999.1.1.1"), true);
});

test("notifyAllowlist parses comma/space lists, null when unset", () => {
    assert.equal(notifyAllowlist({}), null);
    assert.deepEqual(notifyAllowlist({ PI_OBS_NOTIFY_HOSTS: "hooks.slack.com, example.com" }), ["hooks.slack.com", "example.com"]);
    assert.deepEqual(notifyAllowlist({ PI_OBS_NOTIFY_HOSTS: "A.com  B.com" }), ["a.com", "b.com"]);
});

test("hostAllowed is exact + case-insensitive", () => {
    assert.equal(hostAllowed("Example.com", ["example.com"]), true);
    assert.equal(hostAllowed("evil.com", ["example.com"]), false);
    assert.equal(hostAllowed("sub.example.com", ["example.com"]), false);
});
