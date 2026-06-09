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
# Which servers does this project need, and are they installed? (JSON)
lsp servers                                # relevant to the cwd's files + ✓/✗ install
lsp servers --all                          # every known server, not just relevant ones

# Diagnostics
lsp diagnostics src/app.ts                 # errors/warnings for one file
lsp diagnostics --changed                  # everything changed vs HEAD (+ untracked)
lsp diagnostics --changed --errors-only    # drop warnings/hints
lsp diagnostics --changed --fail-on-error  # exit 1 if any error (gate a step)

# Navigation — give a column, OR --symbol NAME (NAME#N = Nth on the line).
# definition / type-definition / implementation / references include source context.
lsp definition src/app.ts 42 17
lsp definition src/app.ts 42 --symbol foo  # resolve the column from the symbol name
lsp type-definition src/app.ts 42 17
lsp implementation src/app.ts 42 17
lsp references src/app.ts 42 17
lsp hover src/app.ts 42 17

# Symbols
lsp symbols src/app.ts                      # symbols defined in the file
lsp symbols src/app.ts --query Foo          # workspace symbol search (file picks the server)

# Edits — LSP-accurate; prefer over sed/manual for cross-file changes
lsp rename src/app.ts 42 --symbol foo --new-name bar            # rename everywhere (applies)
lsp rename src/app.ts 42 --symbol foo --new-name bar --preview  # show edits, don't write
lsp code-actions src/app.ts 42 17                               # list quick-fixes/refactors
lsp code-actions src/app.ts 42 17 --apply "Add import"          # apply one (title or index)
```

## Notes

- **Diagnostics** opens each file in the server and collects what it publishes; a file
  with no issues reports an empty list. First call on a big project is slow (the server
  indexes); bump `--timeout` (default 15s) for large repos or PHP/Go cold starts.
- **`--changed`** uses `git diff --name-only HEAD` plus untracked files, limited to
  supported extensions. With no files and no `--changed`, it defaults to `--changed`.
- **Project root** is auto-detected from markers (`go.mod`, `tsconfig.json`,
  `composer.json`, `pyproject.toml`, `.git`, …) — so diagnostics are correct even when
  you point at a file deep in a monorepo.
- **Positions** are 1-based; for position commands give a column or `--symbol NAME`
  (`NAME#N` selects the Nth occurrence on the line). `definition`/`references` results
  include a few lines of source context.
- **`rename`** applies edits across all affected files by default (use `--preview` to
  inspect first); **`code-actions`** lists by default (use `--apply`). Prefer these over
  text-based renames — they handle shadowing, re-exports, and cross-file usages.
- **Output** is JSON — reshape with `jq`, e.g.
  `lsp diagnostics --changed | jq -r '.files[].diagnostics[] | "\(.severity) \(.line):\(.col) \(.message)"'`.
- **Graceful** — a missing server or unsupported extension is reported per file, never a crash.

## Workflow

1. After editing, `lsp diagnostics --changed --errors-only` and fix what it finds —
   faster than a full build for catching type errors.
2. To understand code: `lsp definition`/`references`/`hover` instead of grepping for a
   name across the tree.
