"""Core tools (thinking, meta)."""

from langchain_core.tools import tool


@tool
def think_tool(thought: str) -> str:
    """Use this tool to reason step by step before taking action.

    Args:
        thought: Your step-by-step reasoning about the current task.
    """
    return f"Thought recorded: {thought}"
