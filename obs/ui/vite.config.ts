import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Standalone dashboard for pi agent observability. Everything deployment-specific
// is env-driven so one codebase serves many setups.
//
// Config lives in the REPO-ROOT .env (obs/ui has none of its own) — the dashboard
// is part of the pi repo, and its settings sit beside the obs-server settings they
// pair with (PI_OBS_URL next to PI_OBS_TOKEN/PI_OBS_PORT) instead of in a second
// file that has to be kept in sync. See the repo-root example.env for the full
// list. envDir points Vite's own .env loading at the same place as loadEnv below,
// so `import.meta.env` and this config always agree on the source.
//
// SAFETY: the repo-root .env also holds unrelated secrets (Linear, Atlassian,
// Telegram). Vite only exposes VITE_-prefixed vars to client code, so those never
// reach the bundle — but that cuts both ways: anything you prefix with VITE_ IS
// public. Since obs/ui/dist is committed, a VITE_PI_OBS_TOKEN would be baked into
// a tracked file; the build warns about that (see below).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
//
// PI_OBS_URL — where the dev/preview server proxies /api (the obs-server). A full
// URL OR a bare host (e.g. a Tailscale MagicDNS name): a missing scheme defaults
// to http://, and a missing http port to the obs default 7616. Give an explicit
// scheme/port to override (e.g. https://box.tailnet.ts.net for a `tailscale serve`
// front on 443). Unset → http://127.0.0.1:7616. NOTE: the proxy only matters when
// the app calls a ROOT-RELATIVE API base (/api, the default); if you point the app
// straight at a remote server with VITE_API_BASE=https://…, requests skip the proxy
// (and that server then needs permissive CORS + a token).
function normalizeObsUrl(raw: string | undefined): string {
    const s = (raw || "").trim();
    if (!s) return "http://127.0.0.1:7616";
    const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    if (!u.port && u.protocol === "http:") u.port = "7616";
    return u.origin;
}

// VITE_BASE — public base path the app is served under. Unset → /app/ (obs-server
// mounts it there); set "/" to host the dashboard standalone at an origin root.
// Normalized to a leading+trailing slash. An explicit "/" is kept (only a truly
// unset/blank value falls back to /app/).
function normalizeBasePath(raw: string | undefined): string {
    const s = (raw ?? "").trim();
    if (!s) return "/app/";
    const core = s.replace(/^\/+|\/+$/g, "");
    return core ? `/${core}/` : "/";
}

// VITE_HOST — dev/preview bind address. "true"/"0.0.0.0" listens on all
// interfaces (LAN / Tailscale); an IP/host binds that; unset → localhost.
function normalizeHost(raw: string | undefined): string | boolean | undefined {
    const s = (raw || "").trim();
    if (!s) return undefined;
    return s === "true" ? true : s;
}

export default defineConfig(({ mode, command }) => {
    // Read the repo-root .env, not this package's cwd — see REPO_ROOT above.
    const env = loadEnv(mode, REPO_ROOT, "");
    const OBS = normalizeObsUrl(env.PI_OBS_URL);
    const host = normalizeHost(env.VITE_HOST);
    const proxy = { "/api": { target: OBS, changeOrigin: true } };

    // dist/ is committed, so a token baked in at build time would be committed
    // with it. Harmless in dev (nothing is written); loud on `vite build`.
    if (command === "build" && env.VITE_PI_OBS_TOKEN) {
        console.warn(
            "\n⚠  VITE_PI_OBS_TOKEN is set — the obs token will be EMBEDDED in dist/,\n" +
                "   which is committed to this repo. Unset it and let the in-app TokenGate\n" +
                "   prompt for the token instead, unless you intend to publish it.\n",
        );
    }

    return {
        plugins: [react()],
        envDir: REPO_ROOT,
        base: normalizeBasePath(env.VITE_BASE),
        server: {
            host,
            port: Number(env.VITE_PORT) || 5174,
            proxy,
        },
        preview: {
            host,
            port: Number(env.VITE_PREVIEW_PORT) || 5175,
            proxy,
        },
        build: { outDir: "dist", emptyOutDir: true },
    };
});
