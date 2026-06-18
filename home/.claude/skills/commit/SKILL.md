---
name: commit
description: Create a git commit. Use whenever you or the user wants to create a commit.
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
- **summary**: imperative, lowercase, no period, max 50 chars (hard limit 72)

**Litmus test**: a new contributor should understand the problem, why it matters, and the impact without opening files or reading the diff. Avoid code identifiers, filenames, and function names in the summary unless they ARE the user-facing impact.

- Bad: `Add NameFromHex with sync.Once lazy init`
- Good: `Improve color name lookup performance while keeping startup fast`
- Bad: `fix: nil pointer in session.go`
- Good: `fix: prevent session loading from crashing on missing metadata`

Draft 1-2 sentences focused on the "why" and outcome, not a list of files or implementation details. Use clear verbs: `add` (new capability), `update` (enhancement), `fix` (bug fix). Add a body only when the "why" isn't obvious from the summary; wrap body lines at 72 chars.

If the changes span multiple unrelated areas, pick the most significant one for the type/scope.

Do not send any other text or messages besides tool calls (except when asking the user what to commit).
