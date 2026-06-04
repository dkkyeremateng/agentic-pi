# Commit Skill — Value Proposition

A guided helper for turning the current working-tree changes into a clean,
**Conventional Commits**-style git commit — with safe, intentional staging and
**no push**. It standardizes commit subjects so history stays scannable, and it
stops to ask when which files to commit is ambiguous.

## What the commit skill is

`commit` is a process skill (no CLI or script of its own): it tells the agent to
review `git status`/`git diff`, infer the right `type`/`scope`/`summary`, stage only
the intended files, and run `git commit` — never `git push`. Read it before making
any commit so messages follow one consistent format.

## Core capabilities

- **Conventional Commits subject** — `<type>(<scope>): <summary>` with an imperative,
  ≤ 72-char summary and no trailing period.
- **Optional body** — short paragraphs after a blank line when the change needs
  explanation; no breaking-change markers, footers, or sign-offs.
- **Intentional staging** — stages all changes by default, or only the files/globs
  you specify; asks before committing ambiguous extra files.
- **Argument-aware** — freeform text shapes the scope/summary/body; file paths or
  globs limit what gets committed; both can be combined.
- **Commit-only** — it creates the commit and stops; it never pushes.

## Subject format

`<type>(<scope>): <summary>`

- **type** (required) — `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`.
- **scope** (optional) — short noun for the affected area, e.g. `api`, `parser`, `ui`.
- **summary** (required) — short, imperative, ≤ 72 chars, no trailing period.

## Typical use cases

- A quick, well-formed commit of the current changes without hand-writing the subject.
- Committing only a specific subset of files (paths or globs) while leaving the rest.
- Steering the message with freeform guidance about intent, scope, or body.

## Safety and compliance notes

- **Never pushes** — review and push remain explicit, manual steps.
- Stages **only the intended files**; when extra files are ambiguous, it asks first
  rather than sweeping them in.
- No sign-offs or footers are added by the skill. Note: this environment otherwise
  appends a `Co-Authored-By:` trailer to agent commits — reconcile the two if you
  rely on that convention (see the review note in the repo discussion).

## Quick-start usage snippet

```bash
/commit                                  # commit all current changes, inferred subject
/commit fix the off-by-one in date range # freeform guidance shapes scope/summary/body
/commit src/api.ts src/api.test.ts       # commit only these files
/commit docs README.md update install    # combine files + instructions
```

See [SKILL.md](SKILL.md) for the full format rules and step-by-step procedure.
