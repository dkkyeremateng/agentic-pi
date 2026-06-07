---
name: atlassian
description: Query and mutate Atlassian Cloud (Jira + Confluence) over its REST API from the shell. Jira - list/search tickets (JQL), read, create, comment, update, transition, inspect projects. Confluence - read a wiki page by id or URL, search the wiki (CQL), list spaces. Use for ANYTHING on *.atlassian.net. Keywords - atlassian, jira, ticket, issue, jql, project, sprint, transition, confluence, wiki, page, space, cql.
allowed-tools: Bash
---

# Atlassian (Jira + Confluence) REST CLI

## Purpose

Talk to the [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) and the [Confluence Cloud REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/) through `atlassian` — a thin, token-efficient Python client (`atlassian.py`, stdlib only). No MCP server, no tool schemas in context: every command makes one REST call and prints JSON to stdout, ready to pipe to `jq`. Use it for **anything on `*.atlassian.net`** — Jira tickets and Confluence/wiki pages alike (read a `…/wiki/…/pages/<id>/…` link with `atlassian page <id-or-url>` rather than a browser).

## Setup

**1. Put `atlassian` on PATH** (one-time):

```bash
bash skills/atlassian/install.sh        # links atlassian.py -> ~/.local/bin/atlassian
```

**2. Configure** (env or a `.env` in the working dir / repo root):

```bash
export ATLASSIAN_SITE=mycompany           # or mycompany.atlassian.net, or a full URL
export ATLASSIAN_EMAIL=you@example.com
export ATLASSIAN_API_TOKEN=xxxxxxxx       # https://id.atlassian.com/manage-profile/security/api-tokens
```

Auth is HTTP Basic (`email:token`, base64). Requires `python3`; no other deps.

## Quick Reference

```bash
atlassian me                                  # current user (myself)
atlassian projects --limit 50                 # list projects
atlassian tickets                             # your tickets (defaults to assignee = you)
atlassian tickets --project ENG --assignee me --status "In Progress"
atlassian tickets --query "login bug" --limit 10
atlassian ticket ENG-123                      # full detail
atlassian search 'project = ENG AND status = "To Do" ORDER BY created DESC'
atlassian create --project ENG --summary "Fix nav" --type Bug --assignee me --priority High
atlassian comment ENG-123 "Reproduced on staging."
atlassian update ENG-123 --summary "New title" --assignee me
atlassian transitions ENG-123                 # available status moves (id + name)
atlassian transition ENG-123 "Done"           # move status by name
atlassian raw GET /issue/ENG-123              # arbitrary REST escape hatch (REST path is /issue)
atlassian raw POST /issue '<json>'

# ── Confluence (wiki) ──
atlassian page 2133032963                     # read a page by id (title + readable text)
atlassian page 'https://acme.atlassian.net/wiki/spaces/X/pages/2133032963/Title'  # …or by URL
atlassian page 2133032963 --raw-body          # storage HTML instead of stripped text
atlassian wiki-search 'text ~ "TZ Migration"' # search the wiki with CQL
atlassian spaces --limit 50                   # list spaces
```

## Notes

- **Terminology** — Jira's own API/UI says "issue"; this CLI uses **ticket** for the user-facing surface (the REST paths under the hood are still `/issue/...`).
- **Identifiers** — tickets use their key (`ENG-123`); `--project` takes a project **key** (`ENG`).
- **Assignee** — pass `me` (resolved to your accountId via `/myself`) or an explicit `accountId`. Jira identifies users by accountId, not username/email.
- **`tickets` builds JQL** from `--project`/`--assignee`/`--status`/`--query`; with no filter it defaults to your assigned tickets (`assignee = currentUser()`). For anything more complex use `search '<JQL>'`.
- **Bounded JQL required** — the `/search/jql` endpoint rejects *unbounded* queries (e.g. just `ORDER BY …`); always include a restriction (project, assignee, status, text, …).
- **Status changes go through transitions** — `update` can't set status. Use `transitions <key>` to see the allowed moves, then `transition <key> "<name>"`.
- **Rich text is ADF** — `--description` and comment bodies are wrapped in minimal Atlassian Document Format automatically (plain text only; for rich content use `raw`).
- **Output** — JSON. Reshape with `jq`, e.g. `atlassian tickets --project ENG | jq -r '.tickets[] | "\(.key) \(.fields.summary)"'`.
- **Errors** — HTTP errors print the response body to stderr and exit non-zero.
- **Search endpoint** — uses `POST /rest/api/3/search/jql` (token-paged); the old `/rest/api/3/search` was removed by Atlassian.
- **Confluence** — `page <id-or-url>` reads a wiki page (Confluence REST v2 `/wiki/api/v2/pages/{id}`); it accepts a numeric id or any URL containing `/pages/<id>` and returns `body_text` (HTML stripped) by default, or `body_storage` with `--raw-body`. `wiki-search '<cql>'` uses CQL (v1 `/wiki/rest/api/content/search`); `spaces` lists spaces. Same auth as Jira.

## Workflow

1. Confirm auth and discover projects: `atlassian me` then `atlassian projects`.
2. Find work: `atlassian tickets --project <KEY> --assignee me` or `atlassian search '<JQL>'`.
3. Inspect: `atlassian ticket <KEY>`.
4. Act: `create`, `comment`, `update`, or `transition`.
5. For anything not wrapped, drop to `atlassian raw <METHOD> <path> [json]`.
