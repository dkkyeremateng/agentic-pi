"""Tests for the web tools: slugging, fetch-to-workspace, and search.

httpx is monkeypatched so no network is touched. The core contract under test:
fetch_url_to_workspace writes a FLAT <slug>_<HHMMSS>.md file and RETURNS the
exact filename; on failure it writes NO file; same-second collisions do not
silently overwrite.
"""

import pytest

from deep_research_agent import config
from deep_research_agent.tools import web


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_RUN_DIR", tmp_path)
    yield tmp_path
    config.reset_run_dir()


class _FakeResp:
    def __init__(self, text, status=200):
        self.text = text
        self._status = status

    def raise_for_status(self):
        if self._status >= 400:
            raise RuntimeError(f"HTTP {self._status}")


# ── slugify ──

def test_slugify_basic():
    assert web._slugify_url("https://microsoft.com/ai-research") == "microsoft_ai_research"


def test_slugify_strips_www_and_trailing():
    assert web._slugify_url("https://www.example.com/") == "example"


def test_slugify_fallback_for_empty():
    assert web._slugify_url("http://") == "page"


# ── fetch success ──

def test_fetch_writes_flat_file_and_returns_filename(run_dir, monkeypatch):
    html = "<html><head><title>Hi</title></head><body><p>content here</p><script>x</script></body></html>"
    monkeypatch.setattr(web.httpx, "get", lambda *a, **k: _FakeResp(html))
    monkeypatch.setattr(web.time, "strftime", lambda fmt: "143022")

    fname = web.fetch_url_to_workspace.invoke({"url": "https://microsoft.com/ai-research"})
    assert fname == "microsoft_ai_research_143022.md"
    assert not fname.startswith("/") and "/" not in fname
    written = (run_dir / fname).read_text()
    assert "content here" in written
    assert "https://microsoft.com/ai-research" in written  # source recorded
    assert "<script>" not in written  # script stripped
    # no subfolder created
    assert all(p.is_file() for p in run_dir.iterdir())


def test_fetch_bounds_output(run_dir, monkeypatch):
    big = "<html><body>" + ("word " * 20000) + "</body></html>"
    monkeypatch.setattr(web.httpx, "get", lambda *a, **k: _FakeResp(big))
    fname = web.fetch_url_to_workspace.invoke({"url": "https://x.com/big"})
    assert "truncated" in (run_dir / fname).read_text()


# ── fetch failure: no file written ──

def test_fetch_network_error_writes_no_file(run_dir, monkeypatch):
    def boom(*a, **k):
        raise httpx_error()

    def httpx_error():
        return RuntimeError("connection refused")

    monkeypatch.setattr(web.httpx, "get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("refused")))
    out = web.fetch_url_to_workspace.invoke({"url": "https://x.com/fail"})
    assert out.startswith("Error fetching")
    assert list(run_dir.iterdir()) == []


def test_fetch_http_error_writes_no_file(run_dir, monkeypatch):
    monkeypatch.setattr(web.httpx, "get", lambda *a, **k: _FakeResp("nope", status=500))
    out = web.fetch_url_to_workspace.invoke({"url": "https://x.com/500"})
    assert out.startswith("Error fetching")
    assert list(run_dir.iterdir()) == []


# ── same-second collision ──

def test_fetch_same_second_no_overwrite(run_dir, monkeypatch):
    html = "<html><body>a</body></html>"
    monkeypatch.setattr(web.httpx, "get", lambda *a, **k: _FakeResp(html))
    monkeypatch.setattr(web.time, "strftime", lambda fmt: "090000")
    f1 = web.fetch_url_to_workspace.invoke({"url": "https://x.com/same"})
    f2 = web.fetch_url_to_workspace.invoke({"url": "https://x.com/same"})
    assert f1 != f2
    assert (run_dir / f1).exists() and (run_dir / f2).exists()


# ── search ──

def test_web_search_bounded():
    out = web.web_search.invoke({"query": "python release date"})
    assert "python release date" in out
