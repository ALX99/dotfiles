---
description: Delegate focused read-only review of the current git diff
argument-hint: "[focus]"
---
Use the subagent tool with agent "reviewer" to review unstaged changes in the current repository for correctness risks, future compatibility issues, and deviations from current structure or standard patterns.

The reviewer should inspect `git status --short`, `git diff`, and relevant untracked files. Do not review staged or committed changes unless they are needed to understand the unstaged diff.

Focus, if supplied: $@

Return the reviewer's findings. Do not edit files.
