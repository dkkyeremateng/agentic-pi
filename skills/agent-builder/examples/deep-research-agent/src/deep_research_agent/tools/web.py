"""Web tools: search and fetch-to-workspace for the deep research agent.

``web_search`` is a bounded PLACEHOLDER — swap in a real API (Tavily, SerpAPI,
Bing, ...) at the marked point. ``fetch_url_to_workspace`` downloads and cleans a
page into a FLAT workspace file and RETURNS THE EXACT FILENAME it wrote; the
Searcher must capture that filename and pass it to the Analyzer (the data-flow
contract). Filenames are ``<url-slug>_<HHMMSS>.md`` with same-second collisions
disambiguated so two fetches never silently overwrite one another.
"""

import re
import time
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from langchain_core.tools import tool

from deep_research_agent.config import get_run_dir
from deep_research_agent.tools.truncate import truncate_output

_SLUG_MAX = 60
_FETCH_TIMEOUT = 15.0


def _slugify_url(url: str) -> str:
    """Turn a URL into a filesystem-safe slug from its host + path.

    Lowercased; runs of non-alphanumeric characters collapse to a single ``_``;
    leading/trailing ``_`` trimmed; length-capped. Example:
    ``https://microsoft.com/ai-research`` -> ``microsoft_ai_research``.
    """
    parsed = urlparse(url if "://" in url else f"http://{url}")
    host = parsed.netloc.split(":")[0]
    # Drop a leading "www." and the final TLD label so the slug reads cleanly
    # (e.g. "microsoft.com" -> "microsoft"); keep sub-domains for uniqueness.
    if host.startswith("www."):
        host = host[4:]
    labels = host.split(".")
    if len(labels) > 1:
        host = "_".join(labels[:-1])
    raw = f"{host}{parsed.path}"
    slug = re.sub(r"[^a-z0-9]+", "_", raw.lower()).strip("_")
    if len(slug) > _SLUG_MAX:
        slug = slug[:_SLUG_MAX].strip("_")
    return slug or "page"


def _unique_filename(run_dir, base: str) -> str:
    """Return ``<base>.md``, appending a short suffix if it already exists."""
    candidate = f"{base}.md"
    if not (run_dir / candidate).exists():
        return candidate
    for i in range(1, 1000):
        candidate = f"{base}_{i}.md"
        if not (run_dir / candidate).exists():
            return candidate
    return f"{base}_{int(time.time() * 1000) % 100000}.md"


@tool
def web_search(query: str, max_results: int = 5) -> str:
    """Search the web for current information.

    Args:
        query: The search query (use specific keywords).
        max_results: Number of results to return (1-10).
    """
    # ── SWAP POINT ──
    # Replace this placeholder with a real search API and wrap the results in
    # truncate_output() so a verbose API cannot flood the context window.
    return truncate_output(f"[Search results for: {query}]")


@tool
def fetch_url_to_workspace(url: str) -> str:
    """Download a web page, clean it to text, and save it to the workspace.

    Writes a FLAT file named ``<url-slug>_<HHMMSS>.md`` in the run folder and
    RETURNS THE EXACT FILENAME it wrote (never a path). Pass this filename on to
    the Analyzer so it knows which file to read. On failure NO file is written
    and an error string is returned (so the Analyzer never assumes a file that
    does not exist).

    Args:
        url: The absolute URL to fetch.
    """
    try:
        resp = httpx.get(
            url, timeout=_FETCH_TIMEOUT, follow_redirects=True,
            headers={"User-Agent": "deep-research-agent/0.1"},
        )
        resp.raise_for_status()
    except Exception as e:
        return f"Error fetching {url}: {e}"

    try:
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        title = soup.title.string.strip() if soup.title and soup.title.string else url
        text = soup.get_text(separator="\n")
        text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    except Exception as e:
        return f"Error parsing {url}: {e}"

    run_dir = get_run_dir()
    base = f"{_slugify_url(url)}_{time.strftime('%H%M%S')}"
    filename = _unique_filename(run_dir, base)
    body = truncate_output(f"# {title}\n\nSource: {url}\n\n{text}")
    try:
        with open(run_dir / filename, "w", encoding="utf-8") as f:
            f.write(body)
    except OSError as e:
        return f"Error writing fetched page: {e}"

    return filename
