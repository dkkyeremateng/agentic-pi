"""Unit tests for atlassian.py — pure stdlib, no network (urlopen/_auth mocked).

Run:  python3 -m unittest discover -s skills/atlassian -p 'test_*.py'
   or:  npm run test:atlassian
"""
import contextlib
import io
import json
import types
import unittest
from unittest import mock

import atlassian


class FakeResp:
    def __init__(self, payload):
        self._payload = payload  # dict, or b"" for a 204-style empty body

    def read(self):
        if isinstance(self._payload, (bytes, bytearray)):
            return self._payload
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


AUTH = ("https://x.atlassian.net/rest/api/3", "QkFTSUM=")


class ApiTests(unittest.TestCase):
    @mock.patch.object(atlassian, "_auth", return_value=AUTH)
    @mock.patch.object(atlassian.urllib.request, "urlopen")
    def test_basic_auth_and_parse(self, urlopen, _auth):
        urlopen.return_value = FakeResp({"accountId": "1"})
        data = atlassian.api("GET", "/myself")
        self.assertEqual(data, {"accountId": "1"})
        req = urlopen.call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), "Basic QkFTSUM=")
        self.assertEqual(req.get_method(), "GET")

    @mock.patch.object(atlassian, "_auth", return_value=AUTH)
    @mock.patch.object(atlassian.urllib.request, "urlopen")
    def test_empty_body_returns_dict(self, urlopen, _auth):
        urlopen.return_value = FakeResp(b"")  # 204 No Content
        self.assertEqual(atlassian.api("PUT", "/issue/X", {"fields": {}}), {})

    @mock.patch.object(atlassian, "_auth", return_value=AUTH)
    @mock.patch.object(atlassian.urllib.request, "urlopen")
    def test_http_error_exits(self, urlopen, _auth):
        urlopen.side_effect = atlassian.urllib.error.HTTPError(
            "u", 400, "bad", {}, io.BytesIO(b'{"err":1}')
        )
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            atlassian.api("GET", "/myself")

    def test_missing_config_exits(self):
        with mock.patch.object(atlassian, "_env", return_value=None):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                atlassian._auth()


class HelperTests(unittest.TestCase):
    def test_base_url_variants(self):
        self.assertEqual(atlassian._base_url("acme"), "https://acme.atlassian.net/rest/api/3")
        self.assertEqual(
            atlassian._base_url("acme.atlassian.net"),
            "https://acme.atlassian.net/rest/api/3",
        )
        self.assertEqual(
            atlassian._base_url("https://acme.atlassian.net/"),
            "https://acme.atlassian.net/rest/api/3",
        )

    def test_adf_wraps_plain_text(self):
        doc = atlassian.adf("hello")
        self.assertEqual(doc["type"], "doc")
        self.assertEqual(doc["content"][0]["content"][0]["text"], "hello")

    @mock.patch.object(atlassian, "api")
    def test_search_jql_token_pages_and_respects_limit(self, api):
        api.side_effect = [
            {"issues": [{"key": "A"}, {"key": "B"}], "nextPageToken": "t1"},
            {"issues": [{"key": "C"}]},  # no nextPageToken -> last page
        ]
        res = atlassian.search_jql("project = X", 10, ["summary"])
        self.assertEqual([i["key"] for i in res], ["A", "B", "C"])
        self.assertEqual(api.call_args_list[0][0][1], "/search/jql")  # new endpoint
        self.assertEqual(api.call_args_list[1][0][2]["nextPageToken"], "t1")  # carried token


class CommandTests(unittest.TestCase):
    @mock.patch.object(atlassian, "out")
    @mock.patch.object(atlassian, "search_jql", return_value=[])
    def test_tickets_builds_jql(self, search_jql, _out):
        a = types.SimpleNamespace(
            project="ENG", assignee="me", status="To Do", query="", limit=25
        )
        atlassian.cmd_tickets(a)
        jql = search_jql.call_args[0][0]
        self.assertIn('project = "ENG"', jql)
        self.assertIn("assignee = currentUser()", jql)
        self.assertIn('status = "To Do"', jql)
        self.assertTrue(jql.strip().endswith("ORDER BY updated DESC"))

    @mock.patch.object(atlassian, "out")
    @mock.patch.object(atlassian, "search_jql", return_value=[])
    def test_tickets_defaults_to_current_user(self, search_jql, _out):
        a = types.SimpleNamespace(
            project="", assignee="", status="", query="", limit=25
        )
        atlassian.cmd_tickets(a)
        self.assertIn("assignee = currentUser()", search_jql.call_args[0][0])

    @mock.patch.object(atlassian, "out")
    @mock.patch.object(atlassian, "api")
    def test_transition_resolves_name_to_id(self, api, _out):
        api.side_effect = [
            {"transitions": [{"id": "31", "name": "Done"}, {"id": "11", "name": "To Do"}]},
            {},
        ]
        atlassian.cmd_transition(types.SimpleNamespace(key="ENG-1", status="done"))
        self.assertEqual(api.call_args_list[1][0][2], {"transition": {"id": "31"}})

    @mock.patch.object(atlassian, "out")
    @mock.patch.object(atlassian, "_me_id", return_value="acc-1")
    @mock.patch.object(atlassian, "api", return_value={})
    def test_create_builds_fields(self, api, _me, _out):
        a = types.SimpleNamespace(
            project="ENG", summary="Fix", type="Bug",
            description="", assignee="me", priority="High",
        )
        atlassian.cmd_create(a)
        body = api.call_args[0][2]
        self.assertEqual(body["fields"]["project"], {"key": "ENG"})
        self.assertEqual(body["fields"]["issuetype"], {"name": "Bug"})
        self.assertEqual(body["fields"]["assignee"], {"accountId": "acc-1"})
        self.assertEqual(body["fields"]["priority"], {"name": "High"})


class ParserTests(unittest.TestCase):
    def test_tickets_defaults(self):
        a = atlassian.build_parser().parse_args(["tickets"])
        self.assertEqual(a.limit, 25)
        self.assertEqual(a.fn, atlassian.cmd_tickets)

    def test_create_requires_project_and_summary(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            atlassian.build_parser().parse_args(["create", "--summary", "x"])


if __name__ == "__main__":
    unittest.main()
