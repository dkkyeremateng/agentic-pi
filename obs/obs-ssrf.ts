// ABOUTME: SSRF guards for the obs server's outbound webhook (/api/notify). Pure,
// ABOUTME: dependency-free predicates over IPs/hostnames so they can be unit-tested;
// ABOUTME: the DNS resolution + fetch live in obs-server, which calls these.

/** True if an IPv4/IPv6 literal is loopback, private, link-local, unique-local,
 *  multicast, or otherwise not a routable public address — i.e. an SSRF target we
 *  must never let /api/notify reach (cloud metadata 169.254.169.254, other local
 *  services, internal hosts). Conservative: unknown/unparseable ⇒ treated private. */
export function isPrivateIp(ip: string): boolean {
    const addr = (ip || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (!addr) return true;
    if (addr.includes(":")) return isPrivateIp6(addr);
    return isPrivateIp4(addr);
}

function isPrivateIp4(addr: string): boolean {
    const parts = addr.split(".");
    if (parts.length !== 4) return true;
    const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
    if (o.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
    if (a >= 224) return true; // multicast + reserved (224+/4, 240+/4, 255.255.255.255)
    return false;
}

function isPrivateIp6(addr: string): boolean {
    const g = expandIp6(addr);
    if (!g) return true; // unparseable → treat as private (fail closed)
    // loopback (::1) and unspecified (::)
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — judge the v4
    // part, so e.g. `::ffff:7f00:1` (what new URL() emits for ::ffff:127.0.0.1)
    // is caught, not just the dotted form.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0) && !(g[5] === 0 && g[6] === 0 && g[7] === 0)) {
        const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
        return isPrivateIp4(v4);
    }
    const h = g[0];
    if ((h & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
}

/** Expand an IPv6 literal (incl. `::` compression and an embedded IPv4 tail) into
 *  its 8 16-bit groups, or null if it doesn't parse. */
function expandIp6(addr: string): number[] | null {
    let a = addr.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (!a) return null;
    // fold an embedded IPv4 tail (::ffff:1.2.3.4) into two hex groups
    const v4 = a.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) {
        const o = v4[2].split(".").map(Number);
        if (o.some((n) => n > 255)) return null;
        a = v4[1] + (((o[0] << 8) | o[1]) >>> 0).toString(16) + ":" + (((o[2] << 8) | o[3]) >>> 0).toString(16);
    }
    const halves = a.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    let groups: string[];
    if (halves.length === 1) {
        groups = head;
    } else {
        const tail = halves[1] ? halves[1].split(":") : [];
        const missing = 8 - head.length - tail.length;
        if (missing < 0) return null;
        groups = [...head, ...Array(missing).fill("0"), ...tail];
    }
    if (groups.length !== 8) return null;
    const nums = groups.map((s) => (/^[0-9a-f]{1,4}$/.test(s) ? parseInt(s, 16) : -1));
    return nums.some((n) => n < 0) ? null : nums;
}

/** Operator allowlist of webhook hostnames (PI_OBS_NOTIFY_HOSTS, comma/space
 *  separated). Returns null when unset (no allowlist configured). */
export function notifyAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | null {
    const raw = (env.PI_OBS_NOTIFY_HOSTS || "").trim();
    if (!raw) return null;
    return raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Host membership in the allowlist (exact, case-insensitive). */
export function hostAllowed(hostname: string, list: string[]): boolean {
    return list.includes((hostname || "").trim().toLowerCase());
}
