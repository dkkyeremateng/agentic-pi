"""State schema for the TUI agent."""

from typing import Annotated, Any, List, Optional
from typing_extensions import TypedDict
import operator


class AgentState(TypedDict):
    """State schema for the TUI agent graph.

    Fields:
        messages: Conversation history (auto-appended via operator.add)
        task_name: Current task being worked on
        delegated_tasks: Tasks delegated to sub-agents
        pending_approval: Actions awaiting human approval
        context: Extra context data
    """
    messages: Annotated[List[dict], operator.add]
    task_name: str
    delegated_tasks: List[dict]
    pending_approval: Optional[dict]
    context: Optional[dict]
