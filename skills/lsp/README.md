# LSP Skill — Value Proposition

A token-efficient, stdlib-only Language Server Protocol client (`lsp.py`) that gives
agents two things their editor has but a shell doesn't: **diagnostics** (the exact
type/compile errors a language server reports) and **navigation** (go-to-definition,
find-references, hover) — for Python, Go, TypeScript/JS, and PHP. One REST-of-LSP
call per command, JSON to stdout, no daemon, no dependencies.

## What it is

`lsp <cmd>` starts the right language server for a file over stdio, performs the LSP
handshake, asks one question, prints the answer as JSON, and shuts the server down.

```bash
lsp diagnostics --changed --errors-only   # type errors on changed files, fast
lsp definition src/app.ts 42 17           # jump to a symbol's definition
lsp references src/app.ts 42 17           # find every call site
lsp hover src/app.ts 42 17                # type/signature/docs
```

## Why it matters

- **Implementer** runs `lsp diagnostics --changed` after editing to catch type errors
  *before* a full build — faster feedback, fewer validate-loop round-trips.
- **Scout** uses `definition`/`references`/`hover` to trace code precisely instead of
  grep-guessing call sites.
- Complements (doesn't replace) the validator's full build/test run.

## Design

- **Stdlib only** — JSON-RPC over stdio, no third-party deps (the language *servers*
  are installed separately; see `SKILL.md`).
- **Graceful** — a missing server or unsupported extension is reported per file, never
  a crash. Auto-detects the server by extension; override via `LSP_SERVER_<EXT>`.
- **1-based positions** on the CLI, matching `file:line` citations.

See `SKILL.md` for the command reference and which servers to install.
