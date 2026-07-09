"""Tests for run-folder isolation and the workspace-scoped file tools.

Every file tool must auto-map plain filenames into ONE shared run folder and
reject anything that would escape it (traversal, absolute paths, subfolders).
The run folder is a stable per-process singleton so the fetch->read data-flow
contract holds.
"""

import pytest

from deep_research_agent import config
from deep_research_agent.tools import workspace, todos


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    """Point the run-folder singleton at an isolated tmp dir per test."""
    monkeypatch.setattr(config, "_RUN_DIR", tmp_path)
    yield tmp_path
    config.reset_run_dir()


# ── run-folder singleton ──

def test_get_run_dir_is_stable_singleton(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "_RUN_DIR", None)
    ws_cfg = {"settings": {"workspace": {"dir": str(tmp_path), "session_isolation": True}}}
    monkeypatch.setattr(config, "ensure_config", lambda: ws_cfg)
    first = config.get_run_dir()
    second = config.get_run_dir()
    assert first == second
    assert first.exists()
    config.reset_run_dir()


def test_get_workspace_dir_delegates_to_run_dir(run_dir):
    assert config.get_workspace_dir() == run_dir


# ── _resolve safety ──

def test_resolve_maps_plain_name(run_dir):
    assert workspace._resolve("query.md") == run_dir / "query.md"


def test_resolve_rejects_traversal(run_dir):
    with pytest.raises(workspace.WorkspacePathError):
        workspace._resolve("../escape.md")


def test_resolve_rejects_absolute(run_dir):
    with pytest.raises(workspace.WorkspacePathError):
        workspace._resolve("/etc/passwd")


def test_resolve_rejects_subfolder(run_dir):
    with pytest.raises(workspace.WorkspacePathError):
        workspace._resolve("sub/file.md")
    with pytest.raises(workspace.WorkspacePathError):
        workspace._resolve("sub\\file.md")


# ── write/read round-trip ──

def test_write_read_roundtrip(run_dir):
    out = workspace.write_workspace_file.invoke(
        {"filename": "notes.md", "content": "hello world"}
    )
    assert "notes.md" in out
    assert (run_dir / "notes.md").read_text() == "hello world"
    back = workspace.read_workspace_file.invoke({"filename": "notes.md"})
    assert back == "hello world"


def test_read_missing_file_errors(run_dir):
    out = workspace.read_workspace_file.invoke({"filename": "nope.md"})
    assert "not found" in out


def test_write_rejects_subfolder_no_dir_created(run_dir):
    out = workspace.write_workspace_file.invoke(
        {"filename": "a/b.md", "content": "x"}
    )
    assert out.startswith("Error")
    assert not (run_dir / "a").exists()


# ── line range ──

def test_read_line_range(run_dir):
    (run_dir / "multi.md").write_text("l1\nl2\nl3\nl4\nl5\n")
    out = workspace.read_workspace_file.invoke(
        {"filename": "multi.md", "start_line": 2, "end_line": 4}
    )
    assert out == "l2\nl3\nl4"


def test_read_truncates_large_output(run_dir):
    (run_dir / "big.md").write_text("x" * 50_000)
    out = workspace.read_workspace_file.invoke({"filename": "big.md"})
    assert "truncated" in out


# ── grep ──

def test_grep_finds_matches(run_dir):
    (run_dir / "doc.md").write_text("alpha\nbeta\nbeta again\n")
    out = workspace.grep_workspace_file.invoke(
        {"pattern": "beta", "filename": "doc.md"}
    )
    assert "beta" in out and "doc.md:2" in out


def test_grep_no_match(run_dir):
    (run_dir / "doc.md").write_text("alpha\n")
    assert workspace.grep_workspace_file.invoke(
        {"pattern": "zzz", "filename": "doc.md"}
    ) == "(no matches)"


def test_grep_invalid_regex(run_dir):
    (run_dir / "doc.md").write_text("alpha\n")
    out = workspace.grep_workspace_file.invoke(
        {"pattern": "[", "filename": "doc.md"}
    )
    assert "invalid regex" in out


# ── list ──

def test_list_workspace_files_flat(run_dir):
    (run_dir / "a.md").write_text("x")
    (run_dir / "b.md").write_text("y")
    (run_dir / "sub").mkdir()
    (run_dir / "sub" / "c.md").write_text("z")
    out = workspace.list_workspace_files.invoke({})
    assert "a.md" in out and "b.md" in out
    assert "sub" not in out.split("\n")  # only files, not the subdir


def test_list_empty(run_dir):
    assert workspace.list_workspace_files.invoke({}) == "(workspace is empty)"


# ── todos ──

def test_todos_roundtrip(run_dir):
    todos._TODOS.clear()
    workspace_out = todos.write_todos.invoke({"todos": ["find X", "verify Y"]})
    assert "2 todo" in workspace_out
    read = todos.read_todos.invoke({})
    assert "find X" in read and "verify Y" in read


def test_todos_empty(run_dir):
    todos._TODOS.clear()
    assert todos.read_todos.invoke({}) == "(no todos)"
