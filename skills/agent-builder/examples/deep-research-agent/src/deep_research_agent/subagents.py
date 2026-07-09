"""Sub-agent configuration for the deep research agent.

Declares the strict, one-directional delegation chain
Orchestrator -> Searcher -> Analyzer, each carrying ONLY its own tools and the
explicit list of children it may delegate to. Two enforcement mechanisms fall
out of this data:

  1. Tool withholding — the engine binds each agent exactly ``tools`` (its own
     list), plus an auto-injected ``delegate_tasks`` iff it has children.
  2. Scoped sub_agents — delegation targets are limited to ``sub_agents``; an
     agent cannot reach a grandchild (the Orchestrator cannot delegate to the
     Analyzer).
"""

from dataclasses import dataclass, field

from deep_research_agent.prompts import (
    ORCHESTRATOR_INSTRUCTIONS,
    SEARCHER_INSTRUCTIONS,
    ANALYZER_INSTRUCTIONS,
)
from deep_research_agent.tools import (
    ORCHESTRATOR_TOOLS,
    SEARCHER_TOOLS,
    ANALYZER_TOOLS,
)


@dataclass
class SubAgentConfig:
    """One agent in the delegation tree.

    Attributes:
        agent_id: Stable name used to ROUTE delegations (e.g. "Searcher").
        system_prompt: The agent's dedicated system prompt.
        tools: The agent's OWN tools (delegate_tasks is auto-injected, not here).
        sub_agents: The children this agent may delegate to (empty for a leaf).
    """

    agent_id: str
    system_prompt: str
    tools: list = field(default_factory=list)
    sub_agents: list["SubAgentConfig"] = field(default_factory=list)


def build_agent_tree() -> SubAgentConfig:
    """Build and return the Orchestrator config (root of the delegation tree).

    Wiring: Orchestrator.sub_agents=[Searcher]; Searcher.sub_agents=[Analyzer];
    Analyzer.sub_agents=[] (leaf). The Orchestrator does NOT know about the
    Analyzer and cannot delegate to it.
    """
    analyzer = SubAgentConfig(
        agent_id="Analyzer",
        system_prompt=ANALYZER_INSTRUCTIONS,
        tools=list(ANALYZER_TOOLS),
        sub_agents=[],
    )
    searcher = SubAgentConfig(
        agent_id="Searcher",
        system_prompt=SEARCHER_INSTRUCTIONS,
        tools=list(SEARCHER_TOOLS),
        sub_agents=[analyzer],
    )
    orchestrator = SubAgentConfig(
        agent_id="Orchestrator",
        system_prompt=ORCHESTRATOR_INSTRUCTIONS,
        tools=list(ORCHESTRATOR_TOOLS),
        sub_agents=[searcher],
    )
    return orchestrator
