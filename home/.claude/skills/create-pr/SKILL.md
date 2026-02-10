---
name: create-pr
description: Create a pull request
allowed-tools: Bash(git:*), Bash(gh pr:*)
---

## Context

- Current branch: !`git branch --show-current`
- PR template: !`find . -maxdepth 2 -iname "pull_request_template*" -type f -exec cat {} \; -quit`

**User description:**

```
$ARGUMENTS
```

## Your task

- Create a draft PR with `gh pr create --draft --title "..." --body "..."`. Use a HEREDOC for the body.
- Make sure to follow the PR template if one exists.

`gh pr create` handles pushing the branch automatically — don't push manually.

### Title

- Max 72 chars, imperative
- Conventional commit style for single logical changes: `type(scope): summary`

### Body

- Fill in the PR template if one exists. Remove sections that don't apply.

### Rules

- If on the default branch, ask which branch to use.
- Write the body like a human would, no execise of bullet points, be brief and assume the reader knows the codebase.
