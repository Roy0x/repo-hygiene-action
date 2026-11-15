# Repo Hygiene Action

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20](https://img.shields.io/badge/node-20.x-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org)

<!-- After publishing, replace OWNER/REPO in the CI badge URL above with your repository. -->

A single, dependency-light GitHub Action that keeps a repository tidy:

- **Smart issue triage** — labels new issues by keyword, creates missing labels, and welcomes first-time contributors.
- **Conventional PR titles** — enforces `<type>(optional-scope): <description>` and fails the check with actionable feedback.
- **Zero-config PR diff audit** — scans added lines for leftover `console.log`, `debugger;`, `TODO:`, and hard-coded credentials, then posts one summary comment that is updated (never duplicated) on every push.

Everything is bundled into `dist/index.js`, so the action runs instantly with no install step on the runner.

## Installation

The action runs from the committed `dist/index.js` bundle, so consuming workflows need no install or build step.

1. Publish this repository (or a fork of it) on GitHub, keeping `dist/index.js` committed.
2. Reference it from a workflow in the repository you want to keep tidy:

```yaml
name: Repo Hygiene

on:
  issues:
    types: [opened, edited]
  pull_request:
    types: [opened, edited, synchronize]

# Required by the action: read the repo, write labels/comments, write PR comments.
permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  hygiene:
    runs-on: ubuntu-latest
    steps:
      # No checkout is required: the action talks to the GitHub API only.
      - uses: your-org/repo-hygiene-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          enable-issue-triage: 'true'
          enable-pr-title-check: 'true'
          enable-pr-audit: 'true'
          fail-on-audit: 'false'
```

If the action lives in the same repository as your code, use `uses: ./` with a `actions/checkout@v4` step before it.

> **Forked pull requests:** GitHub downgrades `GITHUB_TOKEN` to read-only for `pull_request` runs from forks. The audit still scans and reports findings in the job log, but it cannot post its comment; it warns instead of failing. Use `pull_request_target` (with care) or a bot token if you need comments on fork PRs.

## Inputs

| Input | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `github-token` | ✅ | `${{ github.token }}` | Token for Octokit API calls. Needs `issues: write` and `pull-requests: write`. |
| `enable-issue-triage` | ❌ | `"true"` | Toggles keyword labeling and first-time contributor welcomes on `issues` events. |
| `enable-pr-title-check` | ❌ | `"true"` | Toggles Conventional Commit title enforcement. |
| `enable-pr-audit` | ❌ | `"true"` | Toggles diff scanning for debug leftovers, TODOs, and secrets. |
| `allowed-pr-types` | ❌ | `feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert` | Comma-separated list of accepted commit types. |
| `fail-on-audit` | ❌ | `"false"` | When `"true"`, audit findings call `core.setFailed()` instead of only posting the summary comment. |

All booleans accept `true`/`false`, `yes`/`no`, `1`/`0`, and `on`/`off` (case-insensitive). Unrecognized values log a warning and fall back to the default.

## Outputs

| Output | Description |
| :--- | :--- |
| `labels-applied` | Comma-separated labels applied to the issue (empty when no keyword matched). |
| `pr-title-valid` | `"true"` or `"false"` for the pull request title check. |
| `audit-findings` | Number of audit findings detected in the PR's added lines. |

## What it does

### 1. Smart issue triager (`issues`: `opened`, `edited`)

Scans the issue title and body (case-insensitive, word-boundary aware so `add` does not match `address`, while `crashes`/`errors`/`requested` still match their keywords):

| Keywords | Label | Color |
| :--- | :--- | :--- |
| `bug`, `error`, `crash`, `broken`, `exception` | `bug` | `#d73a4a` |
| `feature`, `enhancement`, `request`, `add` | `enhancement` | `#a2eeef` |
| `docs`, `documentation`, `typo`, `readme` | `documentation` | `#0075ca` |

Missing labels are created in the repository with the colors above before being applied. When a newly opened issue comes from a first-time contributor (`FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, or `NONE`), a short welcome comment describing what to include is posted once.

### 2. Conventional PR title enforcer (`pull_request`: `opened`, `edited`, `synchronize`)

Accepts `<type>(optional-scope): <description>`, with an optional `!` for breaking changes:

```text
feat(parser): support nested arrays
fix: handle empty response bodies
feat(api)!: drop deprecated v1 endpoints
docs(readme): document token permissions
```

If the title is invalid (unknown type, missing description, missing `: `, empty scope), the check fails with the parsed reason, the full list of allowed types, and copy-pasteable examples.

### 3. Zero-config PR diff auditor (`pull_request`: `opened`, `synchronize`)

Fetches every changed file with `pulls.listFiles` (paginated) and inspects only added lines, using hunk headers to report real file line numbers:

- `console.log(`
- `debugger;`
- `TODO:`
- Hard-coded credentials: `sk-…` (OpenAI-style) and `AKIA…` (AWS access key IDs) — **the value is redacted in the comment**

A single marker-tagged comment lists the file, line, pattern, and a short snippet. On later runs the existing comment is updated instead of creating duplicates; when a push clears all findings, the same comment is rewritten as a clean pass. Files without a text patch (binaries, very large diffs) are skipped and counted. Set `fail-on-audit: 'true'` to also fail the workflow.

## Development

```bash
npm install
npm run build    # type-check and compile src/ and test/ to lib/
npm test         # compile, then run the node:test suite
npm run package  # bundle src/index.ts into dist/index.js with ncc
npm run all      # build + package
```

`dist/index.js` must be committed: GitHub runs the bundle directly. CI verifies that the committed bundle matches the sources.

Before pushing an update:

```bash
npm run all
git add dist/index.js
git commit -m "chore: rebuild dist"
```

## License

[MIT](LICENSE)
