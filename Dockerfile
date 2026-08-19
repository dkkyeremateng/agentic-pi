# Observability server image — serves the dashboard + /api only.
#
# The dashboard is the React app in obs/ui. Its build (obs/ui/dist) is a derived
# artifact and is NOT in the repo, so stage 1 builds it and stage 2 copies only
# the output — none of the React toolchain reaches the runtime image.

# ── stage 1: build the dashboard ─────────────────────────────────────────────
# Kept at the same path as the repo layout (/app/obs/ui): vite.config.ts resolves
# the repo root as ../../ to read the .env. None is copied here, so the build
# takes its defaults — base /app/, same-origin /api, and no baked-in token, which
# is exactly right for a container serving its own UI.
FROM node:20-slim AS ui-build
WORKDIR /app
# obs/ui is an npm WORKSPACE: the root manifest and lockfile own its dependency
# tree, so the install runs from the root and there is no obs/ui lockfile to copy.
# Manifests first (both of them) so the install layer caches on dependency
# changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY obs/ui/package.json obs/ui/package.json
RUN npm ci
COPY obs/ui/ ./obs/ui/
RUN npm run build --workspace obs/ui

# ── stage 2: the server ──────────────────────────────────────────────────────
# Plain Node + tsx, no native deps, so a single slim stage suffices.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. tsx (a devDependency) runs the TS server
# directly, so we keep dev deps; there are no runtime/native packages to build.
# --workspaces=false: the server needs only the ROOT dependencies. The obs/ui
# workspace is built in stage 1 and arrives here as static files, so installing
# its React toolchain into the runtime image would be pure weight.
COPY package.json package-lock.json ./
RUN npm ci --workspaces=false && npm cache clean --force

# Only what the server needs at runtime: the obs sources, the one util module
# they import, and tsconfig. (.dockerignore keeps everything else out.)
COPY tsconfig.json ./
COPY utils ./utils
COPY obs ./obs

# obs/ui's sources came along with obs/ — drop them and keep only the built
# dashboard from stage 1, which is what obs-server actually serves.
RUN rm -rf obs/ui
COPY --from=ui-build /app/obs/ui/dist ./obs/ui/dist

# 0.0.0.0 so a published port can reach it (a loopback bind inside a container is
# unreachable). Gate it with PI_OBS_TOKEN — see DOCKER.md. The sink defaults to a
# mountable path; mount the host's event sink there (see docker-compose.yml).
ENV PI_OBS_HOST=0.0.0.0 \
    PI_OBS_PORT=7616 \
    PI_OBS_SINK=/data/obs/events.jsonl

EXPOSE 7616

# Tail target is a bind-mounted host directory; create it so a fresh run doesn't
# fail before the mount, and hand ownership to the unprivileged node user.
RUN mkdir -p /data/obs && chown -R node:node /data
USER node

# The static dashboard shell ("/") is always 200 (never auth-gated), so it is a
# safe liveness probe even when PI_OBS_TOKEN is set.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PI_OBS_PORT||7616)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "obs/obs-server.ts"]
