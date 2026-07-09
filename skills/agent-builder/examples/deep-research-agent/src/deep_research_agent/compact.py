"""Context compaction — summarize older turns to stay under the context window.

Long TUI sessions grow an unbounded message history that will eventually
overflow the model's context. Compaction summarizes all but the most recent
messages into a single briefing and removes the originals from graph state
(via RemoveMessage + the SqliteSaver checkpointer), keeping the running context
small while preserving the gist.
"""

from langchain_core.messages import RemoveMessage, SystemMessage, HumanMessage

DEFAULT_KEEP_RECENT = 6


def estimate_tokens(messages) -> int:
    """Very rough token estimate (~4 chars/token) across message contents."""
    chars = 0
    for msg in messages:
        content = getattr(msg, "content", None)
        if content is None and isinstance(msg, dict):
            content = msg.get("content", "")
        chars += len(str(content or ""))
    return chars // 4


def _render(messages) -> str:
    lines = []
    for msg in messages:
        role = getattr(msg, "type", None) or "msg"
        content = str(getattr(msg, "content", "") or "")
        if content:
            lines.append(f"{role}: {content}")
    return "\n".join(lines)


def run_compaction(graph, config, model, keep_recent: int = DEFAULT_KEEP_RECENT) -> dict:
    """Summarize all but the last ``keep_recent`` messages of a session.

    Returns ``{"compacted": bool, "removed": int, "reason": str}``. Never
    raises — a failed summary leaves the conversation untouched.
    """
    try:
        state = graph.get_state(config)
        messages = (state.values or {}).get("messages", []) if state else []
    except Exception as e:
        return {"compacted": False, "removed": 0, "reason": f"state read failed: {e}"}

    if len(messages) <= keep_recent + 2:
        return {"compacted": False, "removed": 0, "reason": "not enough history"}

    old = messages[:-keep_recent]
    summary_request = [
        SystemMessage(content=(
            "Summarize the conversation so far into a concise brief that preserves "
            "decisions, facts, file paths, and open tasks. Be information-dense and "
            "omit pleasantries."
        )),
        HumanMessage(content=_render(old)),
    ]
    try:
        summary = model.invoke(summary_request)
    except Exception as e:
        return {"compacted": False, "removed": 0, "reason": f"summary failed: {e}"}

    summary_text = str(getattr(summary, "content", "") or "")
    removals = [RemoveMessage(id=m.id) for m in old if getattr(m, "id", None)]
    summary_msg = SystemMessage(
        content=f"[Summary of earlier conversation]\n{summary_text}"
    )
    try:
        graph.update_state(config, {"messages": removals + [summary_msg]})
    except Exception as e:
        return {"compacted": False, "removed": 0, "reason": f"update failed: {e}"}
    return {"compacted": True, "removed": len(removals), "reason": "ok"}
