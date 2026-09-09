---
description: Implement or simplify work with the smallest lifecycle failure surface
argument-hint: "[task, change, or scope]"
---
Apply a failure-surface minimization pass:

**Scope:** ${ARGUMENTS:-the current request and relevant code or uncommitted changes}

Complete the scope; do not merely recommend work unless asked for analysis.

## Objective

Deliver required behavior while minimizing lifecycle failure surface: understanding, testing, debugging, maintenance, upgrades, and predictable failure. Do not optimize for fewest lines, variables, functions, types, or visible branches.

A moving part is independently changing state, mode, transition, ordering/concurrency rule, dependency, integration, fallible boundary, retry/fallback/cache/recovery path, configuration, or abstraction. Interactions multiply risk.

## Constraints

- Preserve requested behavior, quality, project constraints, and public interfaces outside scope. Make the smallest coherent change.
- Do not delete required validation, error handling, observability, security, or supported cases; do not hide complexity in dense code, clever expressions, metaprogramming, callbacks, polymorphism, configuration, or another service.
- Do not add retries, fallbacks, caches, compatibility behavior, dependencies, configuration, or extension points without demonstrated need.
- Use repository evidence and established contracts. Handle valid-use failures, not programmer misuse or states excluded by trusted static/framework contracts.

## Required approach

### 1. Establish the contract

Inspect relevant instructions, implementation, callers, tests, data flow, and boundaries. Determine required behavior, valid inputs/failures, invariants, ownership, and demonstrated compatibility. Resolve ordinary ambiguity from evidence; ask only when a material product, architecture, security, or irreversible choice is missing.

### 2. Find relevant failure surface

Look only within scope for duplicate or multi-writer state; invalid flag/optional combinations; scattered transitions; ordering, timing, cleanup, cancellation, or concurrency coupling; mixed effects; silent/broad failure paths; and unnecessary layers, dependencies, or modes.

### 3. Simplify in order

1. Eliminate unneeded capability, mode, state, component, or integration.
2. Derive values from authoritative input.
3. Consolidate unavoidable state under one owner.
4. Constrain valid states explicitly.
5. Centralize transitions and preserve invariants atomically when needed.
6. Localize fallible effects behind narrow boundaries.
7. Reuse existing capabilities.
8. Add dependencies or abstractions only when they reduce more lifecycle risk than they create and have a clear owner.

A new moving part must enable required behavior or remove greater interaction and failure risk. Prefer ordinary code over abstractions that merely relocate decisions. Keep deterministic computation separate from I/O.

Minimize independent mutable state and behavioral dimensions, not branches mechanically. Keep necessary domain and error decisions explicit, local, and testable.

### 4. Bound fallible behavior

Validate dynamic input at ingress, preserve useful error context, and make resource ownership, cleanup, cancellation, and partial success unambiguous. Use timeout/cancellation for legitimately unbounded waits when supported. Retry only demonstrated, safe transient operations with a bound; never mask persistent failure as success.

### 5. Verify

Confirm behavior and public contracts; identify each remaining mutable-state owner; prevent practical drift and invalid combinations; exercise affected transitions, branches, and valid failure paths; add focused tests; run relevant formatting, static, and test checks; review for scope growth.

Before adding state, mode, abstraction, dependency, configuration, retry, fallback, or compatibility path, ask: is it required; can it be eliminated/derived/consolidated; who owns it and coordinates with it; which states and failures it adds; and does it clearly reduce more risk than it adds? If not, do not add it.

## Completion report

Lead with the result. Briefly state behavior preserved/implemented, moving parts avoided or removed, necessary retained complexity and why, validation performed, and material uncertainty.

If no safe simplification exists, say so rather than creating churn.
