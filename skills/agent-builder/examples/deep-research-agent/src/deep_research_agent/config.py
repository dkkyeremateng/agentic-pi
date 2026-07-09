"""Configuration loading for the TUI agent.

Loads from YAML config file (auto-created from template on first run),
with environment variable overrides. Supports Anthropic, OpenAI, and
OpenAI-compatible providers.
"""

import os
import shutil
from pathlib import Path

import yaml
from dotenv import load_dotenv

load_dotenv()

# ── Paths ──

APP_NAME = "deep-research-agent"
CONFIG_DIR = Path.home() / f".{APP_NAME}"
CONFIG_FILE = CONFIG_DIR / "config.yaml"
CONFIG_TEMPLATE = Path(__file__).resolve().parent / "config_template.yaml"


def ensure_config() -> dict:
    """Load config from file, auto-creating from template if missing."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        if CONFIG_TEMPLATE.exists():
            shutil.copy(CONFIG_TEMPLATE, CONFIG_FILE)
        else:
            return _default_config()

    with open(CONFIG_FILE) as f:
        cfg = yaml.safe_load(f) or {}
    return cfg


def _default_config() -> dict:
    return {
        "api": {"provider": "openai", "model": "gpt-4o", "base_url": None},
        "settings": {
            "enable_thinking": False,
            "concurrency": {"max_concurrent_tasks": 3},
            "quotas": {
                "web_search": 8,
                "fetch_url_to_workspace": 6,
                "read_workspace_file": 20,
                "write_workspace_file": 10,
                "list_workspace_files": 10,
                "grep_workspace_file": 15,
                "write_todos": 15,
                "read_todos": 15,
                "think_tool": 20,
                "delegate_tasks": 10,
            },
            "limits": {"recursion_limit": 50, "compact_at_tokens": 24000},
            "enable_conversational_memory": True,
            "enable_session_persistence": True,
            "workspace": {
                "type": "disk",
                "dir": f"~/.{APP_NAME}/workspace",
                "session_isolation": True,
            },
        },
    }


# ── Provider helpers ──


def get_provider() -> str:
    """Get the LLM provider: 'anthropic', 'openai', or 'openai-compatible'."""
    explicit = os.environ.get("LLM_PROVIDER", "").lower().strip()
    if explicit:
        return explicit
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return "openai"


def get_model_name(provider: str | None = None) -> str:
    """Get the model name for the active provider."""
    provider = provider or get_provider()
    if provider == "anthropic":
        return os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    return os.environ.get("OPENAI_MODEL", "gpt-4o")


def get_openai_base_url() -> str | None:
    """Get a custom base URL for OpenAI-compatible providers."""
    return os.environ.get("OPENAI_BASE_URL") or None


def create_model():
    """Create a chat model for the configured provider."""
    provider = get_provider()
    model_name = get_model_name(provider)

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model=model_name)

    from langchain_openai import ChatOpenAI
    base_url = get_openai_base_url()
    kwargs = {"model": model_name}
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


# ── Workspace helpers ──


# The run folder is a PER-PROCESS singleton: every file tool auto-maps plain
# filenames into this one directory so the fetch->read data-flow contract holds
# (a file written by the Searcher is later read by the Analyzer). It is computed
# once, lazily, and cached; reset_run_dir() clears it (used by tests).
_RUN_DIR: Path | None = None

def get_run_dir() -> Path:
    """Return the single run folder for this process, creating it once.

    With ``workspace.session_isolation`` enabled the run folder is a fresh
    timestamped ``run_<epoch>/`` subdirectory; otherwise it is the workspace
    base itself. The result is cached so repeated calls in one process return
    the SAME path (agents stay unaware of the folder and never see it change).
    """
    global _RUN_DIR
    if _RUN_DIR is not None:
        return _RUN_DIR
    cfg = ensure_config()
    ws = cfg.get("settings", {}).get("workspace", {})
    base = ws.get("dir", f"~/.{APP_NAME}/workspace")
    base = Path(base).expanduser().resolve()
    base.mkdir(parents=True, exist_ok=True)

    if ws.get("session_isolation", True):
        import time
        run_dir = base / f"run_{int(time.time())}"
    else:
        run_dir = base
    run_dir.mkdir(parents=True, exist_ok=True)
    _RUN_DIR = run_dir
    return _RUN_DIR

def reset_run_dir() -> None:
    """Clear the cached run folder so the next get_run_dir() recomputes it.

    Only meant for tests that need a clean, isolated run folder per case.
    """
    global _RUN_DIR
    _RUN_DIR = None

def get_workspace_dir() -> Path:
    """Get the workspace directory for the current session.

    Back-compat alias for the TUI file browser; delegates to the run-folder
    singleton so the browser shows exactly what the file tools write.
    """
    return get_run_dir()


def get_quotas() -> dict:
    """Get tool call quotas from config."""
    cfg = ensure_config()
    return cfg.get("settings", {}).get("quotas", {})


def get_recursion_limit() -> int:
    """Get the graph recursion limit (max node steps per invoke).

    Caps how many agent<->tools hops a single invoke may take before
    LangGraph raises, guarding against infinite loops.
    """
    cfg = ensure_config()
    limit = cfg.get("settings", {}).get("limits", {}).get("recursion_limit", 50)
    try:
        return int(limit)
    except (TypeError, ValueError):
        return 50


def get_max_concurrent_tasks() -> int:
    """Max concurrent child-subgraph invokes inside one delegate_tasks call."""
    cfg = ensure_config()
    val = (
        cfg.get("settings", {})
        .get("concurrency", {})
        .get("max_concurrent_tasks", 3)
    )
    try:
        return max(1, int(val))
    except (TypeError, ValueError):
        return 3

def get_compact_threshold() -> int:
    """Approx token count of the message history that triggers auto-compaction."""
    cfg = ensure_config()
    val = cfg.get("settings", {}).get("limits", {}).get("compact_at_tokens", 24000)
    try:
        return int(val)
    except (TypeError, ValueError):
        return 24000


def get_sessions_db_path() -> str:
    """Path to the SQLite file backing session persistence.

    Lives alongside the config in ``~/.deep-research-agent/`` so sessions survive
    across process restarts (used by the LangGraph SqliteSaver checkpointer).
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return str(CONFIG_DIR / "sessions.db")


def get_project_root() -> Path:
    """Get the project root directory."""
    return Path(__file__).resolve().parent.parent.parent
