// ABOUTME: SSRF guards for the obs server's outbound webhook (/api/notify). Pure,
// ABOUTME: dependency-free predicates over IPs/hostnames so they can be unit-tested;
// ABOUTME: the DNS resolution + fetch live in obs-server, which calls these.

/** True if an IPv4/IPv6 literal is loopback, private, link-local, unique-local,
 *  multicast, or otherwise not a routable public address — i.e. an SSRF target we
 *  must never let /api/notify reach (cloud metadata 169.254.169.254, other local
 *  services, internal hosts). Conservative: unknown/unparseable ⇒ treated private. */
export function isPrivateIp(ip: string): boolean {
    const addr = (ip || "").trim().toLowerCase();
    if (!addr) return true;

    // IPv4-mapped / -embedded IPv6 (::ffff:1.2.3.4, ::1.2.3.4) — judge the v4 part.
    const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);

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
    const a = addr.replace(/^\[|\]$/g, "");
    if (a === "::1" || a === "::") return true; // loopback / unspecified
    const head = a.split(":")[0] || "";
    const h = parseInt(head || "0", 16);
    if (Number.isNaN(h)) return true;
    if ((h & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
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
