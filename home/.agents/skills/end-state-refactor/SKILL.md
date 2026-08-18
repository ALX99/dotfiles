---
name: end-state-refactor
description: Rework a change from its intended user-facing outcome, redesigning internals as needed for a simpler, maintainable end state.
---

# End-State Refactor

Treat the requested user-facing outcome as the specification, not the submitted implementation. Preserve the intended UX, workflows, and externally observable contracts. Treat the patch and current internals as evidence, not design constraints: architecture, abstractions, state models, module boundaries, and implementation-specific tests may be replaced to produce the simplest maintainable final shape.

## Steps

1. Define the target contract.
   State the intended user-facing outcome, workflows, externally observable behavior, non-goals, and acceptance criteria.

2. Map the relevant boundaries.
   Inspect the change, current behavior, callers, public APIs, persisted data, configuration, lifecycle, and tests. Distinguish required external compatibility from replaceable implementation details. Do not infer that current behavior is required merely because it exists.

3. Research concrete design questions.
   Inspect applicable libraries, frameworks, language/runtime features, and platform APIs when they may simplify the target design or remove custom code. Consult official documentation and release notes as needed. Weigh each option against compatibility and maintenance costs.

4. Design and build the final shape from first principles.
   Choose clear ownership, a source of truth, interfaces, state transitions, and failure behavior. Reorganize or replace internals where that produces a simpler, lower-risk result; retain them only when they are already the best fit. Delete obsolete code, tests, configuration, and compatibility paths. Add migrations only where an external contract requires them.

5. Verify the target contract.
   Test intended user workflows, relevant failure paths, external boundaries, and required compatibility or migration behavior. Confirm that remaining mutable state has a clear owner, duplicate representations cannot drift, affected transitions and failure paths are covered, and relevant formatting, static, and test checks pass. Review the final diff for implementation-shaped leftovers and accidental complexity.

## Design Criteria

Optimize for the lowest total lifecycle failure surface, not the fewest lines or smallest diff. Prefer designs that are understandable, testable, debuggable, maintainable, upgradeable, and fail predictably.

When redesigning internals, prefer this order:

1. Eliminate unnecessary capabilities, modes, state, integrations, and compatibility paths.
2. Derive duplicated values from an authoritative input.
3. Consolidate unavoidable mutable state under one clear owner and source of truth.
4. Constrain valid states and centralize their transitions.
5. Localize fallible external effects behind narrow, explicit boundaries.
6. Reuse suitable capabilities already in the platform or current stack.
7. Add abstractions, dependencies, configuration, retries, or fallbacks only when they clearly remove more risk than they add.

Internal redesign is permission, not an obligation. Do not create unrelated churn when the existing shape is already the lowest-risk fit.

## Rules

- Optimize for the code that should exist, not the smallest diff from the old shape.
- Preserve intentional user-facing behavior and externally observable contracts; freely replace their internal implementation.
- Do not let the current patch or architecture constrain the target design.
- Delete dead compatibility paths instead of making them better.
- Do not invent a generic framework for one feature.
- Keep the refactor scoped to what makes the final shape coherent.
- Treat the existing implementation and its assumptions as untrusted until verified by code, tests, documentation, and relevant callers.
- Do not treat author intent, existing architecture, or passing narrow tests as evidence that a design is correct.
- Treat implementation-coupled tests as evidence, not a contract; replace them with behavioral coverage where appropriate.
- Report material risks to correctness, security, compatibility, maintainability, and failure recovery with evidence and a recommended fix.
