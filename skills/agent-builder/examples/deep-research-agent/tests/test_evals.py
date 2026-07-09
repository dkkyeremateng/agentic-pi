"""Tests for the eval harness pure logic (scorers, judge parser, report).

These need no model or graph — the harness keeps heavy imports lazy.
"""

from deep_research_agent.evals.scorers import run_check
from deep_research_agent.evals.judge import parse_judgement
from deep_research_agent.evals.harness import report


def _result(output="", tools=None, error=None):
    return {"output": output, "tools": tools or [], "error": error}


# ── scorers ──

def test_contains_and_ignore_case():
    assert run_check(_result("Hello there"), {"type": "contains", "value": "hello",
                                              "ignore_case": True}).passed
    assert not run_check(_result("Hello there"),
                         {"type": "contains", "value": "hello"}).passed


def test_not_contains():
    assert run_check(_result("safe"), {"type": "not_contains", "value": "error"}).passed
    assert not run_check(_result("an error"),
                         {"type": "not_contains", "value": "error"}).passed


def test_regex():
    assert run_check(_result("id=42"), {"type": "regex", "value": r"id=\d+"}).passed
    assert not run_check(_result("id=x"), {"type": "regex", "value": r"id=\d+"}).passed


def test_length_bounds():
    assert run_check(_result("abcd"), {"type": "min_length", "value": 4}).passed
    assert not run_check(_result("ab"), {"type": "min_length", "value": 4}).passed
    assert run_check(_result("ab"), {"type": "max_length", "value": 4}).passed
    assert not run_check(_result("abcde"), {"type": "max_length", "value": 4}).passed


def test_tool_called():
    r = _result(tools=["web_search", "write_file"])
    assert run_check(r, {"type": "tool_called", "value": "write_file"}).passed
    assert run_check(r, {"type": "tool_not_called", "value": "run_bash"}).passed
    assert not run_check(r, {"type": "tool_called", "value": "run_bash"}).passed


def test_no_error():
    assert run_check(_result(), {"type": "no_error"}).passed
    assert not run_check(_result(error="boom"), {"type": "no_error"}).passed


def test_json_valid():
    assert run_check(_result('{"a": 1}'), {"type": "json_valid"}).passed
    assert not run_check(_result("not json"), {"type": "json_valid"}).passed


def test_unknown_check_type_fails_gracefully():
    res = run_check(_result("x"), {"type": "made_up"})
    assert not res.passed and "unknown check type" in res.detail


# ── judge parser ──

def test_parse_judgement_standard():
    out = parse_judgement("SCORE: 5\nREASON: perfect")
    assert out["score"] == 5 and out["reason"] == "perfect"


def test_parse_judgement_fallback_digit():
    assert parse_judgement("I would rate this a 3 overall")["score"] == 3


def test_parse_judgement_no_score():
    assert parse_judgement("no number here")["score"] == 0


# ── report ──

def test_report_summary_and_failures():
    results = [
        {"name": "a", "passed": True, "run": _result("ok"), "checks": [], "judge": None},
        {"name": "b", "passed": False, "run": _result(error="boom"),
         "checks": [{"type": "no_error", "passed": False, "detail": "agent raised: boom"}],
         "judge": None},
    ]
    text = report(results)
    assert "[PASS] a" in text
    assert "[FAIL] b" in text
    assert "no_error" in text
    assert "1/2 passed" in text
