"""Tests for nodes.py model helpers.

The delegation graph lives in engine.py; nodes.py only provides the model used
by compaction and the /model switch. conftest sets a dummy provider key so the
import-time model build works offline (the model is never invoked here).
"""

import deep_research_agent.nodes as nodes


def test_module_has_model():
    assert nodes.model is not None


def test_rebind_model_returns_a_model(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(nodes, "create_model", lambda: sentinel)
    result = nodes.rebind_model()
    assert result is sentinel
    assert nodes.model is sentinel
