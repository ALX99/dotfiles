---
name: commit
description: Create a git commit
argument-hint: [what to commit or "staged files"]
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git diff:*)
---

## Context

- Are there staged files: !`git diff --cached --quiet && echo false || echo true`
- Current git status: !`git status`
- Recent commits: !`git log --oneline -5`

**The user provided the following description of what to commit**

```
$ARGUMENTS
```

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

### Determining what to commit

The git status above is already available — do NOT run `git status` again.

**If arguments say "all":** run `git diff HEAD` to see everything, then stage and commit all changes.

**If arguments specify files or a description:** use the git status above to identify matching files. Only run `git diff HEAD -- <files>` if you don't already know what those changes are about from conversation context.

**If no arguments given:**

1. If there are staged files: you might already know what these changes are from the conversation. If you do, use that context to write the commit message. If not, run `git diff --cached` to see what's staged and use that to inform your commit message.
2. If nothing is staged: ask the user what they'd like to commit, then follow the same logic — use conversation context first, `git diff` only if needed.

**Key principle:** use conversation context and the git status above first. Only run `git diff` as a last resort when you genuinely don't know what changed.
