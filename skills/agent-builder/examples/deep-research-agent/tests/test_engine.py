"""Tests for the self-contained delegation engine.

A scripted fake chat model stubs the LLM so no network is touched. The fake
routes its scripted replies by the agent's system prompt (passed as the first
message), which is robust to the engine's compile order (children compile
before parents). Coverage:
  * Tool withholding — each agent binds only its own tools (+ delegate_tasks
    iff it has children).
  * Auto-injection — delegate_tasks present iff sub_agents non-empty; the leaf
    Analyzer has none.
  * Scoped delegation + agent_id routing (NOT index-0) — the Orchestrator
    cannot reach the Analyzer.
  * Concurrent tasks aggregate into one result.
  * Quota enforcement wraps every tool including delegate_tasks.
"""

from langchain_core.messages import AIMessage
from langchain_core.tools import tool

from deep_research_agent import engine
from deep_research_agent.subagents import SubAgentConfig, build_agent_tree


def _tool_call(name, args, call_id="c1"):
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}],
    )


class PromptRoutedModel:
    """Fake chat model whose replies are chosen by the agent's system prompt.

    ``scripts`` maps a substring of the system prompt to a queue of replies.
    The queue may contain AIMessages or zero-arg callables (evaluated lazily,
    so concurrent child invokes can each pull a distinct answer). When a queue
    empties, a plain "done" AIMessage terminates that subgraph.
    """

    def __init__(self, scripts):
        self._scripts = scripts
        self.bound_tool_names = []

    def bind_tools(self, tools):
        m = PromptRoutedModel(self._scripts)
        m.bound_tool_names = [t.name for t in tools]
        return m

    def invoke(self, messages):
        system = ""
        for msg in messages:
            if isinstance(msg, dict) and msg.get("role") == "system":
                system = msg.get("content", "")
                break
        for key, queue in self._scripts.items():
            if key in system:
                if queue:
                    item = queue.pop(0)
                    return item() if callable(item) else item
                return AIMessage(content="done")
        return AIMessage(content="done")


def _fake_create_model(scripts):
    return lambda: PromptRoutedModel(scripts)


# ── tool withholding ──

def test_orchestrator_binds_only_its_tools(monkeypatch):
    monkeypatch.setattr(engine, "create_model", _fake_create_model({}))
    graph = engine.build_engine()
    names = set(graph.bound_tool_names)
    assert names == {
        "write_workspace_file", "list_workspace_files",
        "write_todos", "read_todos", "think_tool", "delegate_tasks",
    }
    assert "web_search" not in names
    assert "read_workspace_file" not in names
    assert "grep_workspace_file" not in names


def test_searcher_and_analyzer_tool_withholding(monkeypatch):
    monkeypatch.setattr(engine, "create_model", _fake_create_model({}))
    tree = build_agent_tree()
    searcher = tree.sub_agents[0]
    analyzer = searcher.sub_agents[0]

    s_graph = engine.compile_agent(searcher)
    assert set(s_graph.bound_tool_names) == {
        "web_search", "fetch_url_to_workspace", "think_tool", "delegate_tasks",
    }
    assert "read_workspace_file" not in s_graph.bound_tool_names

    a_graph = engine.compile_agent(analyzer)
    assert set(a_graph.bound_tool_names) == {
        "read_workspace_file", "grep_workspace_file", "think_tool",
    }
    assert "delegate_tasks" not in a_graph.bound_tool_names


def test_delegate_injected_iff_children(monkeypatch):
    monkeypatch.setattr(engine, "create_model", _fake_create_model({}))
    leaf = SubAgentConfig("Leaf", "leaf prompt", tools=[], sub_agents=[])
    parent = SubAgentConfig("Parent", "parent prompt", tools=[], sub_agents=[leaf])
    assert "delegate_tasks" not in engine.compile_agent(leaf).bound_tool_names
    assert "delegate_tasks" in engine.compile_agent(parent).bound_tool_names


# ── scoped delegation + agent_id routing (NOT index-0) ──

def test_orchestrator_cannot_delegate_to_analyzer(monkeypatch):
    scripts = {
        # Orchestrator: try to delegate straight to the Analyzer (a grandchild).
        "Orchestrator of a deep research team": [
            _tool_call("delegate_tasks", {"agent_id": "Analyzer", "tasks": ["do it"]}),
        ],
        # If the Analyzer subgraph were ever reached, it would emit this marker.
        "Analyzer, a data-analysis specialist": [
            AIMessage(content="ANALYZER_REACHED"),
        ],
    }
    monkeypatch.setattr(engine, "create_model", _fake_create_model(scripts))
    graph = engine.build_engine()
    result = graph.invoke(
        {"messages": [{"role": "user", "content": "go"}]},
        config={"recursion_limit": 10},
    )
    contents = "\n".join(str(getattr(m, "content", "")) for m in result["messages"])
    assert "ANALYZER_REACHED" not in contents
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert tool_msgs and "not a declared sub-agent" in tool_msgs[0].content
    assert "Searcher" in tool_msgs[0].content


def test_delegate_routes_to_named_child(monkeypatch):
    child = SubAgentConfig("Worker", "child worker prompt", tools=[], sub_agents=[])
    parent = SubAgentConfig("Boss", "boss prompt", tools=[], sub_agents=[child])
    scripts = {
        "boss prompt": [
            _tool_call("delegate_tasks", {"agent_id": "Worker", "tasks": ["task A"]}),
        ],
        "child worker prompt": [AIMessage(content="CHILD_ANSWER")],
    }
    monkeypatch.setattr(engine, "create_model", _fake_create_model(scripts))
    graph = engine.compile_agent(parent)
    result = graph.invoke(
        {"messages": [{"role": "user", "content": "go"}]},
        config={"recursion_limit": 10},
    )
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("CHILD_ANSWER" in m.content for m in tool_msgs)


def test_concurrent_tasks_aggregate(monkeypatch):
    child = SubAgentConfig("Worker", "child worker prompt", tools=[], sub_agents=[])
    parent = SubAgentConfig("Boss", "boss prompt", tools=[], sub_agents=[child])
    answers = iter(["ANS1", "ANS2"])
    scripts = {
        "boss prompt": [
            _tool_call("delegate_tasks",
                       {"agent_id": "Worker", "tasks": ["t1", "t2"]}),
        ],
        # Callable so each of the two concurrent child invokes pulls a distinct
        # answer.
        "child worker prompt": [
            lambda: AIMessage(content=next(answers)),
            lambda: AIMessage(content=next(answers)),
        ],
    }
    monkeypatch.setattr(engine, "create_model", _fake_create_model(scripts))
    monkeypatch.setattr(engine, "get_max_concurrent_tasks", lambda: 2)
    graph = engine.compile_agent(parent)
    result = graph.invoke(
        {"messages": [{"role": "user", "content": "go"}]},
        config={"recursion_limit": 10},
    )
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    agg = "\n".join(m.content for m in tool_msgs)
    assert "ANS1" in agg and "ANS2" in agg
    assert "result 1/2" in agg and "result 2/2" in agg


# ── quota enforcement ──

def test_quota_blocks_tool_in_engine():
    @tool
    def counter(x: str) -> str:
        """A test tool."""
        return f"ran {x}"

    node = engine.make_tools_node({"counter": counter}, quotas={"counter": 1})
    prior = _tool_call("counter", {"x": "a"}, call_id="0")
    now = _tool_call("counter", {"x": "b"}, call_id="1")
    out = node({"messages": [prior, now]})
    assert "Quota exceeded" in out["messages"][0].content


def test_quota_allows_under_limit():
    @tool
    def counter(x: str) -> str:
        """A test tool."""
        return f"ran {x}"

    node = engine.make_tools_node({"counter": counter}, quotas={"counter": 5})
    now = _tool_call("counter", {"x": "b"}, call_id="1")
    out = node({"messages": [now]})
    assert out["messages"][0].content == "ran b"
