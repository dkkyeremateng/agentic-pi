"""Workspace-scoped file tools for the deep research agent.

Every tool here operates on PLAIN filenames (e.g. ``query.md``,
``final_report.md``) that are auto-mapped into the single per-process run folder
(see ``config.get_run_dir``). Agents stay unaware of the run folder and never
pass paths: names must be flat (no directory separators, no ``..``, no absolute
paths). Subfolders are never created inside the run folder.

Free-text output is bounded with ``truncate_output`` so a large file cannot
flood the model's context window.
"""

import os
import re

from langchain_core.tools import tool

from deep_research_agent.config import get_run_dir
from deep_research_agent.tools.truncate import truncate_output


class WorkspacePathError(ValueError):
    """Raised when a filename escapes the flat run folder."""


def _resolve(filename: str):
    """Map a plain filename into the run folder, rejecting anything unsafe.

    Rejects absolute paths, path separators, ``..`` traversal, and empty names
    so a tool call can only ever touch a flat file directly inside the run
    folder. Returns the absolute ``Path`` on success; raises
    ``WorkspacePathError`` otherwise (callers turn this into an error string).
    """
    if not filename or not isinstance(filename, str):
        raise WorkspacePathError("filename must be a non-empty string")
    name = filename.strip()
    if not name:
        raise WorkspacePathError("filename must not be blank")
    if os.path.isabs(name) or name.startswith("~"):
        raise WorkspacePathError(
            f"filename must be a plain name, not an absolute path: {filename!r}"
        )
    # Any separator, drive, or traversal component is rejected — flat names only.
    if "/" in name or "\\" in name or os.path.basename(name) != name or ".." in name:
        raise WorkspacePathError(
            f"filename must be a flat name with no folders or '..': {filename!r}"
        )
    return get_run_dir() / name


@tool
def write_workspace_file(filename: str, content: str) -> str:
    """Write ``content`` to a file in the workspace.

    Args:
        filename: A plain file name (e.g. "final_report.md"). No folders.
        content: Text content to write.
    """
    try:
        path = _resolve(filename)
    except WorkspacePathError as e:
        return f"Error: {e}"
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        return f"Error writing file: {e}"
    return f"Wrote {len(content)} bytes to {filename}"


@tool
def read_workspace_file(
    filename: str, start_line: int | None = None, end_line: int | None = None
) -> str:
    """Read a file from the workspace, optionally a line range.

    Args:
        filename: A plain file name (e.g. "query.md"). No folders.
        start_line: 1-based first line to return (inclusive). Optional.
        end_line: 1-based last line to return (inclusive). Optional.
    """
    try:
        path = _resolve(filename)
    except WorkspacePathError as e:
        return f"Error: {e}"
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return f"Error: file not found: {filename}"
    except OSError as e:
        return f"Error reading file: {e}"

    if start_line is not None or end_line is not None:
        lines = text.splitlines()
        lo = (start_line - 1) if start_line and start_line > 0 else 0
        hi = end_line if end_line is not None else len(lines)
        text = "\n".join(lines[lo:hi])
    return truncate_output(text)


@tool
def list_workspace_files() -> str:
    """List the files in the workspace (flat; the run folder only)."""
    run_dir = get_run_dir()
    try:
        entries = sorted(
            p.name for p in run_dir.iterdir() if p.is_file()
        )
    except OSError as e:
        return f"Error listing files: {e}"
    if not entries:
        return "(workspace is empty)"
    return truncate_output("\n".join(entries))


@tool
def grep_workspace_file(pattern: str, filename: str, max_matches: int = 100) -> str:
    """Search one workspace file's contents for a regex pattern.

    Args:
        pattern: Regular expression to search for.
        filename: A plain file name to search within. No folders.
        max_matches: Stop after this many matching lines (default 100).
    """
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"Error: invalid regex: {e}"
    try:
        path = _resolve(filename)
    except WorkspacePathError as e:
        return f"Error: {e}"
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return f"Error: file not found: {filename}"
    except OSError as e:
        return f"Error reading file: {e}"

    matches = []
    for lineno, line in enumerate(lines, 1):
        if rx.search(line):
            matches.append(f"{filename}:{lineno}: {line.rstrip()}")
            if len(matches) >= max_matches:
                matches.append(f"... [stopped at {max_matches} matches]")
                break
    return truncate_output("\n".join(matches)) if matches else "(no matches)"
