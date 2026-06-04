#!/usr/bin/env python3
"""atlassian.py — token-efficient CLI for the Jira Cloud REST API (v3).

Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/

Auth (set in your environment or a .env file — the current dir, or any parent up
to this script's repo root):
  ATLASSIAN_SITE       your site: `mycompany`, `mycompany.atlassian.net`, or a full URL
  ATLASSIAN_EMAIL      the account email
  ATLASSIAN_API_TOKEN  an API token (https://id.atlassian.com/manage-profile/security/api-tokens)

Stdlib only — no third-party deps, no curl. Every command prints JSON to stdout;
pipe to `jq`. HTTP/transport errors go to stderr and exit non-zero.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"atlassian.py: {msg}", file=sys.stderr)
    sys.exit(1)


# ── Config (env first, then the nearest .env walking up from this script) ──────
_DOTENV: dict | None = None


def _dotenv() -> dict:
    global _DOTENV
    if _DOTENV is not None:
        return _DOTENV
    found: dict = {}
    paths = [os.path.join(os.getcwd(), ".env")]
    d = os.path.dirname(os.path.realpath(__file__))
    while True:
        paths.append(os.path.join(d, ".env"))
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                        v = v[1:-1]
                    found.setdefault(k, v)  # nearer file (listed first) wins
        except OSError:
            continue
    _DOTENV = found
    return found


def _env(name: str) -> str | None:
    return os.environ.get(name) or _dotenv().get(name)


def _base_url(site: str) -> str:
    if "://" in site:
        root = site.rstrip("/")
    elif site.endswith(".atlassian.net"):
        root = "https://" + site
    else:
        root = f"https://{site}.atlassian.net"
    return root + "/rest/api/3"


def _auth() -> tuple[str, str]:
    site, email, token = (
        _env("ATLASSIAN_SITE"),
        _env("ATLASSIAN_EMAIL"),
        _env("ATLASSIAN_API_TOKEN"),
    )
    missing = [
        n
        for n, v in (
            ("ATLASSIAN_SITE", site),
            ("ATLASSIAN_EMAIL", email),
            ("ATLASSIAN_API_TOKEN", token),
        )
        if not v
    ]
    if missing:
        die(f"not configured — set {', '.join(missing)} (in env or .env)")
    basic = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
    return _base_url(site), basic  # type: ignore[arg-type]


# ── Core: one REST call ────────────────────────────────────────────────────────
def api(method: str, path: str, body: dict | None = None, params: dict | None = None) -> dict:
    base, basic = _auth()
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method.upper(),
        headers={
            "Authorization": f"Basic {basic}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        die(f"HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        die(f"network error: {exc.reason}")


def out(data) -> None:
    print(json.dumps(data, indent=2))


def adf(text: str) -> dict:
    """Wrap plain text in a minimal Atlassian Document Format doc (v3 needs ADF
    for description/comment bodies)."""
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
        ],
    }


def _me_id() -> str:
    return api("GET", "/myself")["accountId"]


def search_jql(jql: str, limit: int, fields: list[str]) -> list:
    """Run a JQL search via the v3 `/search/jql` endpoint (the old `/search` was
    removed), token-paging (100/page) up to `limit`. Returns the raw Jira tickets."""
    tickets: list = []
    token = None
    while len(tickets) < limit:
        page = min(100, limit - len(tickets))
        body: dict = {"jql": jql, "maxResults": page, "fields": fields}
        if token:
            body["nextPageToken"] = token
        data = api("POST", "/search/jql", body)
        batch = data.get("issues", [])
        tickets.extend(batch)
        token = data.get("nextPageToken")
        if not token or not batch:
            break
    return tickets[:limit]


# ── Commands ──────────────────────────────────────────────────────────────────
def cmd_me(_a):
    out(api("GET", "/myself"))


def cmd_projects(a):
    vals: list = []
    start = 0
    while len(vals) < a.limit:
        page = min(50, a.limit - len(vals))
        data = api("GET", "/project/search", params={"startAt": start, "maxResults": page})
        batch = data.get("values", [])
        vals.extend(batch)
        if data.get("isLast") or not batch:
            break
        start += len(batch)
    out({"projects": vals[: a.limit]})


def cmd_tickets(a):
    clauses: list[str] = []
    if a.project:
        clauses.append(f'project = "{a.project}"')
    if a.assignee:
        clauses.append(
            "assignee = currentUser()"
            if a.assignee == "me"
            else f'assignee = "{a.assignee}"'
        )
    if a.status:
        clauses.append(f'status = "{a.status}"')
    if a.query:
        clauses.append(f'text ~ "{a.query}"')
    # /search/jql rejects unbounded queries — with no filter, default to the
    # current user's tickets so a bare `tickets` still works (and is useful).
    if not clauses:
        clauses.append("assignee = currentUser()")
    jql = " AND ".join(clauses) + " ORDER BY updated DESC"
    out({
        "jql": jql,
        "tickets": search_jql(
            jql, a.limit, ["summary", "status", "assignee", "priority", "updated"]
        ),
    })


def cmd_ticket(a):
    out(api("GET", f"/issue/{a.key}"))


def cmd_search(a):
    out({
        "tickets": search_jql(
            a.jql, a.limit, ["summary", "status", "assignee", "updated"]
        )
    })


def cmd_create(a):
    fields: dict = {
        "project": {"key": a.project},
        "summary": a.summary,
        "issuetype": {"name": a.type},
    }
    if a.description:
        fields["description"] = adf(a.description)
    if a.assignee:
        fields["assignee"] = {
            "accountId": _me_id() if a.assignee == "me" else a.assignee
        }
    if a.priority:
        fields["priority"] = {"name": a.priority}
    out(api("POST", "/issue", {"fields": fields}))


def cmd_comment(a):
    out(api("POST", f"/issue/{a.key}/comment", {"body": adf(a.body)}))


def cmd_update(a):
    fields: dict = {}
    if a.summary:
        fields["summary"] = a.summary
    if a.description:
        fields["description"] = adf(a.description)
    if a.assignee:
        fields["assignee"] = {
            "accountId": _me_id() if a.assignee == "me" else a.assignee
        }
    if a.priority:
        fields["priority"] = {"name": a.priority}
    if not fields:
        die("update needs at least one field to change")
    api("PUT", f"/issue/{a.key}", {"fields": fields})  # 204 No Content
    out({"updated": a.key, "fields": list(fields)})


def cmd_transitions(a):
    out(api("GET", f"/issue/{a.key}/transitions"))


def cmd_transition(a):
    transitions = api("GET", f"/issue/{a.key}/transitions").get("transitions", [])
    match = next(
        (t for t in transitions if t["name"].lower() == a.status.lower()), None
    )
    if not match:
        names = ", ".join(t["name"] for t in transitions)
        die(f'no transition to "{a.status}" available. Options: {names}')
    api("POST", f"/issue/{a.key}/transitions", {"transition": {"id": match["id"]}})
    out({"transitioned": a.key, "to": match["name"]})


def cmd_raw(a):
    body = None
    if a.body:
        try:
            body = json.loads(a.body)
        except json.JSONDecodeError as exc:
            die(f"invalid body JSON: {exc}")
    out(api(a.method, a.path, body))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="atlassian.py", description="Jira Cloud REST CLI (stdlib only)."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("me", help="Current user (myself)").set_defaults(fn=cmd_me)

    s = sub.add_parser("projects", help="List projects")
    s.add_argument("--limit", type=int, default=50)
    s.set_defaults(fn=cmd_projects)

    s = sub.add_parser("tickets", help="List/filter tickets (builds JQL)")
    s.add_argument("--project", default="", metavar="KEY")
    s.add_argument("--assignee", default="", metavar="me|accountId")
    s.add_argument("--status", default="", metavar="NAME")
    s.add_argument("--query", default="", metavar="TEXT")
    s.add_argument("--limit", type=int, default=25)
    s.set_defaults(fn=cmd_tickets)

    s = sub.add_parser("ticket", help="Full detail for one ticket (e.g. ENG-123)")
    s.add_argument("key")
    s.set_defaults(fn=cmd_ticket)

    s = sub.add_parser("search", help="Run a raw JQL query")
    s.add_argument("jql")
    s.add_argument("--limit", type=int, default=25)
    s.set_defaults(fn=cmd_search)

    s = sub.add_parser("create", help="Create a ticket")
    s.add_argument("--project", required=True, metavar="KEY")
    s.add_argument("--summary", required=True)
    s.add_argument("--type", default="Task", help="issue type name (default Task)")
    s.add_argument("--description", default="")
    s.add_argument("--assignee", default="", metavar="me|accountId")
    s.add_argument("--priority", default="")
    s.set_defaults(fn=cmd_create)

    s = sub.add_parser("comment", help="Add a comment to a ticket")
    s.add_argument("key")
    s.add_argument("body")
    s.set_defaults(fn=cmd_comment)

    s = sub.add_parser("update", help="Update ticket fields")
    s.add_argument("key")
    s.add_argument("--summary", default="")
    s.add_argument("--description", default="")
    s.add_argument("--assignee", default="", metavar="me|accountId")
    s.add_argument("--priority", default="")
    s.set_defaults(fn=cmd_update)

    s = sub.add_parser("transitions", help="List available status transitions")
    s.add_argument("key")
    s.set_defaults(fn=cmd_transitions)

    s = sub.add_parser("transition", help="Move a ticket to a status by name")
    s.add_argument("key")
    s.add_argument("status", metavar="NAME")
    s.set_defaults(fn=cmd_transition)

    s = sub.add_parser("raw", help="Arbitrary REST call")
    s.add_argument("method", metavar="GET|POST|PUT|DELETE")
    s.add_argument("path", help="e.g. /myself or /issue/ENG-1")
    s.add_argument("body", nargs="?", default="", help="request body as JSON")
    s.set_defaults(fn=cmd_raw)

    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.fn(args)
