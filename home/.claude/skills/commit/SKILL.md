---
name: commit
description: Create a git commit
argument-hint: [what to commit or "staged files"]
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git diff:*)
---

## Context

- Are there staged files? !`git diff --cached --quiet && echo "**No**" || echo "**Yes**"`
- The user provided the following description of what to commit: `$ARGUMENTS` (if empty, assume "staged changes")

### `git status -s` output

!`git status -s`

## Your task

Create a single git commit using **Conventional Commits** format:

```
<type>(<scope>): <short summary>
```

- **type**: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`, `build`
- **scope**: optional, the area of the codebase (e.g. `nvim`, `tmux`, `shell`, `backend`)
- **summary**: imperative, lowercase, no period, entire title max 50 chars

If the changes span multiple unrelated areas, pick the most significant one for the type/scope. Add a body only if the "why" isn't obvious from the summary.

Do not send any other text or messages besides tool calls (except when asking the user what to commit).
