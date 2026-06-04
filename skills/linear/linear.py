#!/usr/bin/env python3
"""linear.py — token-efficient CLI for the Linear GraphQL API.

Docs: https://linear.app/developers/graphql   Endpoint: https://api.linear.app/graphql

Auth: set LINEAR_API_KEY (a Personal API key, starts with `lin_api_`) in your
environment or in a .env file (the current dir, or the repo root next to this
script). For an OAuth token, set LINEAR_API_KEY="Bearer <access_token>".

Stdlib only — no third-party deps, no curl, no jq. Every command prints the
GraphQL `data` payload as JSON to stdout; pipe to `jq`/`python -m json.tool` to
reshape. GraphQL/transport errors go to stderr and exit non-zero.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API_URL = os.environ.get("LINEAR_API_URL", "https://api.linear.app/graphql")


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"linear.py: {msg}", file=sys.stderr)
    sys.exit(1)


def _key_from_env_file(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("LINEAR_API_KEY="):
                    val = line.split("=", 1)[1].strip()
                    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                        val = val[1:-1]
                    if val:
                        return val
    except OSError:
        pass
    return None


def _load_env_key() -> str | None:
    """Resolve LINEAR_API_KEY: env first, then ./.env, then the nearest .env
    found by walking up from this script's real location (following symlinks, so
    a symlinked-on-PATH copy still finds the repo .env regardless of depth)."""
    key = os.environ.get("LINEAR_API_KEY")
    if key:
        return key
    if (val := _key_from_env_file(os.path.join(os.getcwd(), ".env"))):
        return val
    d = os.path.dirname(os.path.realpath(__file__))
    while True:
        if (val := _key_from_env_file(os.path.join(d, ".env"))):
            return val
        parent = os.path.dirname(d)
        if parent == d:  # reached filesystem root
            return None
        d = parent


def gql(query: str, variables: dict | None = None) -> dict:
    """Run a GraphQL operation and return the `data` object."""
    key = _load_env_key()
    if not key:
        die("LINEAR_API_KEY is not set (export it or add it to .env)")
    body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Authorization": key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        die(f"HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        die(f"network error: {exc.reason}")
    if payload.get("errors"):
        die("GraphQL error:\n" + json.dumps(payload["errors"], indent=2))
    return payload.get("data", {})


def out(data: dict) -> None:
    print(json.dumps(data, indent=2))


def paginate(query: str, base_vars: dict, root: str, limit: int) -> list:
    """Fetch up to `limit` nodes across pages. `query` must accept $first/$after and
    return {<root>: {nodes, pageInfo{hasNextPage endCursor}}}. Linear caps a page at
    250, so this walks the endCursor until `limit` is reached or results run out."""
    nodes: list = []
    after = None
    while len(nodes) < limit:
        page = min(250, limit - len(nodes))
        conn = gql(query, {**base_vars, "first": page, "after": after})[root]
        nodes.extend(conn["nodes"])
        info = conn["pageInfo"]
        if not info["hasNextPage"]:
            break
        after = info["endCursor"]
    return nodes[:limit]


def team_id_from_key(key: str) -> str:
    """Resolve a team KEY (e.g. 'ENG') to its UUID; pass UUIDs through unchanged."""
    if len(key) == 36 and key.count("-") == 4:
        return key
    data = gql(
        "query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id}}}", {"k": key}
    )
    nodes = data.get("teams", {}).get("nodes", [])
    if not nodes:
        die(f"no team for key '{key}'")
    return nodes[0]["id"]


def viewer_id() -> str:
    return gql("query{viewer{id}}")["viewer"]["id"]


# ── Commands ──────────────────────────────────────────────────────────────────
def cmd_me(_a):
    out(gql("query{viewer{id name email admin}}"))


def cmd_teams(_a):
    out(gql("query{teams{nodes{id key name}}}"))


def cmd_states(a):
    tid = team_id_from_key(a.team)
    out(gql(
        "query($t:String!){workflowStates(filter:{team:{id:{eq:$t}}})"
        "{nodes{id name type position}}}",
        {"t": tid},
    ))


def cmd_issues(a):
    assignee = viewer_id() if a.assignee == "me" else a.assignee
    f: dict = {}
    if a.team:
        f["team"] = {"key": {"eq": a.team}}
    if assignee:
        f["assignee"] = {"id": {"eq": assignee}}
    # state filters merge into one object (Linear ANDs fields): --state matches a
    # team-specific name, --active matches the universal state *type*.
    state: dict = {}
    if a.state:
        state["name"] = {"eq": a.state}
    if a.active:
        state["type"] = {"nin": ["completed", "canceled"]}
    if state:
        f["state"] = state
    if a.query:
        f["searchableContent"] = {"contains": a.query}
    nodes = paginate(
        "query($f:IssueFilter,$n:Int,$after:String)"
        "{issues(filter:$f,first:$n,after:$after,orderBy:updatedAt)"
        "{nodes{identifier title priority state{name} assignee{name} updatedAt url}"
        "pageInfo{hasNextPage endCursor}}}",
        {"f": f},
        "issues",
        a.limit,
    )
    out({"issues": {"nodes": nodes}})


def cmd_issue(a):
    out(gql(
        "query($id:String!){issue(id:$id){identifier title description priority url "
        "createdAt updatedAt state{name type} assignee{name email} team{key name} "
        "labels{nodes{name}} comments{nodes{body user{name} createdAt}}}}",
        {"id": a.id},
    ))


def cmd_search(a):
    nodes = paginate(
        "query($t:String!,$n:Int,$after:String)"
        "{searchIssues(term:$t,first:$n,after:$after)"
        "{nodes{identifier title state{name} assignee{name} url}"
        "pageInfo{hasNextPage endCursor}}}",
        {"t": a.text},
        "searchIssues",
        a.limit,
    )
    out({"searchIssues": {"nodes": nodes}})


def cmd_create(a):
    tid = team_id_from_key(a.team)
    inp: dict = {"teamId": tid, "title": a.title}
    if a.description:
        inp["description"] = a.description
    if a.assignee:
        inp["assigneeId"] = viewer_id() if a.assignee == "me" else a.assignee
    if a.priority is not None:
        inp["priority"] = a.priority
    out(gql(
        "mutation($i:IssueCreateInput!){issueCreate(input:$i)"
        "{success issue{identifier title url}}}",
        {"i": inp},
    ))


def cmd_comment(a):
    out(gql(
        "mutation($i:CommentCreateInput!){commentCreate(input:$i)"
        "{success comment{id url}}}",
        {"i": {"issueId": a.id, "body": a.body}},
    ))


def cmd_update(a):
    inp: dict = {}
    if a.title:
        inp["title"] = a.title
    if a.description:
        inp["description"] = a.description
    if a.state:
        inp["stateId"] = a.state
    if a.assignee:
        inp["assigneeId"] = viewer_id() if a.assignee == "me" else a.assignee
    if a.priority is not None:
        inp["priority"] = a.priority
    if not inp:
        die("update needs at least one field to change")
    out(gql(
        "mutation($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i)"
        "{success issue{identifier title state{name} url}}}",
        {"id": a.id, "i": inp},
    ))


def cmd_raw(a):
    variables = {}
    if a.variables:
        try:
            variables = json.loads(a.variables)
        except json.JSONDecodeError as exc:
            die(f"invalid variables JSON: {exc}")
    out(gql(a.query, variables))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="linear.py", description="Linear GraphQL CLI (stdlib only)."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("me", help="Current user (viewer)").set_defaults(fn=cmd_me)
    sub.add_parser("teams", help="List teams (id, key, name)").set_defaults(fn=cmd_teams)

    s = sub.add_parser("states", help="Workflow states for a team")
    s.add_argument("--team", required=True, metavar="KEY")
    s.set_defaults(fn=cmd_states)

    s = sub.add_parser("issues", help="List issues")
    s.add_argument("--team", default="", metavar="KEY")
    s.add_argument("--assignee", default="", metavar="me|ID")
    s.add_argument("--state", default="", metavar="NAME")
    s.add_argument("--active", action="store_true",
                   help="only open issues (exclude completed/canceled)")
    s.add_argument("--query", default="", metavar="TEXT")
    s.add_argument("--limit", type=int, default=25)
    s.set_defaults(fn=cmd_issues)

    s = sub.add_parser("issue", help="Full detail for one issue (ID or ENG-123)")
    s.add_argument("id")
    s.set_defaults(fn=cmd_issue)

    s = sub.add_parser("search", help="Full-text issue search")
    s.add_argument("text")
    s.add_argument("--limit", type=int, default=25)
    s.set_defaults(fn=cmd_search)

    s = sub.add_parser("create", help="Create an issue")
    s.add_argument("--team", required=True, metavar="KEY")
    s.add_argument("--title", required=True)
    s.add_argument("--description", default="")
    s.add_argument("--assignee", default="", metavar="me|ID")
    s.add_argument("--priority", type=int, choices=range(0, 5), metavar="0-4")
    s.set_defaults(fn=cmd_create)

    s = sub.add_parser("comment", help="Add a comment to an issue")
    s.add_argument("id")
    s.add_argument("body")
    s.set_defaults(fn=cmd_comment)

    s = sub.add_parser("update", help="Update an issue")
    s.add_argument("id")
    s.add_argument("--title", default="")
    s.add_argument("--description", default="")
    s.add_argument("--state", default="", metavar="stateId")
    s.add_argument("--assignee", default="", metavar="me|ID")
    s.add_argument("--priority", type=int, choices=range(0, 5), metavar="0-4")
    s.set_defaults(fn=cmd_update)

    s = sub.add_parser("raw", help="Run an arbitrary GraphQL operation")
    s.add_argument("query")
    s.add_argument("variables", nargs="?", default="", help="variables as JSON")
    s.set_defaults(fn=cmd_raw)

    return p


def main() -> None:
    args = build_parser().parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
