---
name: architect-review
description: Use when reviewing a codebase or module for architectural consistency, file organization, naming conventions, design pattern adherence, solution design approach, or simplicity - especially before major refactors or when onboarding to unfamiliar code.
---

# Architect Review

Review architecture for **consistency, simplicity, and established pattern adherence** — both in how code is organized and in how problems are solved. This is not a bug hunt or code review — it evaluates structural and design decisions.

## Guiding Principle

**The simplest architecture that works is the correct one.** If you need to explain why something is structured a certain way, it's probably wrong. Established patterns exist because they solve known problems — use them instead of inventing alternatives.

## Inputs

- Expected invocation: `/architect-review <path>`
- `<path>` is a directory or file to review. Defaults to current working directory.
- Ask for `<path>` if ambiguous.

## What This Is NOT

- **Not a code review.** Don't report bugs, logic errors, or missing error handling. That's `/pr-review`.
- **Not a style review.** Don't flag formatting, variable names within functions, or comment quality.
- **Not a performance review.** Don't flag slow algorithms unless the architecture forces them.

## Workflow

1. **Identify the language and ecosystem.** The established patterns you evaluate against depend entirely on this. A Go module, a React app, a Neovim plugin, and a Python package each have well-known conventions. Research them with `deepwiki` if uncertain.

2. **Understand the problem being solved.** Before evaluating the solution, state in one sentence what the module does. This frames every subsequent check — you can't judge if a solution is too complex without knowing what problem it solves.

3. **Map the architecture.** Read every file. Build a mental model:
   - What is the module boundary? What's the public API surface?
   - What are the data types and where are they defined?
   - What are the dependencies (internal and external)?
   - What is the flow of data through the system?

4. **Scan the broader codebase for similar modules.** Before judging the target in isolation, find sibling modules, packages, or components that solve similar problems. How do they structure their code? What patterns do they use? The target module should be consistent with the rest of the codebase — not just internally consistent, but consistent with how the same kinds of problems are solved elsewhere.

5. **Run each check** from the review checklist below. Be exhaustive — check every file against every applicable rule.

6. **Verify every finding.** Before reporting any issue, re-read the relevant code and confirm the issue is real. Quote the specific lines that prove it. If you cannot point to concrete code that demonstrates the problem, drop the finding — it's not real. Do not report issues from memory or inference; only report what you can prove by reading the code.

7. **Emit findings** using the output format.

## Review Checklist

### Naming & Organization

| Check | What to Look For |
|-------|-----------------|
| **File names match contents** | Every file should contain exactly what its name promises. A file named `session.lua` that also contains diff parsing, type definitions, and keymap setup is a violation. |
| **Consistent naming scheme** | All files in a module should follow the same convention (kebab-case, snake_case, PascalCase — whatever the ecosystem uses). Mixed conventions = violation. |
| **No god files** | No file should have multiple unrelated responsibilities. If you can't describe what a file does in one sentence without "and", split it. |
| **No orphaned artifacts** | No stale docs, dead config files, unused modules, or planning notes checked into source. They mislead readers and LLMs. |
| **Directory depth matches complexity** | Flat modules shouldn't be nested. Deep hierarchies shouldn't be flat. Match the ecosystem convention. |

### Design Patterns

| Check | What to Look For |
|-------|-----------------|
| **Uses established patterns for the language** | Every language/ecosystem has standard ways to organize code. Neovim plugins use `M = {}` modules. Go uses packages with exported/unexported. React uses components + hooks. Python uses packages with `__init__.py`. Deviations must be justified. |
| **One pattern, used consistently** | If the module uses a pattern (e.g., `M`/`H` split for public/private), every file must use it the same way. A file that puts private functions on `M` with underscore prefixes instead of using `H` breaks consistency. |
| **No invented abstractions** | If a custom pattern exists where an established one would work, that's a violation. Don't invent when you can reuse. |
| **Dependency direction is clear** | Dependencies should flow one way. Circular requires, lazy requires to break cycles, and reaching into another module's internals are all architectural smells. |
| **Types live in one place** | Type definitions scattered across files force readers to grep. Centralize them or co-locate them with the data they describe — pick one, apply it everywhere. |

### Solution Design

| Check | What to Look For |
|-------|-----------------|
| **Is this the simplest approach to the problem?** | Restate what the module does, then ask: is there a more direct way to achieve this? A callback chain managing async state might be replaceable by coroutines. A hand-rolled observer might be a simple event emitter. A class hierarchy might be a lookup table. Name the simpler alternative concretely. |
| **Are there established design patterns for this problem?** | Most problems have known solutions in the language's ecosystem. State machines for lifecycle management, iterators for sequential processing, middleware for request pipelines, pub/sub for decoupled communication. If the code invents a custom mechanism where a well-known pattern fits, that's a violation. Research with `deepwiki` if unsure what patterns exist. |
| **Does the abstraction level match the problem?** | A CRUD wrapper doesn't need a plugin architecture. A simple transform doesn't need a pipeline framework. The solution complexity should be proportional to the problem complexity. Over-engineering for future extensibility that hasn't been needed is a violation. |
| **Is state shaped correctly for the operations on it?** | If every operation has to transform, filter, or re-derive state before using it, the state is shaped wrong. Data structures should make the common operations trivial. A list that's always searched by key should be a map. Nested structures that are always flattened should be stored flat. |
| **Are responsibilities assigned to the right modules?** | Each piece of logic should live where the data it needs already exists. If a function reaches across 3 modules to gather its inputs, it either belongs in a different module or the data flow needs restructuring. |

### Simplicity

| Check | What to Look For |
|-------|-----------------|
| **Could this be simpler?** | For every abstraction, ask: does this earn its complexity? A wrapper that adds nothing, an indirection layer with one implementation, a config system for two options — all violations. |
| **Nesting depth** | More than 3 levels of callback/async nesting means the flow should be restructured. Extract stages, use sequential async, or flatten the logic. |
| **API surface area** | The public API should be as small as possible. If most functions in a module are public, the boundary is wrong. |
| **State management** | Shared mutable state should be minimal, centralized, and obvious. Hidden state (module-level variables modified by side effects) is a violation. |

### Cross-Codebase Consistency

| Check | What to Look For |
|-------|-----------------|
| **Same problem, same solution** | If two modules in the codebase solve a similar problem (e.g., async data fetching, state management, UI rendering), they should use the same pattern. One module using callbacks while a sibling uses coroutines for the same kind of work is a violation. |
| **Same structure for same role** | Modules with the same role (e.g., two Neovim plugins, two API clients, two CLI tools) should have the same file layout, the same public/private separation, and the same naming conventions. If one has `init.lua` + flat modules and another has a nested hierarchy for no reason, that's a violation. |
| **Shared concepts use shared definitions** | If multiple modules use the same data types, constants, or utilities, those should be defined once and imported — not duplicated or reinvented per module. |
| **Deviations are justified by the problem, not by author** | When one module deviates from the pattern used everywhere else, it should be because the problem demands it — not because it was written at a different time or by a different person. If you can't name what's different about the problem, the deviation is unjustified. |

### LLM & Reader Comprehension

| Check | What to Look For |
|-------|-----------------|
| **Can you understand each file in isolation?** | A file that requires reading 3 other files to understand is poorly bounded. Dependencies should be explicit via requires/imports, not implicit via shared state or convention. |
| **Are external API surfaces documented?** | When depending on another module's internals, the expected API surface must be documented. Reaching into `codediff.ui.lifecycle` seven times without documenting what you expect from it means any change breaks you silently. |
| **Is the data flow traceable?** | A reader should be able to trace a user action from entry point to effect without jumping through more than 2-3 files. |
| **No dead code or commented-out blocks** | Dead code actively harms comprehension. It signals uncertainty about the design. Remove it. |

## Severity

- `S0` — **Structural.** Architecture fundamentally blocks simplicity or maintainability (god objects, circular deps, invented patterns replacing standard ones).
- `S1` — **Consistency.** Pattern used inconsistently, naming conventions mixed, types scattered.
- `S2` — **Clarity.** Could be simpler or more readable but doesn't block work (deep nesting, undocumented external deps).

## Output Format

Start with a one-line verdict: `PASS`, `PASS WITH NOTES`, or `NEEDS WORK`.

Then list findings:

```text
---
1. [S0] <short title>
File: <path>:<line>
Evidence: <quote the actual code that proves this issue exists>
Issue: <what's wrong, referencing the specific check violated>
Pattern: <the established pattern that should be used instead>
---
2. [S1] <short title>
File: <path>:<line>
Evidence: <quote the actual code>
Issue: <what's wrong>
Fix: <specific structural change>
---
```

End with a **Recommendations** section: the 2-3 highest-impact structural changes, ordered by effort-to-value ratio.

If no material issues:

```text
PASS
No structural issues found. Architecture follows established patterns for [language/ecosystem].
```

## Quality Bar

- **No finding without evidence.** Every finding must include a direct code quote proving the issue exists. If you can't quote the code, you can't report the finding. Re-read the file before reporting.
- Every finding must reference a specific check from the checklist.
- Every S0 finding must name the established pattern being violated.
- Do not suggest rewrites when the current structure is correct.
- Do not report bugs — that's a different review.
- **Drop findings that don't survive verification.** If re-reading the code reveals the issue isn't what you thought, discard it silently. False positives erode trust in the review.
