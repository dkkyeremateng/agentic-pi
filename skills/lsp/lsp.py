#!/usr/bin/env python3
"""lsp.py — minimal Language Server Protocol client (stdlib only).

Talks to a language server over stdio (JSON-RPC) to get DIAGNOSTICS (type/compile
errors) and code NAVIGATION (definition / references / hover) for the project in the
current working directory. Used by the workflow agents via the `lsp` skill.

Servers are auto-detected from the file extension. Install the server yourself; the
client degrades gracefully (a clear "not installed" note) when one is missing:

  TypeScript/JS  typescript-language-server --stdio   (.ts .tsx .js .jsx .mts .cts)
  Python         pyright-langserver --stdio, or pylsp (.py)
  Go             gopls                                 (.go)
  PHP            intelephense --stdio, or phpactor     (.php)

Override per-extension with env LSP_SERVER_<EXT>="cmd args" (e.g. LSP_SERVER_PY).
Force one server for every file (used by tests) with LSP_SERVER_CMD="cmd args".

CLI positions are 1-based (line and column), matching file:line citations. Output is
JSON on stdout; pipe to jq. Exit codes: 0 ok; 1 with --fail-on-error when an
error-severity diagnostic is found; 2 on a usage/internal error.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import shlex
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse
from urllib.request import pathname2url, url2pathname

# ── Server registry ─────────────────────────────────────────────────────────────
# ext -> ordered candidate commands; the first whose binary is on PATH is used.
SERVERS: dict[str, list[str]] = {
    "ts": ["typescript-language-server --stdio"],
    "tsx": ["typescript-language-server --stdio"],
    "js": ["typescript-language-server --stdio"],
    "jsx": ["typescript-language-server --stdio"],
    "mts": ["typescript-language-server --stdio"],
    "cts": ["typescript-language-server --stdio"],
    "py": ["pyright-langserver --stdio", "pylsp"],
    "go": ["gopls"],
    "php": ["intelephense --stdio", "phpactor language-server"],
}
LANGUAGE_ID = {
    "ts": "typescript", "mts": "typescript", "cts": "typescript",
    "tsx": "typescriptreact", "js": "javascript", "jsx": "javascriptreact",
    "py": "python", "go": "go", "php": "php",
}
SEVERITY = {1: "error", 2: "warning", 3: "info", 4: "hint"}
_TIMEOUT = object()  # sentinel: no message before the deadline


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(msg, file=sys.stderr)
    sys.exit(2)


def ext_of(path: str) -> str:
    return os.path.splitext(path)[1].lstrip(".").lower()


def resolve_server(path: str) -> str | None:
    """The server command to use for `path`, or None when none is installed."""
    forced = os.environ.get("LSP_SERVER_CMD")
    if forced:
        return forced
    ext = ext_of(path)
    override = os.environ.get(f"LSP_SERVER_{ext.upper()}")
    candidates = [override] if override else SERVERS.get(ext, [])
    for cmd in candidates:
        if cmd and shutil.which(shlex.split(cmd)[0]):
            return cmd
    return None


def path_to_uri(path: str) -> str:
    return "file://" + pathname2url(os.path.abspath(path))


def uri_to_path(uri: str) -> str:
    try:
        abs_path = url2pathname(urlparse(uri).path)
        return os.path.relpath(abs_path, os.getcwd())
    except Exception:
        return uri


def changed_files() -> list[str]:
    """Files changed vs HEAD plus untracked, limited to supported extensions."""
    def git(args: list[str]) -> list[str]:
        try:
            r = subprocess.run(
                ["git", *args], capture_output=True, text=True, check=False
            )
            return r.stdout.split() if r.returncode == 0 else []
        except Exception:
            return []

    files = git(["diff", "--name-only", "HEAD"]) + git(
        ["ls-files", "--others", "--exclude-standard"]
    )
    return sorted(
        {f for f in files if ext_of(f) in SERVERS and os.path.isfile(f)}
    )


CAPABILITIES = {
    "textDocument": {
        "synchronization": {"didSave": True, "dynamicRegistration": False},
        "publishDiagnostics": {"relatedInformation": True},
        "definition": {"linkSupport": True},
        "references": {},
        "hover": {"contentFormat": ["markdown", "plaintext"]},
    },
    "workspace": {"workspaceFolders": True, "configuration": True},
    "window": {"workDoneProgress": True},
}


class LSP:
    """A one-shot client: start a server, query it, shut it down."""

    def __init__(self, cmd: str):
        self.proc = subprocess.Popen(
            shlex.split(cmd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self._id = 0
        self._responses: dict[int, dict] = {}
        self.diagnostics: dict[str, list] = {}
        self._q: "queue.Queue" = queue.Queue()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # ── transport ──
    def _read_loop(self) -> None:
        f = self.proc.stdout
        assert f is not None
        while True:
            headers: dict[bytes, bytes] = {}
            line = f.readline()
            if not line:
                self._q.put(None)  # server closed
                return
            while line not in (b"\r\n", b"\n"):
                if not line:
                    self._q.put(None)
                    return
                k, _, v = line.partition(b":")
                headers[k.strip().lower()] = v.strip()
                line = f.readline()
            n = int(headers.get(b"content-length", b"0"))
            body = f.read(n) if n else b""
            try:
                self._q.put(json.loads(body))
            except Exception:
                continue

    def _send(self, obj: dict) -> None:
        data = json.dumps(obj).encode("utf-8")
        assert self.proc.stdin is not None
        self.proc.stdin.write(b"Content-Length: %d\r\n\r\n%s" % (len(data), data))
        self.proc.stdin.flush()

    def notify(self, method: str, params) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _answer_server_request(self, msg: dict) -> None:
        method = msg.get("method", "")
        if method == "workspace/configuration":
            items = msg.get("params", {}).get("items", [])
            result = [{} for _ in items]  # empty settings -> server defaults
        elif method == "workspace/applyEdit":
            result = {"applied": False}
        else:
            result = None  # registerCapability, *_refresh, progress/create, …
        self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def _dispatch(self, msg) -> str | None:
        if msg is None:
            return "closed"
        if "id" in msg and "method" in msg:
            self._answer_server_request(msg)
        elif "id" in msg:
            self._responses[msg["id"]] = msg
        elif msg.get("method") == "textDocument/publishDiagnostics":
            p = msg.get("params", {})
            self.diagnostics[p.get("uri", "")] = p.get("diagnostics", [])
            return "diagnostics"
        return None

    def _next(self, deadline: float):
        try:
            return self._q.get(timeout=max(0.0, deadline - time.time()))
        except queue.Empty:
            return _TIMEOUT

    def request(self, method: str, params, timeout: float):
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self._next(deadline)
            if msg is _TIMEOUT:
                break
            if self._dispatch(msg) == "closed":
                break
            if rid in self._responses:
                r = self._responses.pop(rid)
                return r.get("result"), r.get("error")
        return None, {"message": f"timeout after {timeout}s waiting for {method}"}

    # ── lifecycle ──
    def initialize(self, timeout: float = 20.0):
        root = os.getcwd()
        result, err = self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "clientInfo": {"name": "pi-lsp", "version": "1"},
                "rootUri": path_to_uri(root),
                "rootPath": root,
                "workspaceFolders": [
                    {"uri": path_to_uri(root), "name": os.path.basename(root) or "root"}
                ],
                "capabilities": CAPABILITIES,
            },
            timeout,
        )
        if err:
            return err
        self.notify("initialized", {})
        return None

    def did_open(self, path: str) -> bool:
        try:
            text = open(path, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            return False
        self.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": path_to_uri(path),
                    "languageId": LANGUAGE_ID.get(ext_of(path), ext_of(path)),
                    "version": 1,
                    "text": text,
                }
            },
        )
        return True

    def collect_diagnostics(self, paths: list[str], timeout: float) -> None:
        uris = []
        for p in paths:
            if self.did_open(p):
                uris.append(path_to_uri(p))
        deadline = time.time() + timeout
        settle = 0.6
        last = 0.0
        while time.time() < deadline:
            # Stop once every opened file has reported and things have gone quiet
            # (linters publish an empty set first, then the real one a beat later).
            if uris and all(u in self.diagnostics for u in uris):
                if last and time.time() - last > settle:
                    break
            msg = self._next(min(deadline, time.time() + settle))
            if msg is _TIMEOUT:
                if uris and all(u in self.diagnostics for u in uris):
                    break
                continue
            if self._dispatch(msg) == "closed":
                break
            if msg and msg.get("method") == "textDocument/publishDiagnostics":
                last = time.time()

    def shutdown(self) -> None:
        try:
            self.request("shutdown", None, 3)
            self.notify("exit", None)
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=2)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


# ── Formatting ──────────────────────────────────────────────────────────────────
def fmt_diagnostic(d: dict) -> dict:
    rng = d.get("range", {})
    s, e = rng.get("start", {}), rng.get("end", {})
    return {
        "severity": SEVERITY.get(d.get("severity", 1), "error"),
        "line": s.get("line", 0) + 1,
        "col": s.get("character", 0) + 1,
        "endLine": e.get("line", 0) + 1,
        "endCol": e.get("character", 0) + 1,
        "code": d.get("code"),
        "source": d.get("source"),
        "message": d.get("message", "").strip(),
    }


def norm_locations(result) -> list[dict]:
    if not result:
        return []
    items = result if isinstance(result, list) else [result]
    out = []
    for it in items:
        uri = it.get("uri") or it.get("targetUri")
        rng = (
            it.get("range")
            or it.get("targetSelectionRange")
            or it.get("targetRange")
            or {}
        )
        s = rng.get("start", {})
        out.append(
            {
                "file": uri_to_path(uri) if uri else None,
                "line": s.get("line", 0) + 1,
                "col": s.get("character", 0) + 1,
            }
        )
    return out


def hover_text(result) -> str:
    if not result:
        return ""
    contents = result.get("contents", result)
    if isinstance(contents, dict):
        return (contents.get("value") or "").strip()
    if isinstance(contents, list):
        parts = [
            (c.get("value") if isinstance(c, dict) else str(c)) for c in contents
        ]
        return "\n".join(p for p in parts if p).strip()
    return str(contents).strip()


def out(data) -> None:
    print(json.dumps(data, indent=2))


# ── Commands ────────────────────────────────────────────────────────────────────
def cmd_diagnostics(a) -> None:
    files = list(a.files)
    if a.changed or not files:
        files = (files or []) + changed_files()
    files = sorted({f for f in files if f})
    if not files:
        out({"files": [], "note": "no files (pass paths or use --changed)"})
        return

    # Group files by their resolved server command.
    groups: dict[str, list[str]] = {}
    missing: list[dict] = []
    for f in files:
        if not os.path.isfile(f):
            missing.append({"file": f, "error": "file not found"})
            continue
        cmd = resolve_server(f)
        if not cmd:
            ext = ext_of(f)
            missing.append(
                {
                    "file": f,
                    "error": f"no language server installed for .{ext} "
                    f"(candidates: {', '.join(SERVERS.get(ext, [])) or 'none'})",
                }
            )
            continue
        groups.setdefault(cmd, []).append(f)

    results: list[dict] = list(missing)
    any_error = False
    for cmd, paths in groups.items():
        client = LSP(cmd)
        try:
            err = client.initialize()
            if err:
                for p in paths:
                    results.append({"file": p, "error": f"server init failed: {err.get('message')}"})
                continue
            client.collect_diagnostics(paths, a.timeout)
            for p in paths:
                diags = [fmt_diagnostic(d) for d in client.diagnostics.get(path_to_uri(p), [])]
                if a.errors_only:
                    diags = [d for d in diags if d["severity"] == "error"]
                if any(d["severity"] == "error" for d in diags):
                    any_error = True
                results.append({"file": p, "server": cmd, "diagnostics": diags})
        finally:
            client.shutdown()

    results.sort(key=lambda r: r.get("file", ""))
    out({"files": results})
    if a.fail_on_error and any_error:
        sys.exit(1)


def _nav(a, method: str, extra_params=None):
    if not os.path.isfile(a.file):
        die(f"file not found: {a.file}")
    cmd = resolve_server(a.file)
    if not cmd:
        die(f"no language server installed for .{ext_of(a.file)}")
    client = LSP(cmd)
    try:
        err = client.initialize()
        if err:
            die(f"server init failed: {err.get('message')}")
        client.did_open(a.file)
        # Give the server a moment to index the freshly opened doc.
        time.sleep(0.3)
        params = {
            "textDocument": {"uri": path_to_uri(a.file)},
            "position": {"line": a.line - 1, "character": a.col - 1},
        }
        if extra_params:
            params.update(extra_params)
        result, rerr = client.request(method, params, a.timeout)
        if rerr:
            die(f"{method} failed: {rerr.get('message')}")
        return result
    finally:
        client.shutdown()


def cmd_definition(a) -> None:
    out({"definitions": norm_locations(_nav(a, "textDocument/definition"))})


def cmd_references(a) -> None:
    res = _nav(a, "textDocument/references", {"context": {"includeDeclaration": True}})
    out({"references": norm_locations(res)})


def cmd_hover(a) -> None:
    out({"hover": hover_text(_nav(a, "textDocument/hover"))})


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="lsp.py",
        description="Minimal LSP client: diagnostics + navigation (stdlib only).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("diagnostics", help="Type/compile diagnostics for files")
    s.add_argument("files", nargs="*", help="files to check (default: --changed)")
    s.add_argument("--changed", action="store_true", help="check files changed vs HEAD + untracked")
    s.add_argument("--errors-only", action="store_true", help="only severity=error")
    s.add_argument("--fail-on-error", action="store_true", help="exit 1 if any error")
    s.add_argument("--timeout", type=float, default=15.0)
    s.set_defaults(fn=cmd_diagnostics)

    for name, fn, helptext in (
        ("definition", cmd_definition, "Go to definition at file:line:col"),
        ("references", cmd_references, "Find references at file:line:col"),
        ("hover", cmd_hover, "Hover (type/docs) at file:line:col"),
    ):
        s = sub.add_parser(name, help=helptext)
        s.add_argument("file")
        s.add_argument("line", type=int, help="1-based line")
        s.add_argument("col", type=int, help="1-based column")
        s.add_argument("--timeout", type=float, default=15.0)
        s.set_defaults(fn=fn)

    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.fn(args)
