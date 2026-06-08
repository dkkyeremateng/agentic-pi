"""Unit + integration tests for lsp.py — pure stdlib.

Pure helpers are tested directly; the client is tested end-to-end against a fake LSP
server (a tiny script that speaks the protocol), so no real language server is needed.

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

# A fake LSP server: handshake + diagnostics + nav + symbols + rename + code action.
FAKE_SERVER = r'''
import sys, json
last_uri=[None]
def read():
    h={}
    line=sys.stdin.buffer.readline()
    if not line: return None
    while line not in (b"\r\n", b"\n"):
        k,_,v=line.partition(b":"); h[k.strip().lower()]=v.strip()
        line=sys.stdin.buffer.readline()
    n=int(h.get(b"content-length",b"0"))
    return json.loads(sys.stdin.buffer.read(n))
def send(o):
    d=json.dumps(o).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n%s"%(len(d),d)); sys.stdout.buffer.flush()
def loc(uri,l,c): return {"uri":uri,"range":{"start":{"line":l,"character":c},"end":{"line":l,"character":c+5}}}
while True:
    m=read()
    if m is None: break
    meth=m.get("method"); i=m.get("id"); pr=m.get("params",{})
    if meth=="initialize":
        send({"jsonrpc":"2.0","id":999,"method":"workspace/configuration","params":{"items":[{"section":"gopls"}]}})
        send({"jsonrpc":"2.0","id":i,"result":{"capabilities":{}}})
    elif meth=="textDocument/didOpen":
        uri=pr["textDocument"]["uri"]; last_uri[0]=uri
        send({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{
          "uri":uri,"diagnostics":[{"range":{"start":{"line":3,"character":10},"end":{"line":3,"character":23}},
          "severity":1,"code":"undefined","source":"fake","message":"undefined name"}]}})
    elif meth in ("textDocument/definition","textDocument/typeDefinition","textDocument/implementation"):
        send({"jsonrpc":"2.0","id":i,"result":loc(pr["textDocument"]["uri"],0,4)})
    elif meth=="textDocument/references":
        u=pr["textDocument"]["uri"]; send({"jsonrpc":"2.0","id":i,"result":[loc(u,0,4),loc(u,3,4)]})
    elif meth=="textDocument/hover":
        send({"jsonrpc":"2.0","id":i,"result":{"contents":{"kind":"markdown","value":"the symbol"}}})
    elif meth=="textDocument/documentSymbol":
        send({"jsonrpc":"2.0","id":i,"result":[{"name":"greet","kind":12,
          "selectionRange":{"start":{"line":0,"character":4},"end":{"line":0,"character":9}}}]})
    elif meth=="workspace/symbol":
        send({"jsonrpc":"2.0","id":i,"result":[{"name":"greet","kind":12,
          "location":loc(last_uri[0] or "file:///x",0,4)}]})
    elif meth=="textDocument/rename":
        u=pr["textDocument"]["uri"]
        send({"jsonrpc":"2.0","id":i,"result":{"changes":{u:[
          {"range":{"start":{"line":0,"character":4},"end":{"line":0,"character":9}},"newText":"hello"},
          {"range":{"start":{"line":3,"character":4},"end":{"line":3,"character":9}},"newText":"hello"}]}}})
    elif meth=="textDocument/codeAction":
        u=pr["textDocument"]["uri"]
        send({"jsonrpc":"2.0","id":i,"result":[{"title":"Add header","kind":"quickfix","edit":{"changes":{u:[
          {"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"# fixed\n"}]}}}]})
    elif meth=="shutdown":
        send({"jsonrpc":"2.0","id":i,"result":None})
    elif meth=="exit":
        break
'''


class HelperTests(unittest.TestCase):
    def test_ext_of(self):
        self.assertEqual(lsp.ext_of("a/b/c.TS"), "ts")
        self.assertEqual(lsp.ext_of("Makefile"), "")

    def test_uri_roundtrip(self):
        uri = lsp.path_to_uri("sample.py")
        self.assertTrue(uri.startswith("file://"))
        self.assertEqual(lsp.uri_to_path(uri), "sample.py")

    def test_resolve_spec_forced(self):
        with mock.patch.dict(os.environ, {"LSP_SERVER_CMD": "fake --stdio"}):
            self.assertEqual(lsp.resolve_spec("x.go")["cmd"], "fake --stdio")

    def test_resolve_spec_per_ext_override(self):
        with mock.patch.dict(os.environ, {"LSP_SERVER_PY": "pylsp"}, clear=False):
            os.environ.pop("LSP_SERVER_CMD", None)
            with mock.patch.object(lsp.shutil, "which", lambda b: "/usr/bin/" + b):
                self.assertEqual(lsp.resolve_spec("x.py")["cmd"], "pylsp")

    def test_resolve_spec_fallback_candidate(self):
        os.environ.pop("LSP_SERVER_CMD", None)
        os.environ.pop("LSP_SERVER_PY", None)
        with mock.patch.object(lsp.shutil, "which", lambda b: "/bin/pylsp" if b == "pylsp" else None):
            self.assertEqual(lsp.resolve_spec("x.py")["cmd"], "pylsp")

    def test_resolve_spec_none(self):
        os.environ.pop("LSP_SERVER_CMD", None)
        with mock.patch.object(lsp.shutil, "which", lambda b: None):
            self.assertIsNone(lsp.resolve_spec("x.rs"))

    def test_find_root_walks_to_marker(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sub", "deep"))
            open(os.path.join(d, "go.mod"), "w").close()
            f = os.path.join(d, "sub", "deep", "main.go")
            open(f, "w").close()
            self.assertEqual(lsp.find_root(f, ["go.mod"]), d)

    def test_find_root_falls_back_to_cwd(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "x.py")
            open(f, "w").close()
            self.assertEqual(lsp.find_root(f, ["nonexistent.marker"]), os.getcwd())

    def test_resolve_position_col_and_symbol(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "s.py")
            open(f, "w").write("def greet(name): return greet(name)\n")
            self.assertEqual(lsp.resolve_position(f, 1, 5, None), (0, 4))
            self.assertEqual(lsp.resolve_position(f, 1, None, "greet"), (0, 4))
            self.assertEqual(lsp.resolve_position(f, 1, None, "greet#2"), (0, 24))
            with self.assertRaises(SystemExit):
                lsp.resolve_position(f, 1, None, "missing")

    def test_apply_text_edits(self):
        text = "abcdef"
        edits = [{"range": {"start": {"line": 0, "character": 1}, "end": {"line": 0, "character": 3}}, "newText": "XY"}]
        self.assertEqual(lsp.apply_text_edits(text, edits), "aXYdef")

    def test_apply_text_edits_multiple_ordering(self):
        text = "one two\n"
        edits = [
            {"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3}}, "newText": "1"},
            {"range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 7}}, "newText": "2"},
        ]
        self.assertEqual(lsp.apply_text_edits(text, edits), "1 2\n")

    def test_snippet(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "s.py")
            open(f, "w").write("a\nb\nc\nd\n")
            self.assertEqual(lsp.snippet(f, 2, 1), "1: a\n2: b\n3: c")

    def test_flatten_symbols_document_and_workspace(self):
        doc = [{"name": "C", "kind": 5, "selectionRange": {"start": {"line": 1, "character": 0}},
                "children": [{"name": "m", "kind": 6, "selectionRange": {"start": {"line": 2, "character": 2}}}]}]
        flat = lsp.flatten_symbols(doc)
        self.assertEqual(flat[0]["name"], "C")
        self.assertEqual(flat[0]["kind"], "class")
        self.assertEqual(flat[1], {"name": "m", "kind": "method", "line": 3, "col": 3, "container": "C"})
        ws = [{"name": "f", "kind": 12, "location": {"uri": lsp.path_to_uri("a.py"), "range": {"start": {"line": 0, "character": 4}}}}]
        self.assertEqual(lsp.flatten_symbols(ws)[0]["file"], "a.py")

    def test_summarize_edit(self):
        we = {"changes": {lsp.path_to_uri("a.py"): [{}, {}]}}
        self.assertEqual(lsp.summarize_edit(we), {"a.py": 2})
        we2 = {"documentChanges": [{"textDocument": {"uri": lsp.path_to_uri("b.py")}, "edits": [{}]}]}
        self.assertEqual(lsp.summarize_edit(we2), {"b.py": 1})

    def test_hover_text(self):
        self.assertEqual(lsp.hover_text({"contents": {"value": "hi"}}), "hi")
        self.assertEqual(lsp.hover_text({"contents": [{"value": "a"}, {"value": "b"}]}), "a\nb")
        self.assertEqual(lsp.hover_text(None), "")


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.server = os.path.join(self.tmp, "fakeserver.py")
        open(self.server, "w").write(FAKE_SERVER)
        self.sample = os.path.join(self.tmp, "sample.py")
        open(self.sample, "w").write("def greet(name):\n    return name\n\nx = greet(undefined_var)\n")

    def _run(self, *args):
        env = dict(os.environ, LSP_SERVER_CMD=f"{sys.executable} {self.server}")
        return subprocess.run([sys.executable, LSP_PY, *args], cwd=self.tmp, env=env,
                              capture_output=True, text=True)

    def _json(self, *args):
        r = self._run(*args)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_diagnostics(self):
        data = self._json("diagnostics", "sample.py", "--timeout", "8")
        d = data["files"][0]["diagnostics"][0]
        self.assertEqual((d["line"], d["severity"]), (4, "error"))

    def test_fail_on_error_exit_code(self):
        r = self._run("diagnostics", "sample.py", "--fail-on-error", "--timeout", "8")
        self.assertEqual(r.returncode, 1)

    def test_definition_has_context(self):
        d = self._json("definition", "sample.py", "4", "11", "--timeout", "8")
        loc = d["definitions"][0]
        self.assertEqual((loc["file"], loc["line"], loc["col"]), ("sample.py", 1, 5))
        self.assertIn("def greet", loc["context"])  # source snippet included

    def test_definition_by_symbol(self):
        d = self._json("definition", "sample.py", "4", "--symbol", "greet", "--timeout", "8")
        self.assertEqual(d["definitions"][0]["line"], 1)

    def test_type_definition_and_implementation(self):
        self.assertEqual(self._json("type-definition", "sample.py", "4", "11")["typeDefinitions"][0]["line"], 1)
        self.assertEqual(self._json("implementation", "sample.py", "4", "11")["implementations"][0]["line"], 1)

    def test_references(self):
        d = self._json("references", "sample.py", "1", "5", "--timeout", "8")
        self.assertEqual(len(d["references"]), 2)

    def test_hover(self):
        self.assertEqual(self._json("hover", "sample.py", "1", "5")["hover"], "the symbol")

    def test_document_symbols(self):
        d = self._json("symbols", "sample.py")
        self.assertEqual(d["symbols"][0], {"name": "greet", "kind": "function", "line": 1, "col": 5, "container": None})

    def test_workspace_symbols(self):
        d = self._json("symbols", "sample.py", "--query", "greet")
        self.assertEqual(d["workspaceSymbols"][0]["name"], "greet")

    def test_rename_preview_then_apply(self):
        prev = self._json("rename", "sample.py", "1", "5", "--new-name", "hello", "--preview")
        self.assertEqual(prev["preview"], {"sample.py": 2})
        self.assertIn("def greet", open(self.sample).read())  # preview did not modify
        applied = self._json("rename", "sample.py", "1", "5", "--new-name", "hello")
        self.assertEqual(applied["files"], {"sample.py": 2})
        txt = open(self.sample).read()
        self.assertIn("def hello(name)", txt)
        self.assertIn("x = hello(", txt)

    def test_code_actions_list_then_apply(self):
        listed = self._json("code-actions", "sample.py", "1", "1")
        self.assertEqual(listed["actions"][0]["title"], "Add header")
        applied = self._json("code-actions", "sample.py", "1", "1", "--apply", "Add header")
        self.assertEqual(applied["files"], {"sample.py": 1})
        self.assertTrue(open(self.sample).read().startswith("# fixed\n"))

    def test_missing_server_is_graceful(self):
        env = dict(os.environ)
        env.pop("LSP_SERVER_CMD", None)
        env["LSP_SERVER_PY"] = "definitely-not-a-real-server-xyz"
        r = subprocess.run([sys.executable, LSP_PY, "diagnostics", "sample.py"],
                           cwd=self.tmp, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no language server installed", json.loads(r.stdout)["files"][0]["error"])


if __name__ == "__main__":
    unittest.main()
