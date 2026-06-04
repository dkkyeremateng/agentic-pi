# GitHub Skill — Value Proposition

A token-efficient wrapper around the official [`gh` CLI](https://cli.github.com/)
for working with GitHub from the shell — issues, pull requests, CI/workflow runs,
and anything else through `gh api`. It keeps no MCP tool schemas in context: you run
one `gh` command and get back plain text or JSON, ready to pipe to `jq`.

## What the GitHub skill is

`github` is a thin convention over the pre-installed `gh` CLI (no custom script).
It standardizes the common workflows — checking a PR's CI, reading why a run failed,
listing and reading issues/PRs, and reaching arbitrary endpoints via `gh api` — and
reminds you to target a repo explicitly with `--repo owner/repo` (or a full URL)
when you are not inside that repository's working tree.

## Core capabilities

- **Token-efficient CLI** — no tool schemas in context; text or JSON out, `--jq` in.
- **Pull requests** — `gh pr checks <n>` (CI status), `gh pr view <n>`, plus
  `gh pr create` / `gh pr review` for opening and reviewing PRs.
- **CI / workflow runs** — `gh run list`, `gh run view <id>`, and
  `gh run view <id> --log-failed` to jump straight to the failing step's logs.
- **Issues** — `gh issue list` / `gh issue view <n>` / `gh issue create` /
  `gh issue comment`.
- **API escape hatch** — `gh api <endpoint> --jq '<filter>'` for anything the
  subcommands don't cover.
- **Repo targeting** — `--repo owner/repo` or a full GitHub URL when outside a git
  checkout; most commands accept `--json` for structured output.

## Authentication

- `gh` handles auth itself: run `gh auth login` once, or set a token via
  `GH_TOKEN` / `GITHUB_TOKEN` in the environment (handy in CI).
- Check the current state with `gh auth status`.
- Scope tokens to least privilege — read-only for queries, write only when you
  actually create/merge/close.

## Typical use cases

- **Debug failing CI** — `gh pr checks` to spot the red check, then
  `gh run view <id> --log-failed` to read only the broken step.
- **PR workflow** — open with `gh pr create`, inspect with `gh pr view`, and
  approve / request changes with `gh pr review`.
- **Issue triage** — list, read, create, and comment on issues from the shell.
- **Ad-hoc queries** — pull fields the subcommands don't expose via `gh api` + `jq`.

## Safety and compliance notes

- Treat `GH_TOKEN` / `GITHUB_TOKEN` as a secret — keep it in the environment or a
  git-ignored `.env`, never in committed code or logs.
- Mutating commands (`pr create`, `pr merge`, `issue create`, `issue close`,
  `pr review`) change real repository state — confirm the target repo/number first.
- Prefer least-privilege token scopes; use read-only access for status and queries.

## Quick-start usage snippet

```bash
gh auth status                                   # verify auth

# CI on a PR, then dig into a failure
gh pr checks 55 --repo owner/repo
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo --log-failed

# Issues and PRs as JSON, filtered with --jq
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

See [SKILL.md](SKILL.md) for the command reference.
