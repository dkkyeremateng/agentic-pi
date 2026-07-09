"""Tests for the compaction token estimate (compact.py)."""

from langchain_core.messages import HumanMessage

from deep_research_agent.compact import estimate_tokens


def test_estimate_tokens_from_messages():
    # ~4 chars per token, so 40 chars -> 10 tokens.
    assert estimate_tokens([HumanMessage(content="a" * 40)]) == 10


def test_estimate_tokens_from_dicts():
    assert estimate_tokens([{"role": "user", "content": "a" * 20}]) == 5


def test_estimate_tokens_empty():
    assert estimate_tokens([]) == 0
