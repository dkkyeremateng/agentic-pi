"""Tool implementations and per-agent tool groups for the deep research agent.

Each agent is bound ONLY its own tools (tool withholding). The engine
auto-injects ``delegate_tasks`` into agents that declare sub-agents; it is not
listed here. Quota keys in config match these tool names exactly so enforcement
is unambiguous.
"""

from deep_research_agent.tools.core import think_tool
from deep_research_agent.tools.web import web_search, fetch_url_to_workspace
from deep_research_agent.tools.workspace import (
    write_workspace_file,
    read_workspace_file,
    list_workspace_files,
    grep_workspace_file,
)
from deep_research_agent.tools.todos import write_todos, read_todos

# Per-agent tool groups (each agent's OWN tools; delegate_tasks is auto-injected
# by the engine and is intentionally NOT in any of these lists).
ORCHESTRATOR_TOOLS = [
    write_workspace_file,
    list_workspace_files,
    write_todos,
    read_todos,
    think_tool,
]
SEARCHER_TOOLS = [
    web_search,
    fetch_url_to_workspace,
    think_tool,
]
ANALYZER_TOOLS = [
    read_workspace_file,
    grep_workspace_file,
    think_tool,
]

# Every non-delegation tool, for building the shared execution map. The engine's
# tool node also registers the auto-injected delegate_tasks per agent.
AVAILABLE_TOOLS = [
    think_tool,
    web_search,
    fetch_url_to_workspace,
    write_workspace_file,
    read_workspace_file,
    list_workspace_files,
    grep_workspace_file,
    write_todos,
    read_todos,
]

# Tool map by name (name -> tool). Excludes delegate_tasks, which is built per
# agent by the engine.
TOOL_MAP = {t.name: t for t in AVAILABLE_TOOLS}
