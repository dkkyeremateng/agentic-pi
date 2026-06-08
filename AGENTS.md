# AGENTS.md

Project conventions for agents working in this repo. pi auto-loads this file into
the session, and the workflow agents (planner, refiner, implementer, validator,
shipper) are told to follow it — **prefer the commands and rules here over
guessing**. This file also doubles as the template for the AGENTS.md convention:
drop one with these sections in any project root and the pipeline will respect it.

## Commands

- **Run the unit suite:** `npx tsx --test utils/*.test.ts`
- **Syntax-check a file:** `node --experimental-strip-types --check <file>`
- **Do NOT use `tsc`** for type-checking — the type packages aren't installed here; it does not work. Use the syntax check above.

## Conventions

- TypeScript, 4-space indentation; match the surrounding file's style, naming, and idioms.
- Put pure, testable logic in `utils/` (unit-tested); keep `extensions/*.ts` thin wrappers over it.
- Agent definitions are `agents/*.md` (frontmatter + system prompt); skills are `skills/<name>/`.
- Keep changes minimal and focused; don't introduce dependencies without justification.

## Do not

- **Never add a `Co-Authored-By` trailer or any sign-off/footer to commit messages.**
- **No emojis** anywhere — code, docs, agent prompts, or commit messages.
- Don't write outside the working directory.

## Verifying a change

Run the unit suite (`npx tsx --test utils/*.test.ts`) and syntax-check every
changed `.ts` file. A change is done only when the suite passes (currently 265
tests) and the files check clean.
