/// <reference types="vite/client" />

// Client-visible (VITE_-prefixed) config. Only these reach browser code; other
// vars (PI_OBS_URL, VITE_HOST, VITE_PORT, VITE_BASE) are build/dev-server config.
// All of it is read from the REPO-ROOT .env — this package has none of its own —
// and documented in the repo-root example.env.
interface ImportMetaEnv {
  /** Obs-server API base baked into the build (e.g. https://agent.ts.net/api).
   *  Overridden at runtime by ?api= / localStorage. Default "/api". See config.ts. */
  readonly VITE_API_BASE?: string;
  /** Obs-server shared secret, exposed to the client so it auto-authenticates.
   *  Overridden at runtime by the TokenGate (localStorage). See data/auth.ts. */
  readonly VITE_PI_OBS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
