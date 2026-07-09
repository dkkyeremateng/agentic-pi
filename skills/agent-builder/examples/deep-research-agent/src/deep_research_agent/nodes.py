"""Model helpers for the deep research agent.

The delegation GRAPH is built by ``engine.build_engine`` (each agent is its own
compiled subgraph). This module keeps a single module-level chat ``model`` used
for two cross-cutting concerns that live outside the graph:

  * context compaction (``compact.run_compaction`` summarizes with a model), and
  * the TUI ``/model`` switch (``rebind_model`` recreates it from the current
    env/config).

The model is created here from config so provider/model switching takes effect
on the next turn. It is NOT bound to tools (the engine binds tools per subgraph).
"""

from deep_research_agent.config import create_model

# Model used by compaction and surfaced for the /model switch. Built at import
# time from config (conftest sets a dummy key so keyless import is safe).
model = create_model()


def rebind_model():
    """Recreate the module-level model from the current env/config.

    Used by the /model command to switch provider/model at runtime. Callers that
    read ``nodes.model`` (compaction) pick up the new model on the next use.
    """
    global model
    model = create_model()
    return model
