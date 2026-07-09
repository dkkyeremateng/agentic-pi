"""Self-contained multi-agent delegation engine (LangGraph + langchain-core).

Reproduces the required semantics without any external agent framework:

  * Each agent is a compiled tool-calling LangGraph subgraph.
  * Tool withholding: an agent's model binds ONLY its own tools, plus an
    auto-injected ``delegate_tasks`` iff it declares sub-agents.
  * Scoped delegation: ``delegate_tasks`` routes by ``agent_id`` to a DECLARED
    child only; an undeclared target is refused. Routing is by name, never by
    index.
  * Concurrent tasks: one ``delegate_tasks`` call may carry several independent
    tasks, dispatched on a bounded thread pool and aggregated into one result.

Models are built at COMPILE time (not import time) so importing this module is
safe without a provider key.
"""

from concurrent.futures import ThreadPoolExecutor

from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, MessagesState, START, END

from deep_research_agent.config import (
    create_model,
    get_quotas,
    get_recursion_limit,
    get_max_concurrent_tasks,
)


def _prior_tool_usage(messages: list) -> dict:
    """Count how many times each tool was already called this invoke.

    Derived from the message history (thread-scoped), excluding the final
    message — that is the batch tools_node is about to execute.
    """
    usage: dict = {}
    for msg in messages[:-1]:
        for call in getattr(msg, "tool_calls", None) or []:
            usage[call["name"]] = usage.get(call["name"], 0) + 1
    return usage


def make_tools_node(tool_map: dict, quotas: dict | None = None):
    """Build a ``tools`` node that enforces quotas and dispatches via tool_map.

    ``quotas`` defaults to the live config at call time. Unknown tools and
    execution errors are returned as ToolMessages rather than raised. There is
    no mutating/approval gate — deep research has no mutating tools.
    """

    def tools_node(state: MessagesState) -> dict:
        last_message = state["messages"][-1]
        active_quotas = quotas if quotas is not None else get_quotas()
        usage = _prior_tool_usage(state["messages"])
        tool_messages = []

        for tool_call in last_message.tool_calls:
            name = tool_call["name"]
            args = tool_call["args"]
            limit = active_quotas.get(name)

            if limit is not None and usage.get(name, 0) >= limit:
                result = (
                    f"Quota exceeded: '{name}' has already been called "
                    f"{usage[name]} times this session (limit {limit}). Do not "
                    f"call it again — synthesize what you have and finish."
                )
                tool_messages.append(
                    ToolMessage(content=result, tool_call_id=tool_call["id"])
                )
                continue

            usage[name] = usage.get(name, 0) + 1
            tool_fn = tool_map.get(name)
            if tool_fn:
                try:
                    result = tool_fn.invoke(args)
                except Exception as e:
                    result = f"Error executing {name}: {e}"
            else:
                result = f"Unknown tool: {name}"

            tool_messages.append(
                ToolMessage(content=str(result), tool_call_id=tool_call["id"])
            )
        return {"messages": tool_messages}

    return tools_node


def _should_continue(state: MessagesState) -> str:
    last_message = state["messages"][-1]
    if getattr(last_message, "tool_calls", None):
        return "tools"
    return "end"


def _make_delegate_tool(children: list, quotas: dict | None):
    """Build the ``delegate_tasks`` tool that routes to declared children.

    Routing is by ``agent_id`` (a name lookup), NEVER by index. An unknown
    agent_id returns a refusal naming the valid children. Multiple tasks run
    concurrently on a bounded thread pool; results are aggregated.
    """
    by_id = {c.agent_id: compile_agent(c, quotas=quotas) for c in children}
    valid = ", ".join(by_id) or "(none)"

    @tool
    def delegate_tasks(agent_id: str, tasks: list[str]) -> str:
        """Delegate one or more independent tasks to a named sub-agent.

        Args:
            agent_id: The EXACT id of a declared sub-agent (e.g. "Searcher").
            tasks: One or more self-contained task instructions. Independent
                tasks run concurrently.
        """
        if agent_id not in by_id:
            return (
                f"Error: '{agent_id}' is not a declared sub-agent. "
                f"Valid sub-agents: {valid}."
            )
        child_graph = by_id[agent_id]
        task_list = [str(t) for t in (tasks or []) if str(t).strip()]
        if not task_list:
            return f"Error: no tasks provided for '{agent_id}'."

        def run_one(task: str) -> str:
            try:
                result = child_graph.invoke(
                    {"messages": [{"role": "user", "content": task}]},
                    config={"recursion_limit": get_recursion_limit()},
                )
                messages = result.get("messages", []) if isinstance(result, dict) else []
                return str(getattr(messages[-1], "content", "") or "") if messages else ""
            except Exception as e:
                return f"[{agent_id} task error] {e}"

        max_workers = max(1, min(get_max_concurrent_tasks(), len(task_list)))
        if len(task_list) == 1:
            outputs = [run_one(task_list[0])]
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                outputs = list(pool.map(run_one, task_list))

        parts = [
            f"[{agent_id} result {i + 1}/{len(outputs)}]\n{out}"
            for i, out in enumerate(outputs)
        ]
        return "\n\n".join(parts)

    return delegate_tasks


def _agent_tools(cfg, quotas: dict | None):
    """Return (bound_tool_list, tool_map) for an agent, injecting delegate_tasks.

    ``delegate_tasks`` is added iff the agent has children (leaf agents get
    none). The child subgraphs are compiled while building the delegate tool.
    """
    tools = list(cfg.tools)
    if cfg.sub_agents:
        tools = tools + [_make_delegate_tool(cfg.sub_agents, quotas)]
    tool_map = {t.name: t for t in tools}
    return tools, tool_map


def compile_agent(cfg, quotas: dict | None = None, checkpointer=None):
    """Compile a SubAgentConfig into a tool-calling LangGraph subgraph.

    Binds ONLY the agent's own tools (+ auto ``delegate_tasks`` when it has
    children). Children are compiled recursively BEFORE the parent's delegate
    tool is built. The model is created here (compile time), not at import.
    """
    tools, tool_map = _agent_tools(cfg, quotas)
    model = create_model()
    model_with_tools = model.bind_tools(tools) if tools else model
    system_prompt = cfg.system_prompt

    def agent_node(state: MessagesState) -> dict:
        messages = [{"role": "system", "content": system_prompt}] + state["messages"]
        return {"messages": [model_with_tools.invoke(messages)]}

    builder = StateGraph(MessagesState)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", make_tools_node(tool_map, quotas))
    builder.add_edge(START, "agent")
    builder.add_conditional_edges(
        "agent", _should_continue, {"tools": "tools", "end": END}
    )
    builder.add_edge("tools", "agent")

    graph = builder.compile(checkpointer=checkpointer)
    # Expose metadata for tests / introspection (which tools were bound).
    graph.agent_id = cfg.agent_id
    graph.bound_tool_names = [t.name for t in tools]
    return graph


def build_engine(checkpointer=None):
    """Compile the full delegation tree and return the Orchestrator subgraph.

    Only the top (Orchestrator) subgraph gets the checkpointer; child subgraphs
    are compiled without one so concurrent invokes do not contend on the same
    SQLite connection.
    """
    from deep_research_agent.subagents import build_agent_tree

    return compile_agent(build_agent_tree(), checkpointer=checkpointer)
