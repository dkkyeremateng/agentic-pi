# Atlassian (Jira + Confluence) Skill — Value Proposition

A token-efficient CLI wrapper around the [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) and the [Confluence Cloud REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/) for reading/mutating Jira tickets and reading Confluence wiki pages from the shell — the Atlassian counterpart to the `linear` skill. Covers anything on `*.atlassian.net`. No MCP tool schemas in context: every command makes one REST call and prints JSON, ready to pipe to `jq`.

## What it is

`atlassian` (`atlassian.py`) is a thin, stdlib-only Python client for a Jira Cloud site. It wraps the common workflows — listing/searching tickets (JQL), reading ticket detail, creating tickets, commenting, updating fields, and transitioning status — behind short subcommands, with a `raw` escape hatch for any REST endpoint.

## Core capabilities

- **Read** — `me`, `projects`, `tickets` (filter by project/assignee/status/text), `ticket <key>`, `search '<JQL>'`.
- **Write** — `create`, `comment`, `update`, `transition` (move status by name).
- **Friendly filters** — `tickets` builds JQL for you; `--assignee me` resolves to your accountId.
- **Escape hatch** — `raw <METHOD> <path> [json]` for any v3 endpoint.

## Authentication

HTTP Basic with an API token:

- `ATLASSIAN_SITE` — `mycompany`, `mycompany.atlassian.net`, or a full URL.
- `ATLASSIAN_EMAIL` — your account email.
- `ATLASSIAN_API_TOKEN` — from <https://id.atlassian.com/manage-profile/security/api-tokens>.

Set them in the environment or a `.env` (current dir or any parent up to the repo root).

## Typical use cases

- Triage: list tickets assigned to you, search a board with JQL, read full ticket detail.
- Automation: create tickets from scripts, post comments, move them through their workflow.
- Reporting: pipe `tickets`/`search` JSON into `jq`.

## Safety & notes

- Treat `ATLASSIAN_API_TOKEN` as a secret — keep it in `.env` (git-ignored) or the environment.
- Mutations (`create`, `comment`, `update`, `transition`) change real Jira data — confirm targets before scripting them.
- Status is changed via **transitions**, not `update` — see `transitions <key>` for the allowed moves.
- Rich text fields (`--description`, comments) are sent as minimal ADF (plain text); use `raw` for rich content.

## Quick start

```bash
bash skills/atlassian/install.sh
export ATLASSIAN_SITE=mycompany ATLASSIAN_EMAIL=you@example.com ATLASSIAN_API_TOKEN=xxxx

atlassian me                                 # verify auth
atlassian projects                           # discover project keys
atlassian tickets --project ENG --assignee me # your tickets
atlassian ticket ENG-123                      # full detail
atlassian create --project ENG --summary "Fix nav" --type Bug --assignee me
atlassian transition ENG-123 "In Progress"
```

See [SKILL.md](SKILL.md) for the full command reference.
