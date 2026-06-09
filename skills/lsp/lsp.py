#!/usr/bin/env python3
"""lsp.py — Language Server Protocol client (stdlib only).

Talks to a language server over stdio (JSON-RPC) for code intelligence: DIAGNOSTICS
(type/compile errors), NAVIGATION (definition, type_definition, implementation,
references, hover), SYMBOLS (document + workspace), and EDITS (rename, code_actions).
Used by the workflow agents via the `lsp` skill.

Servers are auto-detected from the file extension and the project root is found from
root markers (go.mod, tsconfig.json, composer.json, pyproject.toml, …). Install the
server yourself; the client degrades gracefully when one is missing.

  TypeScript/JS  typescript-language-server --stdio   (.ts .tsx .js .jsx .mjs .cjs .mts .cts)
  Python         pyright-langserver --stdio, or pylsp (.py)
  Go             gopls serve                          (.go)
  PHP            intelephense --stdio, or phpactor    (.php)

Override per-extension with env LSP_SERVER_<EXT>="cmd args" (e.g. LSP_SERVER_PY).
Force one server for every file (tests) with LSP_SERVER_CMD="cmd args".

CLI positions are 1-based (line and column). For position-based commands you may give
the column, or `--symbol NAME` (resolve the column from the symbol on that line; use
NAME#N for the Nth occurrence). Output is JSON on stdout; pipe to jq.
"""
from __future__ import annotations

import argparse
import fnmatch
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
# Each spec: cmd, rootMarkers (project-root detection), initOptions, settings (sent
# back for workspace/configuration and via didChangeConfiguration).
_TS = {
    "cmd": "typescript-language-server --stdio",
    "rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    "initOptions": {
        "hostInfo": "pi-lsp",
        "preferences": {"includeInlayParameterNameHints": "all"},
    },
}
_PYRIGHT = {
    "cmd": "pyright-langserver --stdio",
    "rootMarkers": ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt", "Pipfile", ".git"],
}
_PYLSP = {
    "cmd": "pylsp",
    "rootMarkers": ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt", "Pipfile", ".git"],
}
_GOPLS = {
    "cmd": "gopls serve",
    "rootMarkers": ["go.mod", "go.work", "go.sum", ".git"],
    "settings": {"gopls": {"staticcheck": True, "analyses": {"unusedparams": True, "shadow": True}, "gofumpt": True}},
}
_INTELEPHENSE = {"cmd": "intelephense --stdio", "rootMarkers": ["composer.json", ".git"]}
_PHPACTOR = {"cmd": "phpactor language-server", "rootMarkers": ["composer.json", ".git"]}

_TS_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]
EXT_SERVERS: dict[str, list[dict]] = {
    **{e: [_TS] for e in _TS_EXTS},
    "py": [_PYRIGHT, _PYLSP],
    "go": [_GOPLS],
    "php": [_INTELEPHENSE, _PHPACTOR],
}
LANGUAGE_ID = {
    "ts": "typescript", "mts": "typescript", "cts": "typescript",
    "tsx": "typescriptreact", "js": "javascript", "mjs": "javascript",
    "cjs": "javascript", "jsx": "javascriptreact",
    "py": "python", "go": "go", "php": "php",
}
SEVERITY = {1: "error", 2: "warning", 3: "info", 4: "hint"}
SYMBOL_KIND = {
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
    7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
    12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
    17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null",
    22: "enum-member", 23: "struct", 24: "event", 25: "operator", 26: "type-parameter",
}
_TIMEOUT = object()


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(msg, file=sys.stderr)
    sys.exit(2)


def ext_of(path: str) -> str:
    return os.path.splitext(path)[1].lstrip(".").lower()


def resolve_spec(path: str) -> dict | None:
    """The server spec (dict with cmd/rootMarkers/initOptions/settings) for `path`."""
    forced = os.environ.get("LSP_SERVER_CMD")
    if forced:
        return {"cmd": forced, "rootMarkers": [], "initOptions": {}, "settings": {}}
    ext = ext_of(path)
    override = os.environ.get(f"LSP_SERVER_{ext.upper()}")
    if override:
        if not shutil.which(shlex.split(override)[0]):
            return None  # bogus override -> degrade gracefully, don't crash
        base = (EXT_SERVERS.get(ext) or [{}])[0]
        return {**base, "cmd": override}
    for spec in EXT_SERVERS.get(ext, []):
        if shutil.which(shlex.split(spec["cmd"])[0]):
            return spec
    return None


def find_root(path: str, markers: list[str]) -> str:
    """Nearest ancestor dir of `path` containing a root marker; cwd as fallback."""
    cur = os.path.dirname(os.path.abspath(path))
    markers = list(markers) + [".git"]
    while True:
        try:
            entries = os.listdir(cur)
        except OSError:
            entries = []
        for m in markers:
            if ("*" in m or "?" in m):
                if any(fnmatch.fnmatch(n, m) for n in entries):
                    return cur
            elif os.path.exists(os.path.join(cur, m)):
                return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return os.getcwd()
        cur = parent


# ── Project server detection (for `lsp servers`) ─────────────────────────────────
_SCAN_SKIP = {
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next",
    "out", "target", "vendor", ".agent", ".pi", ".git",
}


def scan_exts(root: str, max_depth: int = 2) -> set[str]:
    """Extensions some server handles that are present within `root` (shallow walk).

    Bounded to `max_depth` levels and skips heavy/generated dirs so it stays cheap
    enough to run at session start. Stops early once every known ext is seen.
    """
    found: set[str] = set()
    root = os.path.abspath(root)
    base = root.rstrip(os.sep).count(os.sep)
    for cur, dirs, files in os.walk(root):
        depth = cur.rstrip(os.sep).count(os.sep) - base
        dirs[:] = [] if depth >= max_depth else [
            d for d in dirs if d not in _SCAN_SKIP and not d.startswith(".")
        ]
        for f in files:
            e = ext_of(f)
            if e in EXT_SERVERS:
                found.add(e)
                if len(found) == len(EXT_SERVERS):
                    return found
    return found


def server_groups() -> list[dict]:
    """Group extensions that share the same candidate-server list, input order kept."""
    order: list[tuple] = []
    groups: dict[tuple, dict] = {}
    for ext, specs in EXT_SERVERS.items():
        key = tuple(s["cmd"] for s in specs)
        if key not in groups:
            groups[key] = {"exts": [], "specs": specs}
            order.append(key)
        groups[key]["exts"].append(ext)
    return [groups[k] for k in order]


def _bin_name(cmd: str) -> str:
    return os.path.basename(shlex.split(cmd)[0]) if cmd else ""


def detect_servers(root: str, show_all: bool = False) -> list[dict]:
    """Servers relevant to `root` (or all, with show_all) + whether each is installed.

    A group is relevant when the project actually contains a file it handles. For
    each group we report the installed candidate (honoring an LSP_SERVER_<EXT>
    override), or fall back to the first candidate's name when none is on PATH.
    """
    present = set(EXT_SERVERS) if show_all else scan_exts(root)
    result: list[dict] = []
    for g in server_groups():
        exts, specs = g["exts"], g["specs"]
        here = sorted(set(exts) & present)
        if not here:
            continue
        override = next(
            (os.environ.get(f"LSP_SERVER_{e.upper()}") for e in exts
             if os.environ.get(f"LSP_SERVER_{e.upper()}")),
            None,
        )
        installed_cmd = None
        if override and shutil.which(shlex.split(override)[0]):
            installed_cmd = override
        else:
            installed_cmd = next(
                (s["cmd"] for s in specs if shutil.which(shlex.split(s["cmd"])[0])),
                None,
            )
        primary = installed_cmd or (specs[0]["cmd"] if specs else "")
        result.append({
            "server": _bin_name(primary),
            "extensions": ["." + e for e in here],
            "installed": installed_cmd is not None,
            "cmd": installed_cmd,
            "candidates": [_bin_name(s["cmd"]) for s in specs],
        })
    return result


def path_to_uri(path: str) -> str:
    return "file://" + pathname2url(os.path.abspath(path))


def uri_to_path(uri: str) -> str:
    try:
        return os.path.relpath(url2pathname(urlparse(uri).path), os.getcwd())
    except Exception:
        return uri


def read_lines(path: str) -> list[str]:
    try:
        return open(path, "r", encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return []


def snippet(path: str, line1: int, ctx: int = 1) -> str:
    lines = read_lines(path)
    if not lines:
        return ""
    i = line1 - 1
    lo, hi = max(0, i - ctx), min(len(lines), i + ctx + 1)
    return "\n".join(f"{n + 1}: {lines[n]}" for n in range(lo, hi))


def resolve_position(path: str, line1: int, col: int | None, symbol: str | None):
    """(line, character) 0-based, from an explicit column or a --symbol on the line."""
    if symbol:
        name, occ = symbol, 1
        if "#" in symbol:
            name, _, n = symbol.rpartition("#")
            occ = int(n) if n.isdigit() else 1
        lines = read_lines(path)
        if line1 - 1 >= len(lines):
            die(f"line {line1} is past end of {path}")
        text = lines[line1 - 1]
        idx = -1
        for _ in range(occ):
            idx = text.find(name, idx + 1)
            if idx < 0:
                die(f"symbol {symbol!r} not found on {path}:{line1}")
        return line1 - 1, idx
    if col is None:
        die("provide a column, or --symbol")
    return line1 - 1, col - 1


# ── WorkspaceEdit application ────────────────────────────────────────────────────
def _pos_to_offset(text: str, line: int, char: int) -> int:
    idx = 0
    for _ in range(line):
        nl = text.find("\n", idx)
        if nl < 0:
            return len(text)
        idx = nl + 1
    return min(len(text), idx + char)


def apply_text_edits(text: str, edits: list[dict]) -> str:
    spans = []
    for e in edits:
        s = _pos_to_offset(text, e["range"]["start"]["line"], e["range"]["start"]["character"])
        en = _pos_to_offset(text, e["range"]["end"]["line"], e["range"]["end"]["character"])
        spans.append((s, en, e.get("newText", "")))
    for s, en, nt in sorted(spans, key=lambda x: x[0], reverse=True):
        text = text[:s] + nt + text[en:]
    return text


def workspace_edit_docs(we: dict) -> list[tuple[str, list]]:
    """[(uri, edits)] from a WorkspaceEdit (changes or documentChanges)."""
    if we.get("documentChanges"):
        return [
            (dc["textDocument"]["uri"], dc["edits"])
            for dc in we["documentChanges"]
            if "textDocument" in dc and "edits" in dc
        ]
    return list((we.get("changes") or {}).items())


def summarize_edit(we: dict) -> dict:
    return {uri_to_path(uri): len(edits) for uri, edits in workspace_edit_docs(we)}


def apply_workspace_edit(we: dict) -> dict:
    changed = {}
    for uri, edits in workspace_edit_docs(we):
        p = uri_to_path(uri)
        try:
            text = open(p, "r", encoding="utf-8").read()
        except OSError:
            continue
        open(p, "w", encoding="utf-8").write(apply_text_edits(text, edits))
        changed[p] = len(edits)
    return changed


CAPABILITIES = {
    "textDocument": {
        "synchronization": {"didSave": True, "dynamicRegistration": False},
        "publishDiagnostics": {"relatedInformation": True},
        "definition": {"linkSupport": True},
        "typeDefinition": {"linkSupport": True},
        "implementation": {"linkSupport": True},
        "references": {},
        "hover": {"contentFormat": ["markdown", "plaintext"]},
        "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
        "rename": {"prepareSupport": False},
        "codeAction": {},
    },
    "workspace": {
        "workspaceFolders": True,
        "configuration": True,
        "symbol": {},
        "applyEdit": True,
    },
    "window": {"workDoneProgress": True},
}


class LSP:
    """One-shot client: start a server, query it, shut it down."""

    def __init__(self, cmd: str):
        self.proc = subprocess.Popen(
            shlex.split(cmd),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self._id = 0
        self._responses: dict[int, dict] = {}
        self.diagnostics: dict[str, list] = {}
        self.settings: dict = {}
        self._q: "queue.Queue" = queue.Queue()
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self) -> None:
        f = self.proc.stdout
        assert f is not None
        while True:
            headers: dict[bytes, bytes] = {}
            line = f.readline()
            if not line:
                self._q.put(None)
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
            result = [self.settings.get(it.get("section", ""), {}) for it in items]
        elif method == "workspace/applyEdit":
            result = {"applied": False}
        else:
            result = None
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

    def initialize(self, root_path: str, init_options=None, settings=None, timeout: float = 20.0):
        self.settings = settings or {}
        params = {
            "processId": os.getpid(),
            "clientInfo": {"name": "pi-lsp", "version": "1"},
            "rootUri": path_to_uri(root_path),
            "rootPath": root_path,
            "workspaceFolders": [{"uri": path_to_uri(root_path), "name": os.path.basename(root_path) or "root"}],
            "capabilities": CAPABILITIES,
        }
        if init_options:
            params["initializationOptions"] = init_options
        result, err = self.request("initialize", params, timeout)
        if err:
            return err
        self.notify("initialized", {})
        if self.settings:
            self.notify("workspace/didChangeConfiguration", {"settings": self.settings})
        return None

    def did_open(self, path: str) -> bool:
        try:
            text = open(path, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            return False
        self.notify("textDocument/didOpen", {"textDocument": {
            "uri": path_to_uri(path),
            "languageId": LANGUAGE_ID.get(ext_of(path), ext_of(path)),
            "version": 1, "text": text,
        }})
        return True

    def collect_diagnostics(self, paths: list[str], timeout: float) -> None:
        uris = [path_to_uri(p) for p in paths if self.did_open(p)]
        deadline = time.time() + timeout
        settle, last = 0.6, 0.0
        while time.time() < deadline:
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
            if isinstance(msg, dict) and msg.get("method") == "textDocument/publishDiagnostics":
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
        "line": s.get("line", 0) + 1, "col": s.get("character", 0) + 1,
        "endLine": e.get("line", 0) + 1, "endCol": e.get("character", 0) + 1,
        "code": d.get("code"), "source": d.get("source"),
        "message": d.get("message", "").strip(),
    }


def norm_locations(result, with_context: bool = True) -> list[dict]:
    if not result:
        return []
    items = result if isinstance(result, list) else [result]
    out = []
    for it in items:
        uri = it.get("uri") or it.get("targetUri")
        rng = it.get("range") or it.get("targetSelectionRange") or it.get("targetRange") or {}
        s = rng.get("start", {})
        file = uri_to_path(uri) if uri else None
        line = s.get("line", 0) + 1
        loc = {"file": file, "line": line, "col": s.get("character", 0) + 1}
        if with_context and file:
            ctx = snippet(file, line)
            if ctx:
                loc["context"] = ctx
        out.append(loc)
    return out


def flatten_symbols(syms, container: str = "") -> list[dict]:
    out = []
    for s in syms or []:
        kind = SYMBOL_KIND.get(s.get("kind"), str(s.get("kind")))
        if "location" in s:  # SymbolInformation (workspace/symbol)
            loc = s["location"]
            st = loc.get("range", {}).get("start", {})
            out.append({"name": s.get("name"), "kind": kind, "file": uri_to_path(loc.get("uri", "")),
                        "line": st.get("line", 0) + 1, "col": st.get("character", 0) + 1,
                        "container": s.get("containerName") or container or None})
        else:  # DocumentSymbol
            st = (s.get("selectionRange") or s.get("range") or {}).get("start", {})
            out.append({"name": s.get("name"), "kind": kind,
                        "line": st.get("line", 0) + 1, "col": st.get("character", 0) + 1,
                        "container": container or None})
            if s.get("children"):
                out += flatten_symbols(s["children"], (container + "." if container else "") + s.get("name", ""))
    return out


def hover_text(result) -> str:
    if not result:
        return ""
    contents = result.get("contents", result)
    if isinstance(contents, dict):
        return (contents.get("value") or "").strip()
    if isinstance(contents, list):
        return "\n".join((c.get("value") if isinstance(c, dict) else str(c)) for c in contents if c).strip()
    return str(contents).strip()


def changed_files() -> list[str]:
    def git(args):
        try:
            r = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
            return r.stdout.split() if r.returncode == 0 else []
        except Exception:
            return []
    files = git(["diff", "--name-only", "HEAD"]) + git(["ls-files", "--others", "--exclude-standard"])
    return sorted({f for f in files if ext_of(f) in EXT_SERVERS and os.path.isfile(f)})


def out(data) -> None:
    print(json.dumps(data, indent=2))


# ── Commands ────────────────────────────────────────────────────────────────────
def cmd_servers(a) -> None:
    root = os.path.abspath(a.path or ".")
    out({"root": root, "servers": detect_servers(root, show_all=a.all)})


def cmd_diagnostics(a) -> None:
    files = list(a.files)
    if a.changed or not files:
        files = (files or []) + changed_files()
    files = sorted({f for f in files if f})
    if not files:
        out({"files": [], "note": "no files (pass paths or use --changed)"})
        return

    groups: dict[tuple, dict] = {}
    results: list[dict] = []
    for f in files:
        if not os.path.isfile(f):
            results.append({"file": f, "error": "file not found"})
            continue
        spec = resolve_spec(f)
        if not spec:
            ext = ext_of(f)
            cands = ", ".join(s["cmd"] for s in EXT_SERVERS.get(ext, [])) or "none"
            results.append({"file": f, "error": f"no language server installed for .{ext} (candidates: {cands})"})
            continue
        root = find_root(f, spec.get("rootMarkers", []))
        groups.setdefault((spec["cmd"], root), {"spec": spec, "root": root, "files": []})["files"].append(f)

    any_error = False
    for (cmd, root), g in groups.items():
        client = LSP(cmd)
        try:
            err = client.initialize(root, g["spec"].get("initOptions"), g["spec"].get("settings"))
            if err:
                for p in g["files"]:
                    results.append({"file": p, "error": f"server init failed: {err.get('message')}"})
                continue
            client.collect_diagnostics(g["files"], a.timeout)
            for p in g["files"]:
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


def _on_file(path: str):
    """Start + initialize a client for `path`, opened. Returns (client, uri)."""
    if not os.path.isfile(path):
        die(f"file not found: {path}")
    spec = resolve_spec(path)
    if not spec:
        die(f"no language server installed for .{ext_of(path)}")
    root = find_root(path, spec.get("rootMarkers", []))
    client = LSP(spec["cmd"])
    err = client.initialize(root, spec.get("initOptions"), spec.get("settings"))
    if err:
        client.shutdown()
        die(f"server init failed: {err.get('message')}")
    client.did_open(path)
    time.sleep(0.3)  # let the server index the freshly opened doc
    return client, path_to_uri(path)


def _position_request(a, method: str, extra=None):
    client, uri = _on_file(a.file)
    try:
        line0, char0 = resolve_position(a.file, a.line, a.col, a.symbol)
        params = {"textDocument": {"uri": uri}, "position": {"line": line0, "character": char0}}
        if extra:
            params.update(extra)
        result, err = client.request(method, params, a.timeout)
        if err:
            die(f"{method} failed: {err.get('message')}")
        return result
    finally:
        client.shutdown()


def cmd_definition(a):
    out({"definitions": norm_locations(_position_request(a, "textDocument/definition"))})


def cmd_type_definition(a):
    out({"typeDefinitions": norm_locations(_position_request(a, "textDocument/typeDefinition"))})


def cmd_implementation(a):
    out({"implementations": norm_locations(_position_request(a, "textDocument/implementation"))})


def cmd_references(a):
    res = _position_request(a, "textDocument/references", {"context": {"includeDeclaration": True}})
    out({"references": norm_locations(res)})


def cmd_hover(a):
    out({"hover": hover_text(_position_request(a, "textDocument/hover"))})


def cmd_symbols(a):
    client, uri = _on_file(a.file)
    try:
        if a.query:
            res, err = client.request("workspace/symbol", {"query": a.query}, a.timeout)
            label = "workspaceSymbols"
        else:
            res, err = client.request("textDocument/documentSymbol", {"textDocument": {"uri": uri}}, a.timeout)
            label = "symbols"
        if err:
            die(f"symbols failed: {err.get('message')}")
        out({label: flatten_symbols(res)})
    finally:
        client.shutdown()


def cmd_code_actions(a):
    client, uri = _on_file(a.file)
    try:
        line0, char0 = resolve_position(a.file, a.line, a.col, a.symbol)
        rng = {"start": {"line": line0, "character": char0}, "end": {"line": line0, "character": char0}}
        diags = client.diagnostics.get(uri, [])
        res, err = client.request(
            "textDocument/codeAction",
            {"textDocument": {"uri": uri}, "range": rng, "context": {"diagnostics": diags}},
            a.timeout,
        )
        if err:
            die(f"code_actions failed: {err.get('message')}")
        actions = res or []
        if not a.apply:
            out({"actions": [{"index": i, "title": ac.get("title"), "kind": ac.get("kind")} for i, ac in enumerate(actions)]})
            return
        sel = a.apply
        chosen = None
        for i, ac in enumerate(actions):
            if sel == str(i) or sel.lower() in (ac.get("title", "").lower()):
                chosen = ac
                break
        if chosen is None:
            die(f"no code action matched {sel!r}; available: {[ac.get('title') for ac in actions]}")
        if "edit" not in chosen and "command" not in chosen:
            resolved, rerr = client.request("codeAction/resolve", chosen, a.timeout)
            if not rerr and resolved:
                chosen = resolved
        applied = apply_workspace_edit(chosen["edit"]) if chosen.get("edit") else {}
        cmd_obj = chosen.get("command") if isinstance(chosen.get("command"), dict) else None
        if cmd_obj:
            client.request("workspace/executeCommand",
                           {"command": cmd_obj.get("command"), "arguments": cmd_obj.get("arguments", [])}, a.timeout)
        out({"applied": chosen.get("title"), "files": applied})
    finally:
        client.shutdown()


def cmd_rename(a):
    client, uri = _on_file(a.file)
    try:
        line0, char0 = resolve_position(a.file, a.line, a.col, a.symbol)
        res, err = client.request(
            "textDocument/rename",
            {"textDocument": {"uri": uri}, "position": {"line": line0, "character": char0}, "newName": a.new_name},
            a.timeout,
        )
        if err:
            die(f"rename failed: {err.get('message')}")
        we = res or {}
        if a.preview:
            out({"preview": summarize_edit(we), "new_name": a.new_name})
        else:
            out({"renamed_to": a.new_name, "files": apply_workspace_edit(we)})
    finally:
        client.shutdown()


def _add_position_args(s, with_apply=False, with_rename=False):
    s.add_argument("file")
    s.add_argument("line", type=int, help="1-based line")
    s.add_argument("col", type=int, nargs="?", help="1-based column (or use --symbol)")
    s.add_argument("--symbol", help="symbol on the line to resolve the column from (NAME or NAME#N)")
    s.add_argument("--timeout", type=float, default=15.0)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="lsp.py", description="LSP client: diagnostics, navigation, symbols, edits (stdlib only)."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("servers", help="Language servers relevant to the project + install status")
    s.add_argument("path", nargs="?", default=".", help="project root (default: cwd)")
    s.add_argument("--all", action="store_true", help="list all known servers, not just relevant ones")
    s.set_defaults(fn=cmd_servers)

    s = sub.add_parser("diagnostics", help="Type/compile diagnostics for files")
    s.add_argument("files", nargs="*")
    s.add_argument("--changed", action="store_true", help="files changed vs HEAD + untracked")
    s.add_argument("--errors-only", action="store_true")
    s.add_argument("--fail-on-error", action="store_true")
    s.add_argument("--timeout", type=float, default=15.0)
    s.set_defaults(fn=cmd_diagnostics)

    for name, fn, helptext in (
        ("definition", cmd_definition, "Go to definition"),
        ("type-definition", cmd_type_definition, "Go to type definition"),
        ("implementation", cmd_implementation, "Find implementations"),
        ("references", cmd_references, "Find references"),
        ("hover", cmd_hover, "Type/signature/docs"),
    ):
        s = sub.add_parser(name, help=helptext)
        _add_position_args(s)
        s.set_defaults(fn=fn)

    s = sub.add_parser("symbols", help="Document symbols (or workspace search with --query)")
    s.add_argument("file")
    s.add_argument("--query", help="workspace symbol search query")
    s.add_argument("--timeout", type=float, default=15.0)
    s.set_defaults(fn=cmd_symbols)

    s = sub.add_parser("code-actions", help="List quick-fixes/refactors; --apply to apply one")
    _add_position_args(s)
    s.add_argument("--apply", metavar="INDEX|TITLE", help="apply the matching action (default: list)")
    s.set_defaults(fn=cmd_code_actions)

    s = sub.add_parser("rename", help="Rename a symbol across the codebase")
    _add_position_args(s)
    s.add_argument("--new-name", required=True)
    s.add_argument("--preview", action="store_true", help="show the edits instead of applying")
    s.set_defaults(fn=cmd_rename)

    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.fn(args)
