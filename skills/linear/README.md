# Linear Skill — Value Proposition

A token-efficient CLI wrapper around the [Linear GraphQL API](https://linear.app/developers/graphql) for reading and mutating Linear issues directly from the shell. It avoids loading MCP tool schemas into context: every command POSTs one GraphQL operation and prints the GraphQL `data` payload as JSON, ready to pipe to `jq`.

## What the Linear skill is

`linear` (`linear.py`) is a thin, stdlib-only Python client for `https://api.linear.app/graphql`. It wraps the most common workflows — listing and searching issues, reading issue detail, creating issues, commenting, and updating state/assignee/priority — behind short subcommands, while exposing a `raw` escape hatch for any operation the GraphQL schema supports.

## Core capabilities

- **Token-efficient CLI** — no tool schemas in context; JSON in, JSON out.
- **Read** — `me`, `teams`, `states`, `issues` (filter by team/assignee/state/text), `issue <id>`, `search <text>`.
- **Write** — `create`, `comment`, `update` (title, description, state, assignee, priority).
- **Friendly identifiers** — team **keys** (`ENG`) and issue **identifiers** (`ENG-123`) are accepted; team keys are resolved to UUIDs automatically.
- **`me` assignee shortcut** — target the authenticated user without looking up a UUID.
- **Escape hatch** — `raw '<query>' '<variables-json>'` runs any GraphQL operation.

## Authentication

- Personal API key: `export LINEAR_API_KEY=lin_api_xxxx` (or put it in `.env`).
- OAuth token: `export LINEAR_API_KEY="Bearer <access_token>"`.
- The script auto-loads `LINEAR_API_KEY` from `./.env` or the repo-root `.env` when it isn't already exported.

## Typical use cases

- Triage: list issues assigned to you, search the backlog, read full issue detail with comments.
- Reporting: pipe `issues`/`search` JSON into `jq` to build summaries.
- Automation: create issues from CI/scripts, post comments, transition workflow states.
- Ad-hoc queries: reach any part of the schema through `raw`.

## Safety and compliance notes

- Treat `LINEAR_API_KEY` as a secret — keep it in `.env` (git-ignored) or the environment, never in committed code.
- A personal API key carries the full permissions of its owner; scope access with OAuth where appropriate.
- Mutations (`create`, `comment`, `update`) change real workspace data — confirm targets before running them in scripts.

## Quick-start usage snippet

```bash
# one-time: put linear on PATH (resolves the repo .env through the symlink)
bash skills/linear/install.sh
export LINEAR_API_KEY=lin_api_xxxxxxxx

linear me                                   # verify auth
linear teams                                # discover team keys
linear issues --team ENG --assignee me      # your open issues
linear issue ENG-123                        # full detail + comments
linear create --team ENG --title "Fix nav" --assignee me --priority 2
linear comment ENG-123 "Reproduced on staging."
```

See [SKILL.md](SKILL.md) for the full command reference.
