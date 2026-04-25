---
name: architect-review
description: Use when reviewing a codebase or module for architectural consistency, file organization, naming conventions, design pattern adherence, or simplicity — especially before major refactors or when onboarding to unfamiliar code. Combines structural review with design pattern fit analysis.
---

# Architect Review

Review a module or codebase for structural soundness: organization, naming, pattern consistency, simplicity, and cross-module coherence. Also evaluate whether the right design patterns are being used for the problems at hand.

**The simplest architecture that works is the correct one.** If you need to explain why something is structured a certain way, it's probably wrong.

**Problem-first, not pattern-matching.** A design pattern finding only fires when there is a named structural problem the pattern would resolve. If the code is simple and works, no pattern is suggested — patterns solve problems, not the other way around.

## Inputs

`/architect-review [pr_number] [scope]`

Both arguments are optional:

- `/architect-review 34` — check out PR #34, review entire diff
- `/architect-review 34 pkg/auth/` — PR #34, focus on that package
- `/architect-review pkg/auth/` — review that directory in the working tree
- `/architect-review staged` — `git diff --cached`
- `/architect-review` — no args, ask what to review

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

- Not a code review — don't report bugs, logic errors, or missing error handling. Use `/risk-review`.
- Not a style review — don't flag formatting, variable names within functions, or comment quality.
- Not a performance review — don't flag slow algorithms unless the architecture forces them.
- Verify every finding by quoting the code. If you can't quote it, drop it.
- Only report design pattern findings where a named structural problem exists in the current code.
- Do not suggest a pattern just because it could apply — it must solve something that is demonstrably broken or painful.
- For Go code, apply `go-code` guidance.
- Research established patterns with `deepwiki` if uncertain what the ecosystem convention is.

## Workflow

1. **Identify the language and ecosystem** — the patterns you evaluate against depend entirely on this. A Go module, a React app, a Neovim plugin each have different conventions.

2. **State what the module does** — one sentence. You can't judge complexity without knowing what problem is being solved.

3. **Read every file** — build a mental model:
   - What is the module boundary and public API surface?
   - Where are types defined?
   - What are the internal and external dependencies?
   - How does data flow through the system?

4. **Find sibling modules** — locate other modules in the codebase that solve similar problems. The target should be consistent with them, not just internally consistent.

5. **Run every check** — all of them, against every file in scope. Record each result (pass or finding) before moving to the next. You cannot skip a check.

6. **Verify every finding** — re-read the relevant code and confirm the issue is real. Quote the specific lines. If you can't point to concrete code, drop the finding.

7. **Report findings and coverage.**

## Checklists

### Naming & Organization

| Check | What to Look For |
|---|---|
| **File names match contents** | Every file contains exactly what its name promises. `session.lua` that also contains diff parsing and keymap setup is a violation. |
| **Consistent naming scheme** | All files follow the same convention (kebab-case, snake_case, PascalCase). Mixed conventions = violation. |
| **No god files** | No file has multiple unrelated responsibilities. If you can't describe what it does in one sentence without "and", it needs splitting. |
| **No orphaned artifacts** | No stale docs, dead config files, unused modules, or planning notes in source. |
| **Directory depth matches complexity** | Flat modules shouldn't be nested. Deep hierarchies shouldn't be flat. Match ecosystem convention. |

### Design Patterns

| Check | What to Look For |
|---|---|
| **Uses established patterns for the language** | Neovim plugins use `M = {}` modules. Go uses exported/unexported packages. React uses components + hooks. Deviations must be justified. |
| **One pattern, used consistently** | If the module uses a pattern (e.g., `M`/`H` split for public/private), every file uses it the same way. |
| **No invented abstractions** | Custom pattern where an established one would work = violation. Don't invent when you can reuse. |
| **Dependency direction is clear** | Dependencies flow one way. Circular requires, lazy requires to break cycles, reaching into another module's internals are all violations. |
| **Types live in one place** | Type definitions centralized or co-located with the data they describe — pick one, apply everywhere. |
| **Minimal public surface** | Enumerate everything exported or returned at the language boundary. Go: every uppercase identifier. Lua: every key on the returned `M` table. Every exposed item not part of the external contract is a violation. |

#### Problem-First Pattern Signals

When evaluating design patterns, only flag a finding if a **named structural problem** exists. Use the tables below as a signal checklist — if a signal fires, read enough context to confirm the problem is real, then verify the suggested pattern would actually resolve it.

**GoF Patterns**

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

**Go Idioms**

| Problem Signal | Pattern |
|---|---|
| Constructor has many optional params (bool flags, scattered defaults) | Functional options |
| Shared behavior across unrelated types forced into struct embedding | Interface-based composition |
| Sequential pipeline of transforms with early exit | `io.Reader`/`io.Writer` chaining |
| Independent work that needs coordination or cancellation | `context` + goroutines + channels |
| Repeated type switches or `interface{}` assertions on a tag field | Typed interface dispatch |

**TypeScript / React**

| Problem Signal | Pattern |
|---|---|
| Component does data fetching, state management, and rendering | Container/Presenter split |
| Logic duplicated across multiple components | Custom hook extraction |
| Props drilled through 3+ levels to reach consumers | Context or component composition |
| Global state managed with scattered `useState` across components | Reducer pattern |
| Component rendering varies by type using nested conditionals | Strategy via render props or polymorphic components |
| Side effects coupled directly to UI events | Command / event-driven separation |

### Solution Design

| Check | What to Look For |
|---|---|
| **Simplest approach to the problem?** | Is there a more direct way to achieve this? Name the simpler alternative concretely. |
| **Abstraction level matches the problem?** | A CRUD wrapper doesn't need a plugin architecture. Complexity must be proportional to the problem. |
| **State shaped correctly for the operations on it?** | A list always searched by key should be a map. Nested structures always flattened should be stored flat. |
| **Responsibilities assigned to the right modules?** | Each piece of logic lives where the data it needs already exists. Reaching across 3 modules to gather inputs = wrong home. |

### Simplicity

| Check | What to Look For |
|---|---|
| **Does each abstraction earn its complexity?** | A wrapper that adds nothing, an indirection layer with one implementation, a config system for two options — all violations. |
| **Nesting depth** | More than 3 levels of callback/async nesting means the flow needs restructuring. |
| **State management** | Shared mutable state is minimal, centralized, and obvious. Hidden state (module-level variables modified by side effects) is a violation. |

### Cross-Codebase Consistency

| Check | What to Look For |
|---|---|
| **Same problem, same solution** | Two modules solving similar problems use the same pattern. One using callbacks while a sibling uses coroutines for the same kind of work = violation. |
| **Same structure for same role** | Modules with the same role have the same file layout, public/private separation, and naming conventions. |
| **Shared concepts use shared definitions** | Same data types, constants, or utilities defined once and imported — not duplicated per module. |
| **Deviations justified by the problem** | A module deviating from the codebase pattern must be because the problem demands it. If you can't name what's different about the problem, the deviation is unjustified. |

## Severity

| Level | Meaning |
|---|---|
| S0 | Architecture fundamentally blocks simplicity or maintainability — god objects, circular deps, invented patterns replacing standard ones, pattern mismatch causing active structural pain |
| S1 | Pattern used inconsistently, naming conventions mixed, types scattered, current approach works but will cause pain as code grows |
| S2 | Could be simpler or clearer but doesn't block work, better pattern exists but current approach is functional |

## Output Format

One-line verdict first: `PASS`, `PASS WITH NOTES`, or `NEEDS WORK`.

For each finding:

> **[S0] Short title**
> `path/to/file:42`
>
> ```
> offending code
> ```
>
> **Issue:** What's wrong, referencing the specific check violated.
> **Pattern:** *(if applicable)* Name of the pattern that resolves this problem and why.
> **Fix:** Concrete structural change.

Then a mandatory **Check Coverage** table — one row per check:

| Category | Check | Result |
|---|---|---|
| Naming | File names match contents | ✓ |
| Naming | No god files | → Finding #1 |
| Design Patterns | Minimal public surface | ✓ |
| Design Patterns | Problem-first pattern signals | ✓ |
| ... | ... | ... |

Every check must appear. A missing row = an unevaluated check = an incomplete review.

End with **Recommendations**: the 2-3 highest-impact structural changes, ordered by effort-to-value ratio.

Clean review:

> No structural issues found. Architecture follows established patterns for [language/ecosystem].
>
> [Check coverage table still required]

## Quality Bar

- No finding without a direct code quote proving the issue exists.
- Every finding references a specific check from the checklist.
- Every S0 finding names the established pattern being violated.
- Check coverage table is mandatory — omitting a row means the check was skipped.
- Do not report bugs — that's `/risk-review`.
- Drop findings that don't survive verification.
- Never suggest a pattern based on a superficial resemblance — confirm the problem signal is real.
- Do not suggest refactors when the current approach is correct.
