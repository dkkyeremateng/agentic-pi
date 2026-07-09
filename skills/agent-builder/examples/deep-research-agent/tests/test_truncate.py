"""Tests for output truncation (tools/truncate.py)."""

from deep_research_agent.tools.truncate import truncate_output


def test_short_text_unchanged():
    assert truncate_output("hello") == "hello"


def test_empty_text():
    assert truncate_output("") == ""


def test_within_limits_has_no_marker():
    text = "a\nb\nc"
    assert truncate_output(text, max_lines=10, max_chars=100) == text


def test_line_truncation():
    text = "\n".join(str(i) for i in range(1000))
    out = truncate_output(text, max_lines=10, max_chars=1_000_000)
    assert "output truncated" in out
    digit_lines = [line for line in out.splitlines() if line.isdigit()]
    assert len(digit_lines) == 10
    assert digit_lines[0] == "0"


def test_char_truncation():
    out = truncate_output("x" * 5000, max_lines=1_000_000, max_chars=100)
    assert "output truncated" in out
    assert out.startswith("x" * 100)
