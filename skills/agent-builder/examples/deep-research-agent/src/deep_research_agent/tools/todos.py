"""Simple TODO-list state for the Orchestrator.

Process-local state keyed by the run folder (so a new run starts empty). The
Orchestrator uses these to plan and track research phases; they are not
persisted across processes.
"""

from langchain_core.tools import tool

from deep_research_agent.config import get_run_dir
from deep_research_agent.tools.truncate import truncate_output

# Keyed by run-folder path so each run has its own TODO list.
_TODOS: dict = {}


def _key() -> str:
    return str(get_run_dir())


@tool
def write_todos(todos: list[str]) -> str:
    """Replace the TODO list with ``todos`` (a list of short task strings).

    Args:
        todos: The full, updated list of TODO items.
    """
    items = [str(t) for t in (todos or [])]
    _TODOS[_key()] = items
    return truncate_output(
        f"Recorded {len(items)} todo(s):\n"
        + "\n".join(f"{i + 1}. {t}" for i, t in enumerate(items))
    )


@tool
def read_todos() -> str:
    """Return the current TODO list."""
    items = _TODOS.get(_key(), [])
    if not items:
        return "(no todos)"
    return truncate_output(
        "\n".join(f"{i + 1}. {t}" for i, t in enumerate(items))
    )
