# AGENTS.md

Project conventions for agents working in this repo. pi auto-loads this file into
the session, and the workflow agents (planner, refiner, implementer, validator,
shipper) are told to follow it — **prefer the commands and rules here over
guessing**. This file also doubles as the template for the AGENTS.md convention:
drop one with these sections in any project root and the pipeline will respect it.

## Commands

- **Run the unit suite:** `npx tsx --test utils/*/*.test.ts obs/*.test.ts`
- **Syntax-check a file:** `node --experimental-strip-types --check <file>`
- **Type-check:** `npx tsc --noEmit` (covers `utils/`, `extensions/`, `obs/` — it excludes `obs/ui`, which has its own).
- **The obs dashboard is a separate package** — `cd obs/ui` first: `npm test` (139 tests), `npm run typecheck`, `npm run build`. Its build output is untracked, and obs-server serves the *build*, so **editing `obs/ui/src` changes nothing until you rebuild**.
- `just` wraps all of the above — `just verify` runs both suites, both type-checks and a dashboard build.

## Conventions

- TypeScript, 4-space indentation — **except `obs/ui`, which is 2-space**. See `.editorconfig`; match the surrounding file's style, naming, and idioms.
- **Editing by exact match: copy `oldText` verbatim from a fresh read of the file.** Two things in this repo break a retyped match, and both fail with "could not find … must match exactly":
  - the indent split above — guessing the repo's dominant 4 inside `obs/ui` never matches;
  - **Unicode punctuation in source and UI strings** — em dash `—` (U+2014), arrow `→`, ellipsis `…`, middle dot `·`, curly quotes `“ ”`. Retyping them as `--`, `->`, `...`, `.`, `"` never matches. Keep them: the curly quotes and ellipses are user-visible UI text, and the em dashes are house style.
  Re-read immediately before each edit — a file that moved underneath you (a revert, a branch switch) invalidates any text cached earlier in the session.
- Put pure, testable logic in `utils/` (unit-tested); keep `extensions/*.ts` thin wrappers over it.
- Agent definitions are `agents/*.md` (frontmatter + system prompt); skills are `skills/<name>/`.
- Keep changes minimal and focused; don't introduce dependencies without justification.

## Do not

- **Never add a `Co-Authored-By` trailer or any sign-off/footer to commit messages.**
- **No emojis** anywhere — code, docs, agent prompts, or commit messages.
- Don't write outside the working directory.

## Verifying a change

Run the unit suite (`npx tsx --test utils/*/*.test.ts obs/*.test.ts`), typecheck
(`npx tsc --noEmit` — covers utils/, extensions/, obs/), and syntax-check every
changed `.ts` file. A change is done only when the suite passes (currently 967
tests), `tsc` is clean, and the files check clean.

If you touched `obs/ui`, that package is not covered by any of the above: also run
its own `npm test` (139 tests) and `npm run typecheck`, then `npm run build` — the
server serves the build, so an unbuilt change is an unshipped one. `just verify`
runs the whole set.
