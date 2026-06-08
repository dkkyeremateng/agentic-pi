"""Unit + integration tests for lsp.py — pure stdlib.

Pure helpers are tested directly; the client is tested end-to-end against a fake
LSP server (a tiny script that speaks the protocol), so no real language server is
required.

Run:  python3 -m unittest discover -s skills/lsp -p 'test_*.py'
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import lsp

HERE = os.path.dirname(os.path.abspath(__file__))
LSP_PY = os.path.join(HERE, "lsp.py")

FAKE_SERVER = r'''
import sys, json
def read():
    headers={}
    line=sys.stdin.buffer.readline()
    if not line: return None
    while line not in (b"\r\n", b"\n"):
        k,_,v=line.partition(b":"); headers[k.strip().lower()]=v.strip()
        line=sys.stdin.buffer.readline()
    n=int(headers.get(b"content-length",b"0"))
    return json.loads(sys.stdin.buffer.read(n))
def send(o):
    d=json.dumps(o).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n%s"%(len(d),d)); sys.stdout.buffer.flush()
while True:
    m=read()
    if m is None: break
    meth=m.get("method"); i=m.get("id")
    if meth=="initialize":
        # send a server->client request first to exercise the handler
        send({"jsonrpc":"2.0","id":999,"method":"workspace/configuration","params":{"items":[{}]}})
        send({"jsonrpc":"2.0","id":i,"result":{"capabilities":{}}})
    elif meth=="textDocument/didOpen":
        uri=m["params"]["textDocument"]["uri"]
        send({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{
          "uri":uri,"diagnostics":[{"range":{"start":{"line":3,"character":10},"end":{"line":3,"character":23}},
          "severity":1,"code":"undefined","source":"fake","message":"undefined name"}]}})
    elif meth=="textDocument/definition":
        uri=m["params"]["textDocument"]["uri"]
        send({"jsonrpc":"2.0","id":i,"result":{"uri":uri,"range":{"start":{"line":0,"character":4},"end":{"line":0,"character":9}}}})
    elif meth=="textDocument/hover":
        send({"jsonrpc":"2.0","id":i,"result":{"contents":{"kind":"markdown","value":"the symbol"}}})
    elif meth=="shutdown":
        send({"jsonrpc":"2.0","id":i,"result":None})
    elif meth=="exit":
        break
'''


class HelperTests(unittest.TestCase):
    def test_ext_of(self):
        self.assertEqual(lsp.ext_of("a/b/c.TS"), "ts")
        self.assertEqual(lsp.ext_of("x.py"), "py")
        self.assertEqual(lsp.ext_of("Makefile"), "")

    def test_uri_roundtrip(self):
        p = "sample.py"
        uri = lsp.path_to_uri(p)
        self.assertTrue(uri.startswith("file://"))
        self.assertEqual(lsp.uri_to_path(uri), p)

    def test_resolve_server_forced(self):
        with mock.patch.dict(os.environ, {"LSP_SERVER_CMD": "fake --stdio"}):
            self.assertEqual(lsp.resolve_server("x.go"), "fake --stdio")

    def test_resolve_server_per_ext_override(self):
        with mock.patch.dict(os.environ, {"LSP_SERVER_PY": "pylsp"}, clear=False):
            os.environ.pop("LSP_SERVER_CMD", None)
            with mock.patch.object(lsp.shutil, "which", lambda b: "/usr/bin/" + b):
                self.assertEqual(lsp.resolve_server("x.py"), "pylsp")

    def test_resolve_server_fallback_to_installed_candidate(self):
        os.environ.pop("LSP_SERVER_CMD", None)
        os.environ.pop("LSP_SERVER_PY", None)
        # pyright missing, pylsp present -> pick pylsp (2nd candidate)
        with mock.patch.object(lsp.shutil, "which", lambda b: "/bin/pylsp" if b == "pylsp" else None):
            self.assertEqual(lsp.resolve_server("x.py"), "pylsp")

    def test_resolve_server_none_installed(self):
        os.environ.pop("LSP_SERVER_CMD", None)
        with mock.patch.object(lsp.shutil, "which", lambda b: None):
            self.assertIsNone(lsp.resolve_server("x.rs"))  # unsupported ext too

    def test_fmt_diagnostic_is_one_based(self):
        d = lsp.fmt_diagnostic({
            "range": {"start": {"line": 3, "character": 10}, "end": {"line": 3, "character": 23}},
            "severity": 2, "code": "E1", "source": "x", "message": "  msg  ",
        })
        self.assertEqual((d["line"], d["col"], d["endLine"], d["endCol"]), (4, 11, 4, 24))
        self.assertEqual(d["severity"], "warning")
        self.assertEqual(d["message"], "msg")

    def test_norm_locations_variants(self):
        loc = {"uri": lsp.path_to_uri("a.py"), "range": {"start": {"line": 0, "character": 4}}}
        link = {"targetUri": lsp.path_to_uri("a.py"), "targetSelectionRange": {"start": {"line": 1, "character": 2}}}
        self.assertEqual(lsp.norm_locations(loc), [{"file": "a.py", "line": 1, "col": 5}])
        self.assertEqual(lsp.norm_locations([loc]), [{"file": "a.py", "line": 1, "col": 5}])
        self.assertEqual(lsp.norm_locations([link]), [{"file": "a.py", "line": 2, "col": 3}])
        self.assertEqual(lsp.norm_locations(None), [])

    def test_hover_text_variants(self):
        self.assertEqual(lsp.hover_text({"contents": {"value": "hi"}}), "hi")
        self.assertEqual(lsp.hover_text({"contents": [{"value": "a"}, {"value": "b"}]}), "a\nb")
        self.assertEqual(lsp.hover_text({"contents": "plain"}), "plain")
        self.assertEqual(lsp.hover_text(None), "")


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.server = os.path.join(self.tmp, "fakeserver.py")
        with open(self.server, "w") as f:
            f.write(FAKE_SERVER)
        with open(os.path.join(self.tmp, "sample.py"), "w") as f:
            f.write("def greet(name):\n    return name\n\nx = greet(undefined_var)\n")

    def _run(self, *args):
        env = dict(os.environ, LSP_SERVER_CMD=f"{sys.executable} {self.server}")
        return subprocess.run(
            [sys.executable, LSP_PY, *args],
            cwd=self.tmp, env=env, capture_output=True, text=True,
        )

    def test_diagnostics_end_to_end(self):
        r = self._run("diagnostics", "sample.py", "--timeout", "8")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        diags = data["files"][0]["diagnostics"]
        self.assertEqual(diags[0]["line"], 4)  # 0-based 3 -> 1-based 4
        self.assertEqual(diags[0]["severity"], "error")
        self.assertIn("undefined", diags[0]["message"])

    def test_fail_on_error_exit_code(self):
        r = self._run("diagnostics", "sample.py", "--fail-on-error", "--timeout", "8")
        self.assertEqual(r.returncode, 1)

    def test_definition_end_to_end(self):
        r = self._run("definition", "sample.py", "4", "11", "--timeout", "8")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["definitions"][0], {"file": "sample.py", "line": 1, "col": 5})

    def test_hover_end_to_end(self):
        r = self._run("hover", "sample.py", "1", "5", "--timeout", "8")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["hover"], "the symbol")

    def test_missing_server_is_graceful(self):
        env = dict(os.environ)
        env.pop("LSP_SERVER_CMD", None)
        env["LSP_SERVER_PY"] = "definitely-not-a-real-server-xyz"
        r = subprocess.run(
            [sys.executable, LSP_PY, "diagnostics", "sample.py"],
            cwd=self.tmp, env=env, capture_output=True, text=True,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(
            "no language server installed",
            json.loads(r.stdout)["files"][0]["error"],
        )


if __name__ == "__main__":
    unittest.main()
