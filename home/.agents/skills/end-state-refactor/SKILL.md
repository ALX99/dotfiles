---
name: end-state-refactor
description: Turn an accepted prototype or existing implementation into the simplest maintainable end state while preserving intended external behavior. Use for a final architecture pass when current internals may be replaced.
---

# End-State Refactor

Use the accepted external outcome as the contract, not the current implementation. Treat the patch, architecture, and implementation-specific tests as evidence. Internal design and affected callers may be replaced.

Simplicity means the lowest lifecycle failure surface, not the least code or smallest diff. Reduce independently changing state, modes, boundaries, dependencies, and compatibility paths, especially their interactions.

## Process

1. **Recover the contract and compatibility needs.** Inspect the user-named session, commits, changes, or subsystem together with intent, callers, public APIs, persisted data, documentation, tests, and running behavior when practical. Identify workflows, refresh or restart behavior, and failure semantics. Stated intent outranks an incomplete prototype. Determine whether the work is unreleased or has real consumers or data; ask when evidence conflicts materially, that status is unclear, or external behavior would change.
2. **Characterize important behavior.** Before a risky redesign, add public-boundary tests for accepted behavior that lacks useful coverage. Replace implementation-coupled tests with idiomatic behavioral and invariant tests.
3. **Design the final shape.** Map the moving parts and their interactions. Simplify in order: eliminate, derive, consolidate ownership, constrain valid states, localize effects, reuse proven capabilities, then add only when justified. Challenge the obvious local cleanup with one more fundamental alternative. For major changes, check current official guidance and recent release notes only where they inform a concrete design decision.
4. **Implement directly.** Briefly state the recovered contract and intended redesign, then proceed unless a material external decision remains. Rework shared internals and all affected callers when needed for coherence. Delete superseded code, tests, configuration, compatibility paths, and disposable state. Do not add speculative migrations. Ask before breaking real consumers or data, or before upgrading supported versions; explain the benefit.
5. **Verify and report.** Exercise affected workflows and failures, operate the feature when practical, run relevant checks, and review the diff for prototype leftovers. Report external behavior preserved or intentionally changed, moving parts removed, resulting ownership and architecture, necessary complexity retained, and validation performed.

## Rules

- Preserve required behavior, quality, correctness, security, and external contracts. Necessary complexity must earn its cost through demonstrated correctness, reliability, security, or meaningful performance.
- Give state one authority. Derive mirrored or duplicated values, and store only state with independent meaning. Make invalid states unrepresentable where practical.
- Prefer direct control flow and orchestration over indirection. Abstract a stable repeated concept, not a hypothetical future need; three similar uses is a heuristic, not a rule. Use configuration only for real repeated variation.
- Keep code together when it changes together. Split responsibilities when they are reused or change independently. Prefer current language and framework idioms over accidental local patterns.
- Validate dynamic input at ingress, then rely on trusted internal types and contracts. Keep deterministic logic separate from fallible effects, but do not introduce layers solely for testing.
- Remove caches, fallbacks, retries, background processes, compatibility paths, and observability without a demonstrated requirement. Prefer explicit failure to an unsupported recovery mode.
- Prefer the platform or current stack first, then a mature dependency over substantial custom machinery. Every new moving part must enable required behavior or remove greater lifecycle risk.
- If the current design appears optimal, make one deliberate pass for a more fundamental simplification. If none exists, avoid churn; make only useful idiomatic or readability improvements and say that no major redesign was warranted.
