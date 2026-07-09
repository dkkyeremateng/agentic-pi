"""Tests for the footer cost estimate (pricing.py)."""

import os

from deep_research_agent.pricing import estimate_cost


def test_known_model_cost():
    # claude-sonnet is (3, 15) per 1M tokens.
    assert estimate_cost("claude-sonnet-4-5", 1_000_000, 1_000_000) == 3.0 + 15.0


def test_unknown_model_returns_none():
    assert estimate_cost("some-unlisted-model", 1000, 1000) is None


def test_zero_tokens_is_zero_for_known_model():
    assert estimate_cost("claude-opus", 0, 0) == 0.0


def test_env_override_extends_table():
    os.environ["PI_TUI_PRICES"] = "mymodel:2/4"
    try:
        assert estimate_cost("mymodel-v1", 1_000_000, 1_000_000) == 2.0 + 4.0
    finally:
        del os.environ["PI_TUI_PRICES"]
