---
name: create-pr
description: Use when the user asks to create, open, make, draft, raise, or submit a PR / pull request / MR. Triggers on phrases like "create a PR", "open a PR", "make a PR", "draft a PR", "PR this", "raise a pull request", "submit a PR", "push and PR". MUST be used instead of calling `gh pr create` directly.
allowed-tools: Bash(git:*), Bash(gh pr:*)
---

## Context

- Current branch: !`git branch --show-current`
- Default branch: !`gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'`
- Staged changes: !`git diff --cached --stat`
- Unstaged/untracked summary: !`git status --short`
- PR template: !`find . -maxdepth 2 -type f -iname "pull_request_template*" 2>/dev/null | head -1 | xargs cat 2>/dev/null`

**User description:**

```
$ARGUMENTS
```

## Your task

### Step 1 — Determine what goes into the PR

- If there are **staged changes**: commit them now with an appropriate commit message derived from the diff, then proceed.
- If there are **no staged changes**: ask the user what they want included before proceeding. Do not guess or auto-stage.

### Step 2 — Determine the working branch

- If currently on the **default branch**: derive a short, descriptive branch name from the staged diff or user description (conventional format: `type/short-slug`), create it with `git checkout -b <branch>`, then proceed.
- Otherwise: use the current branch as-is.

### Step 3 — Push and open the PR

- Push with `git push -u origin HEAD`.
- Create a draft PR targeting the **default branch** with `gh pr create --draft --base <default> --title "..." --body "..."`. Use a HEREDOC for the body.
- Always target the default branch unless the user explicitly specifies a different base.

### Title

- Max 72 chars, imperative
- Conventional commit style for single logical changes: `type(scope): summary`

### Body

- Fill in the PR template if one exists. Remove sections that don't apply.
- Write like a human would — no exhaustive bullet points, be brief and assume the reader knows the codebase.
