---
name: create-pr
description: Create a pull request. Use this skill whenever the user asks to create a PR or pull request — do not use `gh pr create` directly.
allowed-tools: Bash(git:*), Bash(gh pr:*)
---

## Context

- Current branch: !`git branch --show-current`
- PR template: !`fd -d 2 -i -t f "pull_request_template" | head -1 | xargs cat 2>/dev/null`

**User description:**

```
$ARGUMENTS
```

## Your task

- Push the branch first with `git push -u origin HEAD`.
- Then create a draft PR with `gh pr create --draft --title "..." --body "..."`. Use a HEREDOC for the body.
- Make sure to follow the PR template if one exists.

### Title

- Max 72 chars, imperative
- Conventional commit style for single logical changes: `type(scope): summary`

### Body

- Fill in the PR template if one exists. Remove sections that don't apply.

### Rules

- If on the default branch, ask which branch to use.
- Write the body like a human would, no execise of bullet points, be brief and assume the reader knows the codebase.
