"""Deterministic scorers for eval cases.

Pure functions (stdlib only) so they are fast, cheap, and unit-testable without
a model. Each scorer inspects a `result` dict produced by running the agent:

    {"output": str, "tools": list[str], "error": str | None}

against a `check` dict from the case file:

    {"type": "contains", "value": "hello", "ignore_case": true}

and returns whether it passed plus a short human-readable detail.
"""

import json
import re
from dataclasses import dataclass


@dataclass
class CheckResult:
    type: str
    passed: bool
    detail: str


def _text(result: dict) -> str:
    return str(result.get("output") or "")


def _contains(result, check):
    val = str(check.get("value", ""))
    text = _text(result)
    if check.get("ignore_case"):
        ok = val.lower() in text.lower()
    else:
        ok = val in text
    return ok, f"expected output to contain {val!r}"


def _not_contains(result, check):
    ok, _ = _contains(result, check)
    return (not ok), f"expected output NOT to contain {str(check.get('value',''))!r}"


def _regex(result, check):
    pattern = str(check.get("value", ""))
    ok = re.search(pattern, _text(result)) is not None
    return ok, f"expected output to match /{pattern}/"


def _min_length(result, check):
    n = int(check.get("value", 0))
    length = len(_text(result))
    return length >= n, f"expected length >= {n}, got {length}"


def _max_length(result, check):
    n = int(check.get("value", 0))
    length = len(_text(result))
    return length <= n, f"expected length <= {n}, got {length}"


def _tool_called(result, check):
    name = str(check.get("value", ""))
    tools = result.get("tools") or []
    return name in tools, f"expected tool {name!r} to be called; called {tools}"


def _tool_not_called(result, check):
    name = str(check.get("value", ""))
    tools = result.get("tools") or []
    return name not in tools, f"expected tool {name!r} NOT to be called; called {tools}"


def _no_error(result, check):
    err = result.get("error")
    return err is None, ("no error" if err is None else f"agent raised: {err}")


def _json_valid(result, check):
    try:
        json.loads(_text(result))
        return True, "output is valid JSON"
    except Exception as e:
        return False, f"output is not valid JSON: {e}"


SCORERS = {
    "contains": _contains,
    "not_contains": _not_contains,
    "regex": _regex,
    "min_length": _min_length,
    "max_length": _max_length,
    "tool_called": _tool_called,
    "tool_not_called": _tool_not_called,
    "no_error": _no_error,
    "json_valid": _json_valid,
}


def run_check(result: dict, check: dict) -> CheckResult:
    """Apply a single check to a run result."""
    check_type = check.get("type", "")
    fn = SCORERS.get(check_type)
    if fn is None:
        return CheckResult(check_type, False, f"unknown check type: {check_type!r}")
    passed, detail = fn(result, check)
    return CheckResult(check_type, bool(passed), detail)
