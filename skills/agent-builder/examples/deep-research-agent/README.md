# deep-research-agent

A TUI-based **deep research agent** built on the `basic-tui-agent` scaffold. It
replaces the single-agent loop with a **self-contained multi-agent delegation
engine** (LangGraph + langchain-core only — no external agent framework). Three
agents cooperate in a strict, one-directional chain to research a question,
download and analyze sources, and assemble a report. Provider-agnostic
(Anthropic, OpenAI, or any OpenAI-compatible API); runs as an interactive
Textual TUI or headless.

## Architecture

Each agent is a **compiled tool-calling LangGraph subgraph**. An agent is
described by a `SubAgentConfig` (`subagents.py`) carrying its `agent_id`, its
`system_prompt`, its OWN `tools`, and the list of `sub_agents` it may delegate
to. The engine (`engine.py`) compiles that tree into nested subgraphs and wires
delegation between them.

```
Orchestrator            (plans, tracks TODOs, writes the final report)
    |  delegate_tasks(agent_id="Searcher", ...)
    v
Searcher                (searches the web, fetches pages into the workspace)
    |  delegate_tasks(agent_id="Analyzer", ...)   <-- embeds the fetched filename
    v
Analyzer  (leaf)        (reads/greps the fetched files, extracts the facts)
```

Delegation is **strict and one-directional**: `Orchestrator -> Searcher ->
Analyzer`. The Orchestrator does not know about, and cannot delegate to, the
Analyzer.

### Two enforcement mechanisms

1. **Tool withholding** — each agent's model binds ONLY its own tool list. The
   Orchestrator has no `web_search`; the Searcher has no `read_workspace_file`.
   This forces delegation rather than an agent doing a child's job itself.
2. **Scoped sub_agents** — `delegate_tasks` routes by `agent_id` to a *declared
   child only*. An undeclared target (e.g. the Orchestrator naming "Analyzer")
   is refused with a message listing the valid children. Routing is by name,
   never by list index.

`delegate_tasks` is **auto-injected** into an agent iff its `sub_agents` list is
non-empty. Leaf agents (the Analyzer) never receive it. Multiple independent
tasks in one `delegate_tasks` call run concurrently on a bounded thread pool
(`concurrency.max_concurrent_tasks`) and their results are aggregated.

## Tool assignment

Each agent is given ONLY these tools (no exceptions). `delegate_tasks` is
auto-injected by the engine, not listed as a static tool.

| Agent | Own tools (bound) | sub_agents | delegate_tasks? |
|-------|-------------------|------------|-----------------|
| **Orchestrator** | `write_workspace_file`, `list_workspace_files`, `write_todos`, `read_todos`, `think_tool` | `[Searcher]` | yes (auto) |
| **Searcher** | `web_search`, `fetch_url_to_workspace`, `think_tool` | `[Analyzer]` | yes (auto) |
| **Analyzer** (leaf) | `read_workspace_file`, `grep_workspace_file`, `think_tool` | `[]` | no |

The tools:

- `web_search(query)` — bounded web search. Ships as a **placeholder**; wire a
  real API at the marked swap point in `tools/web.py`.
- `fetch_url_to_workspace(url)` — downloads and cleans a page into a FLAT
  workspace file named `<url-slug>_<HHMMSS>.md` and **RETURNS THE EXACT
  FILENAME** it wrote. On failure it writes no file. Same-second name
  collisions are disambiguated so two fetches never silently overwrite.
- `write_workspace_file` / `read_workspace_file` (optional line range) /
  `list_workspace_files` / `grep_workspace_file` — operate on plain filenames,
  auto-mapped into the run folder.
- `write_todos` / `read_todos` — the Orchestrator's plan/track state.
- `think_tool` — a scratchpad reflection no-op, available to every agent.

## Run-folder isolation

Every session gets ONE run folder (`run_<epoch>/` under the workspace, from
`config.get_run_dir()` — a **per-process singleton**). All file tools auto-map
plain filenames into it. **Agents are unaware of the run folder**: they pass
names like `query.md` or `final_report.md`, never paths. Names that contain a
directory separator, `..`, or are absolute are rejected — subfolders are never
created inside the run folder. This makes the fetch->read data-flow contract
hold: a file the Searcher fetches is later read by the Analyzer by the same
plain name.

**Data-flow contract:** `fetch_url_to_workspace` returns the exact filename; the
Searcher's prompt instructs it to capture that filename and embed it verbatim in
the Analyzer delegation. The Analyzer never assumes a file exists before it is
fetched.

## Prompts and behavior

Prompts (`prompts.py`, one constant per agent) bake in the behavioral rules:

- **Proportional depth** (Orchestrator): a simple single-fact lookup dispatches
  a SINGLE Searcher with 1-2 sources — no multi-phase plan; comparative queries
  dispatch one Searcher per angle concurrently; deep research goes multi-phase.
- **Source-quality awareness** (Searcher): an authoritative/official source is
  enough on its own; informal sources are corroborated with at least one more.
- **Adaptive reporting** (Orchestrator): chooses a simple list vs. a sectioned
  report based on the query.
- **`<Anti-Looping>`** (all three): on a tool failure, change approach or stop —
  never blindly retry the identical call.
- **Stop-early** (all three): do not visit all links or max out quotas; once the
  answer is corroborated, stop and return.

## Anti-looping / safety

1. **Graph recursion limit** — every subgraph invoke passes
   `settings.limits.recursion_limit` (default 50).
2. **Per-session tool quotas** — the engine's tool node counts prior usage from
   the message history and refuses a tool once it hits its
   `settings.quotas.<tool>` budget (quota keys match the enforced tool names
   exactly). `delegate_tasks` is quota-limited too.
3. **Prompt directives** — the `<Anti-Looping>` and Stop-Early blocks.

## Running

```bash
pip install -e .

deep-research-agent                          # interactive TUI
deep-research-agent --prompt "What is the release date of Python 3.13?"  # headless
deep-research-agent --list-sessions          # list saved sessions
deep-research-agent --resume <id>            # resume a saved session
```

`main()` checks the active provider's API key before starting and materializes
the config file on first run.

### Provider configuration

Auto-created at `~/.deep-research-agent/config.yaml`; environment variables take
precedence:

- `LLM_PROVIDER` — `anthropic`, `openai`, or `openai-compatible` (auto-detected
  from whichever key is set if unset).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — credentials.
- `ANTHROPIC_MODEL` / `OPENAI_MODEL` — model override.
- `OPENAI_BASE_URL` — endpoint for OpenAI-compatible providers.

Switch models at runtime in the TUI with `/model [provider] <name>`.

## Module layout

| Module | Responsibility |
|--------|----------------|
| `app.py` | Entry point; Textual TUI + headless mode; `build_graph()` returns the compiled Orchestrator engine with a SqliteSaver checkpointer. |
| `engine.py` | The delegation engine: `compile_agent`, `make_tools_node` (quota-enforcing), the auto-injected `delegate_tasks` (agent_id routing + concurrency), `build_engine`. |
| `subagents.py` | `SubAgentConfig` dataclass + `build_agent_tree()` (the strict chain). |
| `prompts.py` | One system prompt per agent (depth, source-quality, anti-looping, stop-early, data-flow, delegation examples). |
| `config.py` | Config, provider/model factory, run-folder singleton (`get_run_dir`), quotas, recursion limit, concurrency. |
| `nodes.py` | The model used by compaction and the `/model` switch (`rebind_model`). |
| `tools/` | `workspace.py` (file tools), `web.py` (search + fetch), `todos.py`, `core.py` (`think_tool`), `truncate.py`, plus per-agent tool groups in `tools/__init__.py`. |
| `evals/` | Eval harness (scorers, judge, runner + `deep-research-agent-eval` CLI). |

## Tests

Run with `pytest` (pyproject sets `pythonpath = ["src"]`):

```bash
cd examples/deep-research-agent && python -m pytest -q
```

| File | Covers |
|------|--------|
| `test_engine.py` | tool withholding, delegate auto-injection, `agent_id` routing (not index-0), scoped delegation (Orchestrator cannot reach Analyzer), concurrent-task aggregation, quota enforcement |
| `test_workspace.py` | run-folder singleton, `_resolve` safety (traversal/absolute/subfolder rejected), read/write round-trip, line ranges, grep, list, todos |
| `test_web_tools.py` | url slugging, fetch writes a flat file + returns the exact filename, no file on failure, same-second collision, bounded output |
| `test_tools.py` | per-agent tool-group membership (the withholding contract at the data level) |
| `test_nodes.py` | model + `rebind_model` helpers |
| `test_truncate.py` / `test_pricing.py` / `test_compact.py` / `test_evals.py` | reused scaffold behaviors |

## Evaluating

```bash
deep-research-agent-eval src/deep_research_agent/evals/cases.example.yaml
deep-research-agent-eval cases.yaml --no-judge   # deterministic only
```

The example cases exercise the delegation chain: a simple lookup that must
`delegate_tasks` (and must NOT call `web_search`, which the Orchestrator does
not have), and a comparative query that delegates and writes `final_report.md`.
These run the agent for real and need a provider key.
