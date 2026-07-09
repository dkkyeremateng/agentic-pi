"""Approval gate for mutating tools.

A process-wide hook that ``tools_node`` consults before running a tool in
MUTATING_TOOLS (write_file, edit_file, run_bash). The UI installs a hook that
prompts the user; when no hook is installed (headless runs, or --auto-approve),
calls are approved automatically. Read-only tools never reach this gate.

The design deliberately avoids LangGraph ``interrupt()`` so it composes with the
streaming loop: the hook is called synchronously from the agent's worker thread
and blocks that thread until the user answers, while the UI thread stays free to
render the prompt.
"""

from typing import Callable, Optional

# hook(tool_name, args) -> bool  (True = approved)
_hook: Optional[Callable[[str, dict], bool]] = None


def set_approval_hook(hook: Optional[Callable[[str, dict], bool]]) -> None:
    """Install (or clear, with None) the approval hook."""
    global _hook
    _hook = hook


def request_approval(tool_name: str, args: dict) -> bool:
    """Ask whether ``tool_name`` may run. Approves when no hook is installed."""
    if _hook is None:
        return True
    try:
        return bool(_hook(tool_name, args))
    except Exception:
        # Fail closed: if the prompt errors, deny rather than run blindly.
        return False
