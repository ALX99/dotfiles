---
name: zero-tech-debt
description: Rework a change as if the intended UX and architecture existed from day one, deleting compatibility cruft and accidental complexity.
---

# Zero Tech Debt

Rework the change from the intended end state, not from the historical path that produced the current patch nor what the current architecture looks like

## Steps

1. State the intended end state in one to four sentences.

2. Understand what the architecture surrounding the changes looks like.

3. Reshape around the end state and current architecture.
   Prefer to make architectural changes over awkwardly patching current code to realize the end state. Split work only when it creates obvious boundaries such as state, layout, controls, or domain commands.
   If architecture looks good, do not make any changes.

4. Verify the intended flow.
   Test the new behavior and any deleted assumptions that affect application behavior and which cross API boundaries.

## Rules

- Optimize for the code that should exist, not the smallest diff from the old shape.
- Delete dead compatibility paths instead of making them better.
- Do not invent a generic framework for one feature.
- Keep the refactor scoped to what makes the final shape coherent.
