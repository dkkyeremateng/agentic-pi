"""Unit tests for linear.py — pure stdlib, no network (urlopen is mocked).

Run:  python3 -m unittest discover -s skills/linear -p 'test_*.py'
   or:  npm run test:linear
"""
import contextlib
import io
import json
import types
import unittest
from unittest import mock

import linear


class FakeResp:
    """Minimal urlopen() context-manager stand-in returning canned JSON bytes."""

    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


class GqlTests(unittest.TestCase):
    @mock.patch.object(linear, "_load_env_key", return_value="lin_api_x")
    @mock.patch.object(linear.urllib.request, "urlopen")
    def test_builds_payload_and_returns_data(self, urlopen, _key):
        urlopen.return_value = FakeResp({"data": {"viewer": {"id": "1"}}})
        data = linear.gql("query{viewer{id}}", {"a": 1})
        self.assertEqual(data, {"viewer": {"id": "1"}})
        req = urlopen.call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["query"], "query{viewer{id}}")
        self.assertEqual(body["variables"], {"a": 1})
        self.assertEqual(req.get_header("Authorization"), "lin_api_x")

    @mock.patch.object(linear, "_load_env_key", return_value="lin_api_x")
    @mock.patch.object(linear.urllib.request, "urlopen")
    def test_graphql_errors_exit_nonzero(self, urlopen, _key):
        urlopen.return_value = FakeResp({"errors": [{"message": "boom"}]})
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            linear.gql("query{bad}")

    @mock.patch.object(linear, "_load_env_key", return_value=None)
    def test_missing_key_exits(self, _key):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            linear.gql("query{viewer{id}}")


class PaginateTests(unittest.TestCase):
    @mock.patch.object(linear, "gql")
    def test_follows_cursor_across_pages(self, g):
        g.side_effect = [
            {"issues": {"nodes": [{"id": 1}, {"id": 2}],
                        "pageInfo": {"hasNextPage": True, "endCursor": "c1"}}},
            {"issues": {"nodes": [{"id": 3}],
                        "pageInfo": {"hasNextPage": False, "endCursor": None}}},
        ]
        nodes = linear.paginate("Q", {"f": {}}, "issues", 10)
        self.assertEqual([n["id"] for n in nodes], [1, 2, 3])
        # second request carried the first page's endCursor
        self.assertEqual(g.call_args_list[1][0][1]["after"], "c1")

    @mock.patch.object(linear, "gql")
    def test_respects_limit(self, g):
        g.return_value = {
            "issues": {"nodes": [{"id": i} for i in range(5)],
                       "pageInfo": {"hasNextPage": True, "endCursor": "c"}}
        }
        nodes = linear.paginate("Q", {}, "issues", 2)
        self.assertEqual(len(nodes), 2)
        # first page requested exactly `limit` items
        self.assertEqual(g.call_args_list[0][0][1]["first"], 2)


class CommandTests(unittest.TestCase):
    def test_team_uuid_passes_through(self):
        u = "411d935a-f5cc-495f-b36e-2afcab9d430d"
        self.assertEqual(linear.team_id_from_key(u), u)

    @mock.patch.object(linear, "out")
    @mock.patch.object(linear, "paginate", return_value=[])
    def test_issues_active_and_state_merge_filter(self, paginate, _out):
        a = types.SimpleNamespace(
            team="ENG", assignee="", state="In Progress",
            active=True, query="", limit=25,
        )
        linear.cmd_issues(a)
        f = paginate.call_args[0][1]["f"]
        self.assertEqual(f["team"], {"key": {"eq": "ENG"}})
        self.assertEqual(f["state"]["name"], {"eq": "In Progress"})
        self.assertEqual(f["state"]["type"], {"nin": ["completed", "canceled"]})

    @mock.patch.object(linear, "out")
    @mock.patch.object(linear, "gql", return_value={})
    @mock.patch.object(linear, "team_id_from_key", return_value="tid")
    def test_create_omits_unset_optionals(self, _team, gql, _out):
        a = types.SimpleNamespace(
            team="ENG", title="Hi", description="", assignee="", priority=2,
        )
        linear.cmd_create(a)
        inp = gql.call_args[0][1]["i"]
        self.assertEqual(inp, {"teamId": "tid", "title": "Hi", "priority": 2})


class ParserTests(unittest.TestCase):
    def test_issues_defaults(self):
        a = linear.build_parser().parse_args(["issues"])
        self.assertEqual(a.limit, 25)
        self.assertFalse(a.active)
        self.assertEqual(a.fn, linear.cmd_issues)

    def test_raw_takes_optional_variables(self):
        a = linear.build_parser().parse_args(["raw", "query{x}"])
        self.assertEqual(a.query, "query{x}")
        self.assertEqual(a.variables, "")

    def test_projects_and_cycles_parse(self):
        p = linear.build_parser()
        a = p.parse_args(["projects", "--limit", "5"])
        self.assertEqual(a.fn, linear.cmd_projects)
        self.assertEqual(a.limit, 5)
        b = p.parse_args(["cycles", "--team", "ENG"])
        self.assertEqual(b.fn, linear.cmd_cycles)
        self.assertEqual(b.team, "ENG")


if __name__ == "__main__":
    unittest.main()
