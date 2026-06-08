---
name: lsp
description: Query a Language Server for DIAGNOSTICS (type/compile errors) and code NAVIGATION (go-to-definition, find-references, hover) from the shell, for Python, Go, TypeScript/JS, and PHP. Use to catch type errors on changed files before a full build, and to trace code precisely instead of grepping. Keywords - lsp, diagnostics, type error, type check, go to definition, references, hover, navigation, pyright, gopls, typescript, intelephense.
allowed-tools: Bash
---

# LSP CLI — diagnostics + navigation

## Purpose

`lsp` is a thin, stdlib-only Language Server Protocol client (`lsp.py`). It starts the
right language server for a file, asks it for **diagnostics** (the same type/compile
errors your editor underlines) or **navigation** (definition / references / hover),
prints JSON to stdout, and shuts the server down. No editor, no daemon, no deps.

Positions are **1-based** (line and column), matching `file:line` citations.

## Setup

**1. Put `lsp` on PATH** (one-time):

```bash
bash skills/lsp/install.sh        # links lsp.py -> ~/.local/bin/lsp
```

**2. Install the language server(s) you need** — `lsp` auto-detects by extension and
degrades gracefully (a clear "not installed" note) when one is missing:

| Language | Server (install) | Detected extensions |
|----------|------------------|---------------------|
| TypeScript / JS | `npm i -g typescript-language-server typescript` | `.ts .tsx .js .jsx .mts .cts` |
| Python | `npm i -g pyright` (pyright-langserver), or `pip install python-lsp-server` (pylsp) | `.py` |
| Go | `go install golang.org/x/tools/gopls@latest` | `.go` |
| PHP | `npm i -g intelephense`, or phpactor | `.php` |

Override a language's server with `LSP_SERVER_<EXT>="cmd args"` (e.g.
`LSP_SERVER_PY="pylsp"`). Requires `python3`; no other deps.

## Quick Reference

```bash
lsp diagnostics src/app.ts                 # errors/warnings for one file
lsp diagnostics --changed                  # everything changed vs HEAD (+ untracked)
lsp diagnostics --changed --errors-only    # drop warnings/hints
lsp diagnostics --changed --fail-on-error  # exit 1 if any error (gate a step)
lsp definition src/app.ts 42 17            # where the symbol at line 42, col 17 is defined
lsp references src/app.ts 42 17            # all references to it
lsp hover src/app.ts 42 17                 # type/signature/docs at that position
```

## Notes

- **Diagnostics** opens each file in the server and collects what it publishes; a file
  with no issues reports an empty list. First call on a big project is slow (the server
  indexes); bump `--timeout` (default 15s) for large repos or PHP/Go cold starts.
- **`--changed`** uses `git diff --name-only HEAD` plus untracked files, limited to
  supported extensions. With no files and no `--changed`, it defaults to `--changed`.
- **Navigation** needs the cursor on a real symbol; line/col are 1-based. `definition`
  and `references` return `{file, line, col}`; `hover` returns the server's text.
- **Output** is JSON — reshape with `jq`, e.g.
  `lsp diagnostics --changed | jq -r '.files[].diagnostics[] | "\(.severity) \(.line):\(.col) \(.message)"'`.
- **Graceful** — a missing server or unsupported extension is reported per file, never a crash.

## Workflow

1. After editing, `lsp diagnostics --changed --errors-only` and fix what it finds —
   faster than a full build for catching type errors.
2. To understand code: `lsp definition`/`references`/`hover` instead of grepping for a
   name across the tree.
