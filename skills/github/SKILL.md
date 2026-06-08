---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries."
allowed-tools: Bash
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output.  You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```

## Reconnaissance (read-only) — scouting a remote repo

Map a GitHub repo you are not checked out in. Read/query commands only — never
write (no commit, push, PR/issue create, comment, merge). Cite `owner/repo path:line`
(or the GitHub URL) as evidence, exactly like a local `file:line`.

```bash
gh repo view owner/repo                                               # description, default branch, languages
gh api repos/owner/repo/git/trees/<branch>?recursive=1 --jq '.tree[].path'  # full file tree (orient on structure)
gh api repos/owner/repo/contents/<path> --jq '.content' | base64 -d  # read a file's contents
gh search code '<query>' --repo owner/repo                           # locate definitions/call sites (remote grep)
gh pr view <n> --repo owner/repo                                     # a specific PR's metadata
gh pr diff <n> --repo owner/repo                                     # a specific PR's change
```
