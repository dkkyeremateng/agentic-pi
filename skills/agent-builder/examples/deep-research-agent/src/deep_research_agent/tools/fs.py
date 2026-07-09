"""File system tools."""

from langchain_core.tools import tool

from deep_research_agent.tools.truncate import truncate_output


@tool
def read_file(path: str) -> str:
    """Read the contents of a file from the workspace.

    Large files are truncated so they cannot flood the context window; the
    result notes when it was clipped.

    Args:
        path: Absolute path to the file.
    """
    try:
        with open(path, encoding="utf-8") as f:
            return truncate_output(f.read())
    except Exception as e:
        return f"Error reading file: {e}"


@tool
def write_file(path: str, content: str) -> str:
    """Write content to a file on the workspace.

    Args:
        path: Absolute path to the file.
        content: Content to write.
    """
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Written {len(content)} bytes to {path}"
    except Exception as e:
        return f"Error writing file: {e}"


@tool
def list_files(path: str = ".") -> str:
    """List files and directories in a given path.

    Args:
        path: Directory path to list.
    """
    import os
    try:
        entries = os.listdir(path)
        return truncate_output("\n".join(entries)) if entries else "(empty directory)"
    except Exception as e:
        return f"Error listing files: {e}"
