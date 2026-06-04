---
name: linear
description: Query and mutate Linear over its GraphQL API from the shell. Use to list/search issues, read issue detail, create issues, comment, update state/assignee/priority, and inspect teams and workflow states. Keywords - linear, issue, ticket, graphql, team, backlog, assignee, workflow state.
allowed-tools: Bash
---

# Linear GraphQL CLI

## Purpose

Talk to the [Linear GraphQL API](https://linear.app/developers/graphql) (`https://api.linear.app/graphql`) through `linear` — a thin, token-efficient Python client (`linear.py`, stdlib only). No MCP server, no tool schemas in context: every command POSTs a GraphQL operation and prints the `data` payload as JSON to stdout, ready to pipe to `jq`.

## Setup

**1. Put `linear` on PATH** (one-time) so it runs from any directory — the script resolves its own real location through the symlink, so the repo `.env` still loads:

```bash
bash skills/linear/install.sh        # links linear.py -> ~/.local/bin/linear
# or choose a bin dir:  bash skills/linear/install.sh /usr/local/bin
```

The installer resolves its own path, so it works wherever the repo lives. If the bin dir is not on your PATH, call the script by its full path instead.

**2. Set a Personal API key** (Linear → Settings → API → Personal API keys; starts with `lin_api_`):

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxx
# or add `LINEAR_API_KEY=lin_api_xxxxxxxx` to a .env in the working directory
# for an OAuth token instead: export LINEAR_API_KEY="Bearer <access_token>"
```

The script auto-loads `LINEAR_API_KEY` from `./.env`, or from the repo `.env` next to the real script, if it isn't already exported. Requires `python3` (3.8+); no other dependencies.

## Quick Reference

```bash
linear me                                   # current user (viewer)
linear teams                                # id, key, name for each team
linear states --team ENG                    # workflow states for a team
linear projects --limit 20                  # list projects
linear cycles --team ENG                    # a team's cycles
linear issues --assignee me --active            # your OPEN issues (the common one)
linear issues --team ENG --assignee me --limit 10
linear issues --state "In Progress" --query "login bug"
linear issue ENG-123                        # full detail incl. comments
linear search "flaky checkout test" --limit 5
linear create --team ENG --title "Fix nav" --description "..." --assignee me --priority 2
linear comment ENG-123 "Reproduced on staging."
linear update ENG-123 --state <stateId> --priority 1
linear raw 'query{viewer{id name}}'         # arbitrary GraphQL escape hatch
```

The printed JSON is the GraphQL **`data`** object already (the `data` envelope is stripped), so address fields directly — `linear me | jq '.viewer.name'`, not `.data.viewer.name`.

## Notes

- **Finding your work** — use `issues --assignee me` (add `--active` for open only). Don't hand-roll a `raw` query for this. An **empty** result means nothing matched the filter, not that nothing exists — drop filters (e.g. `--active`, `--state`) to confirm. (Heads up: a person can have issues assigned that are all `Done`.)
- **Open vs. by-name** — `--active` filters on the universal state **type** (excludes `completed`/`canceled`), so it works across teams; `--state <NAME>` matches one team-specific state name. They combine.
- **Issue references** — `issue`, `comment`, and `update` accept either a UUID or the human identifier (`ENG-123`). `--team` accepts a team **key** (`ENG`) or UUID; keys are resolved to UUIDs automatically.
- **Assignee** — pass `me` to target the authenticated user, or a user UUID.
- **Priority** — `0` none, `1` urgent, `2` high, `3` normal, `4` low.
- **State changes** — `update --state` needs a workflow-state **UUID**; get it from `states --team <KEY>`.
- **Output** — everything is JSON (the `data` object). Reshape with `jq`, e.g. `linear issues --team ENG | jq -r '.issues.nodes[] | "\(.identifier) \(.title)"'`.
- **Errors** — GraphQL/transport errors are printed to stderr and the command exits non-zero.
- **Beyond the built-ins** — anything the API supports is reachable via `raw '<query>' '<variables-json>'` (variables is a JSON string). See the [schema docs](https://linear.app/developers/graphql).

## Workflow

1. Confirm auth and discover teams: `linear me` then `linear teams`.
2. Find work: `linear issues --team <KEY> --assignee me` or `linear search "<text>"`.
3. Inspect: `linear issue <identifier>`.
4. Act: `create`, `comment`, or `update` as needed.
5. For anything not wrapped, drop to `linear raw '<graphql>'`.
