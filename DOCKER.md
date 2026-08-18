# Running the observability server in Docker

The image runs **only the obs server** — the dashboard (`/`) and the JSON API
(`/api`). It serves the React dashboard from `obs/ui/dist`, whose build is
committed to the repo, so the image needs no bundler stage.

The server is plain Node + `tsx` with no native dependencies, so the image is a
single slim layer (`node:20-slim`).

## Mental model

The container does **not** run agents. Your pi workflows run wherever they
normally do (the host), appending events to a sink file. The container **tails
that sink** and serves the dashboard/API over it:

```
host: pi run (PI_OBS=1) ──writes──▶ ~/.pi/agent/obs/events.jsonl
                                            │ (bind mount, read-only)
                                            ▼
                      container: obs-server tails it ──▶ http://localhost:7616
```

## Quick start (compose)

```bash
# A token is required whenever the port leaves the host loopback.
export PI_OBS_TOKEN=$(openssl rand -hex 32)
docker compose up --build
```

Open <http://localhost:7616/> and paste the token when prompted (it is cached in
the browser's localStorage). [`docker-compose.yml`](docker-compose.yml) mounts
`~/.pi/agent/obs` read-only and publishes port 7616.

## Quick start (plain docker)

```bash
docker build -t pi-obs-server .

docker run -d --name pi-obs \
  -p 7616:7616 \
  -e PI_OBS_TOKEN="$(openssl rand -hex 32)" \
  -v "$HOME/.pi/agent/obs:/data/obs:ro" \
  pi-obs-server
```

Then send the token as `Authorization: Bearer <token>` (or `?token=` for SSE) —
see [obs/API.md](obs/API.md#authentication).

## Configuration

All via environment variables (same as a non-container run):

| Variable | Default in image | Purpose |
| --- | --- | --- |
| `PI_OBS_HOST` | `0.0.0.0` | Bind address. Must be `0.0.0.0` in a container — a loopback bind is unreachable through a published port. |
| `PI_OBS_PORT` | `7616` | Listen port. |
| `PI_OBS_SINK` | `/data/obs/events.jsonl` | Sink file to tail. Mount the host sink here. |
| `PI_OBS_TOKEN` | _(unset)_ | Shared-secret auth. **Set this** — see below. |

The server prints its `bind` address and `auth` status on startup, and warns if
it is bound beyond loopback with no token.

## Security

Inside a container `PI_OBS_HOST=0.0.0.0` is necessary, which means the server is
reachable by anyone who can reach the published port. So:

- **Always set `PI_OBS_TOKEN`** when publishing the port. Without it the API —
  including the control routes that can steer a live agent — is open.
- Publish to loopback only (`-p 127.0.0.1:7616:7616`) unless you intend wider
  reach, and front it with TLS + identity (Tailscale / a reverse proxy) for
  anything beyond your own machine. See the README's observability section.

## Limitations

- **No agents in the image.** It tails a sink; it does not run pi.
- **LLM / chat / Explain features need the `pi` CLI**, which this image does not
  contain. They are opt-in (`PI_OBS_LLM=1`, chat) and degrade gracefully when
  absent — the core dashboard, history, search, digests, and OTLP export all work
  without them. To enable them, build a derived image that installs `pi` and set
  `PI_OBS_PI_BIN` to its path.
- The sink is mounted **read-only**, so chat persistence / image uploads (which
  write into the sink directory) are disabled — consistent with the no-`pi`
  image. Drop `:ro` only if you also add the `pi` CLI.

## Health

The image defines a `HEALTHCHECK` that probes `/` (the static shell, never
auth-gated), so `docker ps` / orchestrators see real liveness even with a token
set.
