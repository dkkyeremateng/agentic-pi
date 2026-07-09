"""Tests for the mutating-tool approval gate (tools/approval.py)."""

from deep_research_agent.tools import approval


def teardown_function():
    approval.set_approval_hook(None)


def test_no_hook_approves():
    approval.set_approval_hook(None)
    assert approval.request_approval("write_file", {}) is True


def test_hook_can_approve():
    approval.set_approval_hook(lambda name, args: True)
    assert approval.request_approval("run_bash", {"command": "ls"}) is True


def test_hook_can_deny():
    approval.set_approval_hook(lambda name, args: False)
    assert approval.request_approval("edit_file", {}) is False


def test_hook_exception_fails_closed():
    def boom(name, args):
        raise RuntimeError("prompt crashed")

    approval.set_approval_hook(boom)
    assert approval.request_approval("write_file", {}) is False
