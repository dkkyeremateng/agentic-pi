"""Tests for the tool registry and per-agent tool groups.

These assert the tool-withholding contract at the data level (which tools each
agent is given). delegate_tasks is auto-injected by the engine and is
deliberately absent from every group here.
"""

from deep_research_agent.tools import (
    AVAILABLE_TOOLS, TOOL_MAP,
    ORCHESTRATOR_TOOLS, SEARCHER_TOOLS, ANALYZER_TOOLS,
)


def _names(tools):
    return {t.name for t in tools}


def test_registry_has_research_tools():
    for expected in (
        "think_tool", "web_search", "fetch_url_to_workspace",
        "write_workspace_file", "read_workspace_file",
        "list_workspace_files", "grep_workspace_file",
        "write_todos", "read_todos",
    ):
        assert expected in TOOL_MAP, f"missing tool: {expected}"


def test_available_tools_map_matches():
    assert set(TOOL_MAP) == {t.name for t in AVAILABLE_TOOLS}


def test_orchestrator_group_exact():
    assert _names(ORCHESTRATOR_TOOLS) == {
        "write_workspace_file", "list_workspace_files",
        "write_todos", "read_todos", "think_tool",
    }
    # No web tools, no read/grep, no delegate_tasks (auto-injected by engine).
    assert "web_search" not in _names(ORCHESTRATOR_TOOLS)
    assert "read_workspace_file" not in _names(ORCHESTRATOR_TOOLS)
    assert "delegate_tasks" not in _names(ORCHESTRATOR_TOOLS)


def test_searcher_group_exact():
    assert _names(SEARCHER_TOOLS) == {
        "web_search", "fetch_url_to_workspace", "think_tool",
    }
    assert "read_workspace_file" not in _names(SEARCHER_TOOLS)
    assert "delegate_tasks" not in _names(SEARCHER_TOOLS)


def test_analyzer_group_exact():
    assert _names(ANALYZER_TOOLS) == {
        "read_workspace_file", "grep_workspace_file", "think_tool",
    }
    assert "web_search" not in _names(ANALYZER_TOOLS)
    assert "delegate_tasks" not in _names(ANALYZER_TOOLS)


def test_delegate_tasks_not_in_registry():
    # delegate_tasks is built per-agent by the engine, never a static tool.
    assert "delegate_tasks" not in TOOL_MAP
