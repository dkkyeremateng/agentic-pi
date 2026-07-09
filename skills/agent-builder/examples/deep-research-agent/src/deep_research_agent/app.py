"""TUI Agent — a LangGraph agent with a Textual Terminal User Interface.

Features:
- Split-panel chat display with user/agent/tool message styling
- Slash commands with autocomplete (type /): /files /thinking /new /help /config
  /copy /compact /model /export /stop /exit
- Copy responses to the clipboard: /copy (last) or /copy all, and Ctrl+Y
- Live token streaming of responses (text appears as the LLM generates it)
- Cancel an in-flight run with /stop or Esc; elapsed-time working indicator
- Prompt history recall with Up / Down
- Tool calls shown with a one-line result + status ([ok]/[denied]/[quota]/[error])
- Live footer: model, provider, token usage, and estimated cost
- Thinking trace toggle (show/hide LLM reasoning)
- Workspace file browser via /files
- Multi-agent delegation: Orchestrator -> Searcher -> Analyzer (self-contained
  engine; tool withholding + scoped sub_agents)
- Bounded tool output (truncation) so results cannot flood the context
- Bounded, workspace-scoped tools with per-run isolation (agents pass plain
  filenames; the run folder is auto-mapped and hidden from the agents)
- Per-session tool-call quota enforcement (anti-looping)
- Graph recursion limit (anti-looping)
- Context compaction (/compact + automatic near the token threshold)
- Runtime model switching (/model) and transcript export (/export)
- Project context: loads AGENTS.md / CLAUDE.md into the system prompt
- Persistent sessions (SQLite): list and resume across restarts
- Headless mode for batch processing
- Provider-agnostic (Anthropic, OpenAI, OpenAI-compatible)

Usage:
    deep-research-agent                    # Interactive TUI mode
    deep-research-agent --prompt "..."     # Headless mode
    deep-research-agent --list-sessions    # List saved sessions
    deep-research-agent --resume <id>      # Resume a saved session
"""

import argparse
import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from langchain_core.messages import AIMessageChunk
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import StateGraph, MessagesState, START, END
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.binding import Binding
from textual.screen import Screen, ModalScreen
from textual.widgets import (
    Button, Footer, Header, Input, Label, ListItem, ListView,
    OptionList, RichLog, Static, TextArea,
)
from textual.widgets.option_list import Option
from textual import work

from deep_research_agent.config import (
    get_provider, ensure_config, get_workspace_dir, get_quotas,
    get_recursion_limit, get_model_name, get_sessions_db_path,
    get_compact_threshold,
)
from deep_research_agent.pricing import estimate_cost
from deep_research_agent.compact import run_compaction, estimate_tokens
import deep_research_agent.nodes as agent_nodes
from deep_research_agent.engine import build_engine
from deep_research_agent.tools.approval import set_approval_hook

load_dotenv()

APP_TITLE = "Deep Research Agent"
APP_DESCRIPTION = "A multi-agent deep research agent with a Textual TUI"

# Single source of truth for slash commands: drives both the /help listing and
# the autocomplete menu. (name, description) — the dispatcher in
# AgentTUI._handle_slash_command also accepts the aliases /?, /quit.
SLASH_COMMANDS = [
    ("help", "Show this help"),
    ("stop", "Cancel the current run (or press Esc)"),
    ("new", "Start a new conversation"),
    ("files", "Browse workspace files"),
    ("thinking", "Toggle thinking traces"),
    ("config", "Show current configuration"),
    ("copy", "Copy the last response to the clipboard (/copy all for the transcript)"),
    ("compact", "Summarize older turns to free context"),
    ("model", "Show or switch model: /model [provider] <name>"),
    ("export", "Save the transcript to a markdown file"),
    ("exit", "Quit the application"),
]


# ── Streaming helpers ──

def _chunk_text(content) -> str:
    """Extract plain answer text from a streamed message chunk's content.

    Handles both string content and provider content-block lists, keeping
    only ordinary text (reasoning blocks are pulled separately).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "".join(parts)
    return ""


def _chunk_reasoning(content) -> str:
    """Extract reasoning/thinking text from a streamed chunk, if the model
    emits it as content blocks. Returns "" when there is none."""
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type", "")
                if "reasoning" in btype or "thinking" in btype:
                    parts.append(block.get("text") or block.get("thinking") or "")
        return "".join(parts)
    return ""


# ── Graph Builder ──

def build_graph():
    """Build and compile the multi-agent delegation engine (the Orchestrator).

    The Orchestrator is a compiled LangGraph subgraph that delegates to the
    Searcher, which delegates to the Analyzer (engine.build_engine). Only the
    top-level Orchestrator gets the SqliteSaver checkpointer so conversations
    persist across restarts and can be listed/resumed by thread_id; child
    subgraphs run without a checkpointer to avoid contention on concurrent
    delegated tasks.
    """
    # check_same_thread=False: the TUI invokes from a background worker thread.
    conn = sqlite3.connect(get_sessions_db_path(), check_same_thread=False)
    checkpointer = SqliteSaver(conn)
    checkpointer.setup()  # idempotent: creates the checkpoint tables if missing
    return build_engine(checkpointer=checkpointer)


def list_session_ids() -> list:
    """Return the distinct thread_ids that have persisted checkpoints."""
    db_path = get_sessions_db_path()
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute("SELECT DISTINCT thread_id FROM checkpoints")
        return [row[0] for row in cur.fetchall()]
    except sqlite3.OperationalError:
        return []  # tables not created yet
    finally:
        conn.close()


def session_snippet(graph, thread_id: str) -> str:
    """First user message of a session, for the --list-sessions display."""
    try:
        state = graph.get_state({"configurable": {"thread_id": thread_id}})
        messages = (state.values or {}).get("messages", []) if state else []
    except Exception:
        return ""
    for msg in messages:
        is_human = getattr(msg, "type", None) == "human" or (
            isinstance(msg, dict) and msg.get("role") == "user"
        )
        if is_human:
            content = getattr(msg, "content", None)
            if content is None and isinstance(msg, dict):
                content = msg.get("content", "")
            text = str(content).strip().replace("\n", " ")
            return text[:60] + "..." if len(text) > 60 else text
    return ""


# ── File Browser Screen ──

class FileBrowser(Screen):
    """A screen for browsing workspace files."""

    def __init__(self, workspace_dir: Path):
        self.workspace_dir = workspace_dir
        super().__init__()

    def compose(self) -> ComposeResult:
        from rich.markup import escape
        yield Header()
        yield Label(f"[bold]Workspace:[/bold] {escape(str(self.workspace_dir))}")
        yield ListView(id="file-list")
        yield Static("Press Escape to return", id="file-hint")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_files()

    def _refresh_files(self) -> None:
        from rich.markup import escape
        list_view = self.query_one("#file-list", ListView)
        list_view.clear()
        if self.workspace_dir.exists():
            for f in sorted(self.workspace_dir.iterdir()):
                marker = "[file]" if f.is_file() else "[dir] "
                # Escape for display (filenames and the markers contain '[');
                # keep the real name on the ListItem for selection.
                list_view.append(
                    ListItem(Label(escape(f"{marker} {f.name}")), name=f.name)
                )
        else:
            list_view.append(ListItem(Label("(workspace is empty)")))

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        fname = event.item.name if event.item else None
        if not fname:
            return
        fpath = self.workspace_dir / fname
        if fpath.is_file():
            try:
                content = fpath.read_text(encoding="utf-8")
                self.dismiss(content)
            except Exception as e:
                self.dismiss(f"Error: {e}")
        elif fpath.is_dir():
            self.workspace_dir = fpath
            self._refresh_files()

    def key_escape(self) -> None:
        self.dismiss(None)


# ── Approval Modal ──

class ApprovalModal(ModalScreen):
    """Ask the user to approve or deny a mutating tool call.

    Dismisses with a choice string that flows back to the approval hook waiting
    on the worker thread:
      "once"   — allow this call only
      "always" — allow this call and every later call of the same tool this session
      "deny"   — refuse (also on Escape)
    """

    CSS = """
    ApprovalModal { align: center middle; }
    #approval-box {
        width: 80;
        height: auto;
        border: thick $warning;
        background: $surface;
        padding: 1 2;
    }
    #approval-actions { height: 3; align: center middle; }
    #approval-actions Button { margin: 0 1; }
    """

    def __init__(self, tool_name: str, args) -> None:
        self._tool_name = tool_name
        self._args = args
        super().__init__()

    def compose(self) -> ComposeResult:
        from rich.markup import escape
        yield Vertical(
            Label(f"[bold]Approve tool call:[/bold] {escape(self._tool_name)}"),
            Static(escape(str(self._args)[:500])),
            Horizontal(
                Button("Approve", id="once", variant="success"),
                Button("Don't ask again", id="always", variant="primary"),
                Button("Deny", id="deny", variant="error"),
                id="approval-actions",
            ),
            id="approval-box",
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id)  # "once" | "always" | "deny"

    def key_escape(self) -> None:
        self.dismiss("deny")


# ── Prompt input with history ──

class PromptInput(Input):
    """Single-line input that recalls previous prompts with Up / Down."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._history: list[str] = []
        self._hist_pos = None  # None = editing a fresh line

    def add_history(self, text: str) -> None:
        text = text.strip()
        if text and (not self._history or self._history[-1] != text):
            self._history.append(text)
        self._hist_pos = None

    def _recall(self, delta: int) -> None:
        if not self._history:
            return
        if self._hist_pos is None:
            if delta > 0:
                return  # already at the fresh line
            self._hist_pos = len(self._history) - 1
        else:
            self._hist_pos += delta
            if self._hist_pos < 0:
                self._hist_pos = 0
            elif self._hist_pos >= len(self._history):
                self._hist_pos = None
        self.value = "" if self._hist_pos is None else self._history[self._hist_pos]
        self.cursor_position = len(self.value)

    def _menu(self):
        """The command autocomplete menu, if it is currently visible."""
        try:
            menu = self.app.query_one("#command-list", OptionList)
        except Exception:
            return None
        return menu if menu.display else None

    def on_key(self, event) -> None:
        menu = self._menu()
        if menu is not None:
            # Autocomplete menu is open — drive it from the input's keys.
            if event.key == "down":
                self._move_highlight(menu, 1)
            elif event.key == "up":
                self._move_highlight(menu, -1)
            elif event.key == "tab":
                self._apply_completion(menu, submit=False)
            elif event.key == "enter":
                self._apply_completion(menu, submit=True)
            elif event.key == "escape":
                menu.display = False
            else:
                return  # let the keystroke type and re-filter the menu
            event.stop()
            event.prevent_default()
            return
        # No menu open — Up / Down recall prompt history.
        if event.key == "up":
            self._recall(-1)
            event.stop()
            event.prevent_default()
        elif event.key == "down":
            self._recall(1)
            event.stop()
            event.prevent_default()

    def _move_highlight(self, menu, delta: int) -> None:
        count = menu.option_count
        if not count:
            return
        cur = menu.highlighted if menu.highlighted is not None else 0
        menu.highlighted = max(0, min(count - 1, cur + delta))

    def _apply_completion(self, menu, submit: bool) -> None:
        idx = menu.highlighted
        menu.display = False
        if idx is None:
            return
        cmd = menu.get_option_at_index(idx).id
        if not cmd:
            return
        if submit:
            self.value = f"/{cmd}"
            self.app._handle_send()
        else:
            self.value = f"/{cmd} "
            self.cursor_position = len(self.value)


# ── Main TUI Application ──

class AgentTUI(App):
    """Textual TUI for interacting with the LangGraph agent."""

    CSS = """
    Screen {
        background: $surface;
    }

    #chat-display {
        height: 1fr;
        border: solid $primary;
        margin: 0 1;
        padding: 0 1;
    }

    #input-row {
        height: 3;
        margin: 0 1 1 1;
        dock: bottom;
    }

    #message-input {
        width: 1fr;
    }

    #send-button {
        width: 12;
        margin-left: 1;
    }

    #status-bar {
        height: 1;
        margin: 0 1;
        content-align: center middle;
        color: $text-muted;
    }

    #stats-bar {
        height: 1;
        margin: 0 1;
        content-align: right middle;
        color: $text-muted;
    }

    #command-list {
        height: auto;
        max-height: 8;
        margin: 0 1;
        border: solid $primary;
        display: none;
    }

    #stream-panel {
        height: auto;
        max-height: 12;
        margin: 0 1;
        padding: 0 1;
        display: none;
        overflow-y: auto;
    }

    #thinking-panel {
        height: 6;
        border: solid $accent;
        margin: 0 1;
        display: none;
        overflow-y: auto;
    }

    #help-panel {
        height: 10;
        border: solid $warning;
        margin: 0 1;
        display: none;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("escape", "stop", "Stop", show=True),
        Binding("ctrl+y", "copy", "Copy last", show=True),
    ]

    # Allow Textual's built-in text selection (drag to select). Harmless on
    # Textual versions that predate the feature.
    ALLOW_SELECT = True

    thread_id: str
    _thinking_enabled: bool
    _session_history: list

    def __init__(self, graph, resume_thread_id: str | None = None,
                 auto_approve: bool = False):
        self.graph = graph
        self._resume = bool(resume_thread_id)
        self._auto_approve = auto_approve
        self._session_approved = set()  # tools the user approved for the session
        self.thread_id = resume_thread_id or f"session_{int(time.time())}"
        self._thinking_enabled = False
        self._session_history = []  # per-instance, not shared across apps
        self._thinking = False
        self._compacting = False
        self._cancel = threading.Event()  # cooperative cancel for the run loop
        self._work_timer = None
        self._work_start = 0.0
        self._stream_buf = ""  # accumulates the in-progress agent response
        self._tokens_in = 0
        self._tokens_out = 0
        self._workspace_dir = get_workspace_dir()
        super().__init__()

    def compose(self) -> ComposeResult:
        yield Header()
        yield RichLog(id="chat-display", highlight=True, markup=True)
        yield Static(id="stream-panel")
        yield RichLog(id="thinking-panel", highlight=True, markup=True)
        yield Static(id="help-panel")
        yield Static(id="status-bar")
        yield Static(id="stats-bar")
        yield OptionList(id="command-list")
        yield Horizontal(
            PromptInput(id="message-input",
                        placeholder="Type a message (Up/Down for history) or / for commands..."),
            Button("Send", id="send-button", variant="primary"),
            id="input-row",
        )
        yield Footer()

    def on_mount(self) -> None:
        """Called when the app is mounted."""
        from rich.markup import escape
        chat = self.query_one("#chat-display", RichLog)
        chat.write(f"[bold]{escape(APP_TITLE)}[/bold]")
        chat.write(f"[dim]Session: {escape(self.thread_id)}[/dim]")
        chat.write(f"[dim]Workspace: {escape(str(self._workspace_dir))}[/dim]")
        chat.write("[dim]Type /help for available commands[/dim]\n")
        if self._resume:
            self._replay_history()
        if not self._auto_approve:
            set_approval_hook(self._approval_hook)
        self.update_status("Ready • /help for commands")
        self._update_stats()
        self.query_one("#message-input", Input).focus()

    def on_unmount(self) -> None:
        """Clear the process-wide approval hook when the app closes."""
        set_approval_hook(None)

    def _approval_hook(self, tool_name: str, args) -> bool:
        """Called from the worker thread; blocks it until the user answers.

        If the tool was already approved for this session ("Don't ask again"),
        returns immediately without prompting. Otherwise schedules the modal on
        the UI thread and waits on an Event for the choice, so the UI stays
        responsive while the agent pauses.
        """
        if tool_name in self._session_approved:
            return True

        event = threading.Event()
        box = {"choice": "deny"}

        def ask():
            def done(value):
                box["choice"] = value or "deny"
                event.set()
            self.push_screen(ApprovalModal(tool_name, args), done)

        self.call_from_thread(ask)
        event.wait()
        choice = box["choice"]
        if choice == "always":
            self._session_approved.add(tool_name)
            self.call_from_thread(
                self._note, f"'{tool_name}' approved for the rest of this session"
            )
        return choice in ("once", "always")

    def _replay_history(self) -> None:
        """Render a resumed session's prior messages into the chat log."""
        from rich.markup import escape
        chat = self.query_one("#chat-display", RichLog)
        try:
            state = self.graph.get_state(
                {"configurable": {"thread_id": self.thread_id}}
            )
            messages = (state.values or {}).get("messages", []) if state else []
        except Exception as e:
            chat.write(f"[bold red]Could not resume session:[/bold red] {escape(str(e))}")
            return
        chat.write(f"[dim]--- resumed {len(messages)} message(s) ---[/dim]")
        for msg in messages:
            mtype = getattr(msg, "type", None)
            content = getattr(msg, "content", None)
            if mtype == "human":
                chat.write(f"\n[bold]You:[/bold] {escape(str(content))}")
                self._session_history.append(
                    {"role": "user", "content": str(content)}
                )
            elif mtype == "ai":
                if content:
                    chat.write(f"[bold]Agent:[/bold] {escape(str(content))}")
                    self._session_history.append(
                        {"role": "assistant", "content": str(content)}
                    )
                for tc in getattr(msg, "tool_calls", None) or []:
                    chat.write(f"[dim]  called {escape(tc['name'])}(...)[/dim]")

    def update_status(self, text: str) -> None:
        """Update the status bar text."""
        self.query_one("#status-bar", Static).update(text)

    def _update_stats(self) -> None:
        """Render the persistent footer: model, provider, tokens, est. cost."""
        model = get_model_name()
        provider = get_provider()
        cost = estimate_cost(model, self._tokens_in, self._tokens_out)
        cost_str = f" · ~${cost:.4f}" if cost is not None else ""
        self.query_one("#stats-bar", Static).update(
            f"[dim]{model} · {provider} · in {self._tokens_in:,} / "
            f"out {self._tokens_out:,} tok{cost_str}[/dim]"
        )

    # ── Slash Commands ──

    def _handle_slash_command(self, cmd: str) -> bool:
        """Handle slash commands. Returns True if a command was handled."""
        parts = cmd[1:].strip().split()
        command = parts[0].lower() if parts else ""

        if command in ("help", "?"):
            self._show_help()
            return True
        elif command == "stop":
            self._stop()
            return True
        elif command == "new":
            self._new_session()
            return True
        elif command == "files":
            self._browse_files()
            return True
        elif command == "thinking":
            self._toggle_thinking()
            return True
        elif command == "config":
            self._show_config()
            return True
        elif command == "copy":
            self._copy(parts[1:])
            return True
        elif command == "compact":
            self._compact(manual=True)
            return True
        elif command == "model":
            self._switch_model(parts[1:])
            return True
        elif command == "export":
            self._export(parts[1:])
            return True
        elif command in ("exit", "quit"):
            self.exit()
            return True
        return False

    def _show_help(self) -> None:
        from rich.markup import escape
        chat = self.query_one("#chat-display", RichLog)
        chat.write("[bold]Commands:[/bold] (type / for autocomplete)")
        width = max(len(name) for name, _ in SLASH_COMMANDS)
        for name, desc in SLASH_COMMANDS:
            chat.write(f"  [dim]/{escape(name.ljust(width))}[/dim] — {escape(desc)}")
        chat.write("")

    def _new_session(self) -> None:
        from rich.markup import escape
        self.thread_id = f"session_{int(time.time())}"
        self._session_history = []
        self._session_approved.clear()  # re-prompt for approvals in the new session
        self._tokens_in = 0
        self._tokens_out = 0
        chat = self.query_one("#chat-display", RichLog)
        chat.clear()
        chat.write(f"[bold]New session: {escape(self.thread_id)}[/bold]\n")
        self.update_status("New session started")
        self._update_stats()

    def _toggle_thinking(self) -> None:
        self._thinking_enabled = not self._thinking_enabled
        panel = self.query_one("#thinking-panel", RichLog)
        panel.styles.display = "block" if self._thinking_enabled else "none"
        status = "on" if self._thinking_enabled else "off"
        self.update_status(f"Thinking traces: {status}")

    def _browse_files(self) -> None:
        self.push_screen(FileBrowser(self._workspace_dir), self._on_file_selected)

    def _on_file_selected(self, content: str | None) -> None:
        if content:
            chat = self.query_one("#chat-display", RichLog)
            from rich.markup import escape
            safe = escape(content[:2000])
            chat.write(f"[bold]File content:[/bold]\n{safe}")

    def _show_config(self) -> None:
        from rich.markup import escape
        ensure_config()
        chat = self.query_one("#chat-display", RichLog)
        chat.write("[bold]Configuration:[/bold]")
        chat.write(f"  Provider: {escape(get_provider())}")
        chat.write(f"  Model: {escape(get_model_name())}")
        chat.write(f"  Workspace: {escape(str(self._workspace_dir))}")
        chat.write(f"  Thinking: {'on' if self._thinking_enabled else 'off'}")
        chat.write(f"  Approval: {'off (auto)' if self._auto_approve else 'on'}")
        if self._session_approved:
            allowed = ", ".join(sorted(self._session_approved))
            chat.write(f"  Approved this session: {escape(allowed)}")
        quotas = get_quotas()
        if quotas:
            chat.write(f"  Quotas: {escape(json.dumps(quotas, indent=2))}")
        chat.write("")

    def action_copy(self) -> None:
        """Ctrl+Y — copy the last response to the clipboard."""
        self._copy([])

    def _copy(self, args_list) -> None:
        """Copy conversation text to the system clipboard (OSC 52).

        /copy         -> the last agent response
        /copy all     -> the whole transcript
        """
        scope = args_list[0].lower() if args_list else "last"
        if scope in ("all", "transcript"):
            text = "\n\n".join(
                f"{turn['role'].capitalize()}: {turn['content']}"
                for turn in self._session_history
            )
            label = f"transcript ({len(self._session_history)} turns)"
        else:
            text = ""
            for turn in reversed(self._session_history):
                if turn["role"] == "assistant":
                    text = turn["content"]
                    break
            label = "last response"
        if not text:
            self.update_status("Nothing to copy yet")
            return
        self.copy_to_clipboard(text)
        self.update_status(f"Copied {label} to clipboard ({len(text)} chars)")

    def _switch_model(self, args_list) -> None:
        """/model — show the active model, or switch provider/model at runtime.

        Usage: /model <name>  or  /model <provider> <name>
        """
        from rich.markup import escape
        chat = self.query_one("#chat-display", RichLog)
        if not args_list:
            chat.write(f"[dim]Model: {escape(get_model_name())} · {escape(get_provider())}[/dim]")
            chat.write("[dim]Switch with: /model \\[provider] <name>[/dim]")
            return
        if len(args_list) >= 2:
            provider, name = args_list[0].lower(), args_list[1]
            os.environ["LLM_PROVIDER"] = provider
        else:
            provider, name = get_provider(), args_list[0]
        if provider == "anthropic":
            os.environ["ANTHROPIC_MODEL"] = name
        else:
            os.environ["OPENAI_MODEL"] = name
        try:
            agent_nodes.rebind_model()
        except Exception as e:
            chat.write(f"[bold red]Could not switch model:[/bold red] {escape(str(e))}")
            return
        chat.write(f"[dim]Switched to {escape(name)} ({escape(provider)})[/dim]")
        self._update_stats()

    def _export(self, args_list) -> None:
        """/export — write the current transcript to a markdown file."""
        from rich.markup import escape
        chat = self.query_one("#chat-display", RichLog)
        if args_list:
            path = args_list[0]
        else:
            path = str(self._workspace_dir / f"transcript_{self.thread_id}.md")
        lines = [f"# Transcript — {self.thread_id}\n"]
        for turn in self._session_history:
            role = str(turn.get("role", "")).capitalize()
            lines.append(f"## {role}\n\n{turn.get('content', '')}\n")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
        except OSError as e:
            chat.write(f"[bold red]Export failed:[/bold red] {escape(str(e))}")
            return
        chat.write(f"[dim]Exported {len(self._session_history)} turn(s) to {escape(path)}[/dim]")

    # ── Input Handling ──

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "send-button":
            self._handle_send()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self._handle_send()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Show/filter the slash-command autocomplete menu as the user types."""
        if event.input.id != "message-input":
            return
        menu = self.query_one("#command-list", OptionList)
        value = event.value
        # Only while typing a bare command (leading '/', no space yet).
        if value.startswith("/") and " " not in value:
            prefix = value[1:].lower()
            matches = [(n, d) for n, d in SLASH_COMMANDS if n.startswith(prefix)]
            if matches:
                menu.clear_options()
                for name, desc in matches:
                    menu.add_option(Option(f"/{name}  {desc}", id=name))
                menu.highlighted = 0
                menu.display = True
                return
        menu.display = False

    def on_option_list_option_selected(
        self, event: OptionList.OptionSelected
    ) -> None:
        """Mouse-click on a command fills it in (the user then edits/submits)."""
        menu = self.query_one("#command-list", OptionList)
        menu.display = False
        cmd = event.option.id
        if not cmd:
            return
        inp = self.query_one("#message-input", PromptInput)
        inp.value = f"/{cmd} "
        inp.cursor_position = len(inp.value)
        inp.focus()

    def _handle_send(self) -> None:
        """Process user input and invoke the agent."""
        input_widget = self.query_one("#message-input", PromptInput)
        user_text = input_widget.value.strip()
        if not user_text:
            return

        input_widget.value = ""
        input_widget.add_history(user_text)

        # Slash commands work any time; while the agent is busy, only /stop
        # and /help are allowed so the user can always cancel.
        if user_text.startswith("/"):
            cmd = user_text.strip().lower().split()[0]
            if self._thinking and cmd not in ("/stop", "/help", "/?", "/copy"):
                self.update_status("Agent is busy — /stop to cancel")
                return
            self._handle_slash_command(user_text)
            return

        if self._thinking:
            self.update_status("Agent is busy — /stop to cancel")
            return

        chat = self.query_one("#chat-display", RichLog)
        from rich.markup import escape
        chat.write(f"\n[bold]You:[/bold] {escape(user_text)}")
        self._session_history.append({"role": "user", "content": user_text})

        # Run agent in a background thread; the loop checks self._cancel.
        self._thinking = True
        self._cancel.clear()
        self._start_work_timer()

        def run_agent():
            """Stream the agent turn so text appears as it is generated.

            ``stream_mode=["updates", "messages"]`` gives two interleaved
            streams: "messages" yields LLM token chunks (live text), and
            "updates" yields each node's completed output (used to surface
            tool calls at the right boundary).
            """
            try:
                self.call_from_thread(self._begin_stream)
                for mode, chunk in self.graph.stream(
                    {"messages": [{"role": "user", "content": user_text}]},
                    config={
                        "configurable": {"thread_id": self.thread_id},
                        "recursion_limit": get_recursion_limit(),
                    },
                    stream_mode=["updates", "messages"],
                ):
                    if self._cancel.is_set():
                        break
                    if mode == "messages":
                        msg_chunk, _meta = chunk
                        if isinstance(msg_chunk, AIMessageChunk):
                            text = _chunk_text(msg_chunk.content)
                            if text:
                                self.call_from_thread(self._append_stream, text)
                            if self._thinking_enabled:
                                reasoning = _chunk_reasoning(msg_chunk.content)
                                extra = (getattr(msg_chunk, "additional_kwargs", None)
                                         or {}).get("reasoning_content")
                                if extra:
                                    reasoning += str(extra)
                                if reasoning:
                                    self.call_from_thread(
                                        self._append_thinking, reasoning
                                    )
                    elif mode == "updates":
                        for _node, update in (chunk or {}).items():
                            for msg in (update or {}).get("messages", []):
                                usage = getattr(msg, "usage_metadata", None)
                                if usage:
                                    self._tokens_in += usage.get("input_tokens", 0) or 0
                                    self._tokens_out += usage.get("output_tokens", 0) or 0
                                    self.call_from_thread(self._update_stats)
                                calls = getattr(msg, "tool_calls", None)
                                if calls:
                                    # Commit the pre-tool text, then note the calls.
                                    self.call_from_thread(self._commit_stream)
                                    for tc in calls:
                                        self.call_from_thread(
                                            self._write_tool_call,
                                            tc["name"], tc["args"],
                                        )
                                elif getattr(msg, "type", None) == "tool":
                                    self.call_from_thread(
                                        self._write_tool_result,
                                        str(getattr(msg, "content", "")),
                                    )
                if self._cancel.is_set():
                    self.call_from_thread(self._note, "stopped by user")
                self.call_from_thread(self._finish_turn)
            except Exception as e:
                self.call_from_thread(self._display_error, str(e))

        thread = threading.Thread(target=run_agent, daemon=True)
        thread.start()

    # ── Streaming display (all run on the UI thread) ──

    def _begin_stream(self) -> None:
        """Reveal the live panel for a fresh agent response."""
        self._stream_buf = ""
        panel = self.query_one("#stream-panel", Static)
        panel.update("")
        panel.styles.display = "block"

    def _append_stream(self, text: str) -> None:
        """Append a token to the in-progress response and repaint the panel."""
        from rich.markup import escape
        self._stream_buf += text
        panel = self.query_one("#stream-panel", Static)
        panel.update(f"[bold]Agent:[/bold] {escape(self._stream_buf)}")

    def _commit_stream(self) -> None:
        """Flush the buffered response into the scrollback log and hide the panel."""
        from rich.markup import escape
        if self._stream_buf.strip():
            chat = self.query_one("#chat-display", RichLog)
            chat.write(f"[bold]Agent:[/bold] {escape(self._stream_buf)}")
            self._session_history.append(
                {"role": "assistant", "content": self._stream_buf}
            )
        self._stream_buf = ""
        panel = self.query_one("#stream-panel", Static)
        panel.update("")
        panel.styles.display = "none"

    def _append_thinking(self, text: str) -> None:
        from rich.markup import escape
        tp = self.query_one("#thinking-panel", RichLog)
        tp.write(f"[dim]{escape(text)}[/dim]")

    def _write_tool_call(self, name: str, args) -> None:
        from rich.markup import escape
        chat = self.query_one("#chat-display", RichLog)
        chat.write(f"[dim]  called {escape(name)}({escape(str(args))})[/dim]")

    def _write_tool_result(self, content: str) -> None:
        """Show a one-line result summary + status marker for a tool call."""
        from rich.markup import escape
        first = content.strip().splitlines()[0] if content.strip() else ""
        if content.startswith("Denied by user"):
            marker = "[denied]"
        elif content.startswith("Quota exceeded"):
            marker = "[quota]"
        elif content.startswith("Error") or content.startswith("Unknown tool"):
            marker = "[error]"
        else:
            marker = "[ok]"
        # The marker contains '[' — escape it, or Rich treats it as a style tag.
        chat = self.query_one("#chat-display", RichLog)
        chat.write(f"[dim]    {escape(marker)} {escape(first[:200])}[/dim]")

    def _note(self, text: str) -> None:
        from rich.markup import escape
        self.query_one("#chat-display", RichLog).write(
            f"[dim]--- {escape(text)} ---[/dim]"
        )

    # ── Work timer + cancellation ──

    def _start_work_timer(self) -> None:
        self._work_start = time.monotonic()
        self.update_status("Working... 0s • /stop to cancel")
        self._work_timer = self.set_interval(1.0, self._tick_work)

    def _tick_work(self) -> None:
        if not self._thinking:
            return
        elapsed = int(time.monotonic() - self._work_start)
        self.update_status(f"Working... {elapsed}s • /stop to cancel")

    def _stop_work_timer(self) -> None:
        if self._work_timer is not None:
            self._work_timer.stop()
            self._work_timer = None

    def action_stop(self) -> None:
        """Escape / the Stop binding cancels an in-flight run."""
        self._stop()

    def _stop(self) -> None:
        if not self._thinking:
            return
        self._cancel.set()
        self.update_status("Stopping...")

    def _finish_turn(self) -> None:
        """Commit any remaining text and re-enable input."""
        self._commit_stream()
        self._thinking = False
        self._stop_work_timer()
        elapsed = int(time.monotonic() - self._work_start) if self._work_start else 0
        self.update_status(f"Ready • done in {elapsed}s • /help for commands")
        inp = self.query_one("#message-input", PromptInput)
        inp.disabled = False
        inp.focus()
        self._maybe_auto_compact()

    # ── Compaction ──

    def _maybe_auto_compact(self) -> None:
        """Compact automatically once the history grows past the threshold."""
        if self._compacting:
            return
        try:
            state = self.graph.get_state(
                {"configurable": {"thread_id": self.thread_id}}
            )
            messages = (state.values or {}).get("messages", []) if state else []
        except Exception:
            return
        if estimate_tokens(messages) >= get_compact_threshold():
            self._compact(manual=False)

    def _compact(self, manual: bool = False) -> None:
        """Summarize older turns in a background thread."""
        if self._compacting:
            return
        self._compacting = True
        if manual:
            self.update_status("Compacting conversation...")

        def work():
            config = {"configurable": {"thread_id": self.thread_id}}
            result = run_compaction(self.graph, config, agent_nodes.model)
            self.call_from_thread(self._compaction_done, result, manual)

        threading.Thread(target=work, daemon=True).start()

    def _compaction_done(self, result: dict, manual: bool) -> None:
        from rich.markup import escape
        self._compacting = False
        chat = self.query_one("#chat-display", RichLog)
        if result.get("compacted"):
            chat.write(
                f"[dim]--- compacted: summarized {result['removed']} older "
                f"message(s) ---[/dim]"
            )
        elif manual:
            reason = escape(str(result.get("reason", "")))
            chat.write(f"[dim]--- compaction skipped: {reason} ---[/dim]")
        self.update_status("Ready • /help for commands")

    def _display_error(self, error: str) -> None:
        """Display an error message and discard any partial stream."""
        from rich.markup import escape
        self._stream_buf = ""
        panel = self.query_one("#stream-panel", Static)
        panel.update("")
        panel.styles.display = "none"
        chat = self.query_one("#chat-display", RichLog)
        chat.write(f"[bold red]Error:[/bold red] {escape(error)}")
        self._thinking = False
        self._stop_work_timer()
        self.update_status("Error occurred")
        inp = self.query_one("#message-input", PromptInput)
        inp.disabled = False
        inp.focus()


# ── Headless Mode ──

def run_headless(graph, prompt: str, auto_approve: bool = False,
                 thread_id: str = "headless"):
    """Run the agent in headless mode, streaming output as it is generated."""
    print(f"\n{'='*60}")
    print(f"  {APP_TITLE}")
    print(f"{'='*60}\n")

    for mode, chunk in graph.stream(
        {"messages": [{"role": "user", "content": prompt}]},
        config={
            "configurable": {"thread_id": thread_id},
            "recursion_limit": get_recursion_limit(),
        },
        stream_mode=["updates", "messages"],
    ):
        if mode == "messages":
            msg_chunk, _meta = chunk
            if isinstance(msg_chunk, AIMessageChunk):
                text = _chunk_text(msg_chunk.content)
                if text:
                    print(text, end="", flush=True)
        elif mode == "updates":
            for _node, update in (chunk or {}).items():
                for msg in (update or {}).get("messages", []):
                    calls = getattr(msg, "tool_calls", None)
                    if calls:
                        for tc in calls:
                            print(f"\n  [tool] {tc['name']}({tc['args']})", flush=True)

    print()


# ── Entry Point ──

def main():
    parser = argparse.ArgumentParser(description=f"{APP_TITLE} — {APP_DESCRIPTION}")
    parser.add_argument("--prompt", type=str, help="Run in headless mode with this prompt")
    parser.add_argument("--auto-approve", "--yolo", dest="auto_approve",
                        action="store_true",
                        help="Retained for compatibility; this agent has no mutating tools")
    parser.add_argument("--list-sessions", action="store_true", help="List saved sessions")
    parser.add_argument("--resume", type=str, help="Resume a previous session by ID")
    args = parser.parse_args()

    # Listing sessions needs no provider/model — do it before the key check.
    if args.list_sessions:
        ids = list_session_ids()
        if not ids:
            print("No saved sessions.")
        else:
            print("Saved sessions (resume with --resume <id>):")
            for sid in ids:
                print(f"  {sid}")
        return 0

    # Check API key
    provider = get_provider()
    if provider == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("Error: ANTHROPIC_API_KEY not set.")
            return 1
    else:
        if not os.environ.get("OPENAI_API_KEY"):
            print("Error: OPENAI_API_KEY not set.")
            return 1

    # Ensure config exists
    ensure_config()

    graph = build_graph()

    if args.prompt:
        run_headless(graph, args.prompt, args.auto_approve,
                     thread_id=args.resume or "headless")
    else:
        app = AgentTUI(graph, resume_thread_id=args.resume,
                       auto_approve=args.auto_approve)
        app.run()

    return 0


if __name__ == "__main__":
    exit(main())
