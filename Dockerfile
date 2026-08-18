# Observability server image — serves the bundled dashboard + /api only.
# The dashboard is the React app in obs/ui, copied in as its committed build
# (obs/ui/dist) — .dockerignore keeps its src/ and node_modules out, so no
# bundler stage is needed. The server is plain Node + tsx with no native deps,
# so a single slim stage suffices.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. tsx (a devDependency) runs the TS server
# directly, so we keep dev deps; there are no runtime/native packages to build.
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

# Only what the server needs at runtime: the obs sources, the one util module
# they import, and tsconfig. (.dockerignore keeps everything else out.)
COPY tsconfig.json ./
COPY utils ./utils
COPY obs ./obs

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
