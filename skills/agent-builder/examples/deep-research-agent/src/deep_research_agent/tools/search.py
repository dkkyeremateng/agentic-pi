"""Code search tools: grep (file contents) and find (filenames).

Pure-Python and read-only, so they work cross-platform without shelling out
and need no approval gate. Both cap their results and skip common noise dirs.
"""

import fnmatch
import os
import re

from langchain_core.tools import tool

from deep_research_agent.tools.truncate import truncate_output

_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", ".mypy_cache"}


def _iter_files(path: str):
    """Yield file paths under ``path`` (or ``path`` itself if it is a file)."""
    if os.path.isfile(path):
        yield path
        return
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fname in files:
            yield os.path.join(root, fname)


@tool
def grep(pattern: str, path: str = ".", max_matches: int = 100) -> str:
    """Search file contents for a regex pattern (like ``grep -rn``).

    Args:
        pattern: Regular expression to search for.
        path: File or directory to search (directories are searched recursively).
        max_matches: Stop after this many matching lines (default 100).
    """
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"Error: invalid regex: {e}"

    matches = []
    for filepath in _iter_files(path):
        try:
            with open(filepath, encoding="utf-8", errors="ignore") as f:
                for lineno, line in enumerate(f, 1):
                    if rx.search(line):
                        matches.append(f"{filepath}:{lineno}: {line.rstrip()}")
                        if len(matches) >= max_matches:
                            matches.append(f"... [stopped at {max_matches} matches]")
                            return truncate_output("\n".join(matches))
        except (OSError, UnicodeDecodeError):
            continue
    return truncate_output("\n".join(matches)) if matches else "(no matches)"


@tool
def find(name_pattern: str, path: str = ".", max_results: int = 200) -> str:
    """Find files by glob name pattern (like ``find -name``).

    Args:
        name_pattern: Glob pattern for the filename, e.g. "*.py".
        path: Directory to search recursively.
        max_results: Stop after this many results (default 200).
    """
    results = []
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fname in files:
            if fnmatch.fnmatch(fname, name_pattern):
                results.append(os.path.join(root, fname))
                if len(results) >= max_results:
                    results.append(f"... [stopped at {max_results} results]")
                    return truncate_output("\n".join(results))
    return truncate_output("\n".join(results)) if results else "(no files found)"
