---
name: design-review
description: Use when reviewing code to determine if the right design patterns are being used for the job — GoF patterns, Go idioms, and TypeScript/React patterns. Invoke with a PR number, staged changes, file paths, or a description of what to review.
---

# Design Review

Review code for pattern fit: are the right design patterns being used for the problems at hand?

**Problem-first, not pattern-matching.** A finding only fires when there is a named structural problem the pattern would resolve. If the code is simple and works, no pattern is suggested — patterns solve problems, not the other way around.

## Inputs

`/design-review [pr_number] [scope]`

Both arguments are optional:

- `/design-review 34` — check out PR #34, review entire diff
- `/design-review 34 auth package` — PR #34, focus on auth package
- `/design-review pkg/events/` — review those files in the working tree
- `/design-review staged` — `git diff --cached`
- `/design-review` — no args, ask what to review

**`pr_number`** — If the first argument is a number, treat it as a GitHub PR:

```bash
gh pr view <number> --json number,title,body,headRefName,baseRefName,author
gh pr diff <number>
gh pr checkout <number>
```

**`scope` only (no PR)** — Derive from description:
- File or directory paths → read those files
- "staged" / "staged changes" → `git diff --cached`
- "last commit" / commit SHA → `git show <ref>`
- Branch name → `git diff main...<branch>`
- General description → find and read relevant code

## Rules

- Only report findings where a named structural problem exists in the current code.
- Do not suggest a pattern just because it could apply — it must solve something that is demonstrably broken or painful.
- Simple code that works is correct. Complexity must be justified by a real problem.
- Verify claims by reading the code. Do not infer from file names or function signatures alone.
- For Go code, apply `go-code` guidance.

## Problem Signal Checklists

### GoF Patterns

| Problem Signal | Pattern |
|---|---|
| New variants require editing existing switch/if chains | Factory / Strategy |
| Object construction is complex, multi-step, or has many optional parts | Builder |
| Operations need to be undoable, queued, logged, or retried | Command |
| Objects notify dependents on state change via manual polling or tight coupling | Observer |
| Incompatible interfaces need to work together | Adapter |
| Subsystem is complex but callers only need a simple entry point | Facade |
| Behavior changes based on internal state transitions | State |
| Type has an explosion of subclass combinations | Bridge |
| Object wraps another to add behavior without subclassing | Decorator |
| Tree structures where leaves and composites must be treated uniformly | Composite |

### Go Idioms

| Problem Signal | Pattern |
|---|---|
| Constructor has many optional params (bool flags, scattered defaults) | Functional options |
| Shared behavior across unrelated types forced into struct embedding | Interface-based composition |
| Sequential pipeline of transforms with early exit | `io.Reader`/`io.Writer` chaining |
| Independent work that needs coordination or cancellation | `context` + goroutines + channels |
| Repeated type switches or `interface{}` assertions on a tag field | Typed interface dispatch |

### TypeScript / React

| Problem Signal | Pattern |
|---|---|
| Component does data fetching, state management, and rendering | Container/Presenter split |
| Logic duplicated across multiple components | Custom hook extraction |
| Props drilled through 3+ levels to reach consumers | Context or component composition |
| Global state managed with scattered `useState` across components | Reducer pattern |
| Component rendering varies by type using nested conditionals | Strategy via render props or polymorphic components |
| Side effects coupled directly to UI events | Command / event-driven separation |

## Workflow

1. **Get the code** — PR checkout if a number was given, otherwise derive from scope (see Inputs).

2. **Understand what the code is doing** — read full implementations, not just diffs. Build a mental model of what problem each changed area is solving.

3. **Scan for problem signals** — check every changed file against the checklists above. For each signal that fires, read enough context to confirm the problem is real (not just superficially similar).

4. **Verify the pattern would help** — ask: does applying this pattern actually resolve the identified problem? Does it simplify, decouple, or remove the pain? If not, drop the finding.

5. **Report findings.**

## Severity

| Level | Meaning |
|---|---|
| D0 | Pattern mismatch causing active structural pain — extension requires modifying existing logic, tight coupling breaking boundaries, state machine without a state pattern causing impossible-to-follow transitions |
| D1 | Current approach works but will cause pain as the code grows — missing abstraction that's already being worked around |
| D2 | Better pattern exists; current approach is functional but the pattern would meaningfully improve clarity or extensibility |

## Output Format

For each finding:

> **[D0] Short title**
> `path/to/file.go:42`
>
> ```go
> offending code
> ```
>
> **Problem:** What structural pain exists in the current code.
> **Pattern:** Name of the pattern and why it resolves this specific problem.
> **Change:** Concrete description of what to restructure.

Clean review:

> No pattern mismatches found. Code uses appropriate designs for the problems at hand.

## Quality Bar

- No finding without a named structural problem quoted from the code.
- No pattern suggestions for simple code that works.
- Never suggest a pattern based on a superficial resemblance — confirm the problem signal is real.
- Do not suggest refactors when the current approach is correct.
