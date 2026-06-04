# pi-config

Personal configuration for [**pi**](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) —
extensions, agents, and skills that turn pi into a multi-agent workflow system.
The folder is **relocatable**: copy it anywhere, on any machine, and run it with
only `.env` config (no code edits).

## What's in here

| Path | What it is |
|------|-----------|
| `extensions/` | pi extensions. `agent-pipeline.ts` / `agent-team.ts` run a self-healing **plan → critic → implement → test → validate → document → ship** workflow; `dispatch.ts` is a standalone extension owning the `dispatch_agent` / `dispatch_parallel` / `select_agents` tools (used by any agent, in any session). See [`extensions/README.md`](extensions/README.md). |
| `agents/` | Agent definitions (`.md` with frontmatter): `scout`, `planner`, `critic`, `implementer`, `tester`, `validator`, `documenter`, `shipper`, plus `coordinator` (dispatches specialists), `seeker` (browser/web), `linear` (issue tracking), and `atlassian` (Jira tickets). |
| `skills/` | On-demand skills. `linear/` — a stdlib-Python CLI for the [Linear GraphQL API](https://linear.app/developers/graphql); `atlassian/` — a stdlib-Python CLI for the [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) (tickets); `bowser/` — Playwright browser automation. |
| `utils/` | Shared, testable orchestration core (`workflow-core.ts`, `orchestrator-core.ts`) — kept out of `extensions/` so pi doesn't load them as extensions. |
| `prompts/`, `themes/` | Orchestrator system-prompt template and color themes. |
| `scripts/`, `run.sh` | Launcher + the dev type-linking helper. |

## Run it

```bash
cp example.env .env          # then fill in your models / API keys
./run.sh                     # agent-pipeline owns the dashboard
./run.sh team                # agent-team (per-agent models) owns it instead
```

`run.sh` loads `dispatch.ts` + both workflows resolved relative to itself, so you
never edit pi's global settings per machine. The only requirement is `pi` on PATH.
Then, in pi: `/agent-pipeline <request>` or `/agent-team <request>`, or just ask the
primary agent to dispatch work. Full usage and the dashboard/report details are in
[`extensions/README.md`](extensions/README.md).

The issue-tracker CLIs are separate optional installs (each reads its keys from `.env`):

```bash
bash skills/linear/install.sh      # `linear` on PATH (LINEAR_API_KEY)
linear issues --assignee me --active

bash skills/atlassian/install.sh   # `atlassian` on PATH (ATLASSIAN_SITE/EMAIL/API_TOKEN)
atlassian tickets                  # your Jira tickets
```

## Configure

All settings live in `.env` at the folder root (loaded as the global config — no
whitelist, so everything works there). See [`example.env`](example.env) for the full
list. Highlights:

- `PI_WORKFLOW_MODEL`, `PI_AGENT_<NAME>_MODEL` — models (global + per-agent).
- `PI_DISPATCH_MAX_DEPTH` — how deep dispatch may nest (default 1 = single level;
  a cycle guard is always on). `PI_MAX_DISPATCHES_PER_TURN` — breadth cap.
- `LINEAR_API_KEY` — for the linear skill.
- `ATLASSIAN_SITE` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` — for the atlassian (Jira) skill.

## Develop

`pi` isn't a node dependency of this repo, so type-checking/tests link the
globally-installed pi (the exact version you run) into `node_modules`:

```bash
npm run setup:types     # link pi types (auto-runs before typecheck/test)
npm run typecheck       # tsc --noEmit
npm test                # unit tests (tsx) — utils/*.test.ts
npm run test:linear     # Python tests for the linear skill
npm run test:atlassian  # Python tests for the atlassian skill
```

`node_modules` is dev-only and gitignored — it is **not** needed to run.

## Portability

Everything resolves relative to itself (extensions find `agents/`/`utils/` next to
them; `loadDotEnv` finds this folder's `.env` from its own path; scripts self-resolve),
so moving the folder needs no code changes — just `.env` + `./run.sh`. Details in
[`extensions/README.md` → Portability](extensions/README.md#portability--moving-the-folder).
