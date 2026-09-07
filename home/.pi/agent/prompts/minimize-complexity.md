---
description: Implement or simplify work with the smallest lifecycle failure surface
argument-hint: "[task, change, or scope]"
---
Apply a failure-surface minimization pass to the following scope:

**Scope:** ${ARGUMENTS:-the current request and its relevant code or uncommitted changes}

Complete the scoped work; do not merely recommend improvements unless the scope explicitly asks for analysis only.

## Objective

Deliver the required behavior correctly while minimizing the software's total lifecycle failure surface. Optimize for understandability, testability, debugging, maintenance, upgrades, and predictable failure—not for the fewest lines, variables, functions, types, or visible `if` statements.

Treat every independently changing moving part as a source of complexity. Moving parts include:

- Mutable, persisted, cached, global, remote, or configuration state
- Duplicate representations and multiple sources of truth
- Flags, modes, nullable combinations, lifecycle phases, and conditional behavior
- State transitions, ordering constraints, temporal coupling, concurrency, and asynchronous work
- Dependencies, services, processes, integrations, and ownership boundaries
- Abstraction layers, extension points, custom frameworks, and indirect control flow
- Network, filesystem, database, process, parser, and other fallible boundaries
- Retries, fallbacks, caches, recovery mechanisms, compatibility paths, and migrations

Their interactions matter more than their raw count. Independent behavioral dimensions combine multiplicatively, so prefer designs that eliminate dimensions or constrain their valid combinations.

## Non-negotiable constraints

- Preserve the requested behavior, necessary quality, project constraints, and public interfaces outside the authorized scope.
- Make the smallest coherent change. Do not use this prompt as permission for an unrelated rewrite or speculative cleanup.
- Do not obtain apparent simplicity by deleting required functionality, validation, error handling, observability, security controls, or supported cases.
- Do not hide complexity in dense code, clever branchless expressions, metaprogramming, generic abstractions, configuration, callbacks, polymorphism, or another service.
- Do not add retries, fallbacks, caches, compatibility behavior, defensive branches, dependencies, configuration, or extension points “just in case.”
- Prefer explicit, ordinary code when an abstraction would merely relocate a decision rather than remove duplication or interaction risk.
- Follow repository evidence and established contracts. Handle failures possible during valid use, but do not design around programmer misuse or states excluded by trusted static and framework contracts.

## Required approach

### 1. Establish the actual contract

Before editing, inspect the relevant project instructions, implementation, callers, tests, data flow, and boundary contracts. Determine:

- What behavior must remain
- Which inputs and failures are valid parts of the contract
- Which invariants must always hold
- Who owns each relevant resource and piece of state
- Which compatibility constraints are demonstrated rather than merely imagined

Resolve ordinary ambiguity from repository evidence. Ask only when a missing decision materially changes product behavior, architecture, security, or an irreversible action.

### 2. Identify the scoped failure surface

For the relevant code, look specifically for:

- State that can be removed, derived, made immutable, or scoped more narrowly
- Values represented in multiple places that can drift out of sync
- State with multiple writers or unclear ownership
- Boolean flags or optional fields whose combinations create implicit modes or invalid states
- Transitions spread across multiple functions or components
- Behavior dependent on call order, timing, initialization, cleanup, cancellation, or prior operations
- Branches that exist only to coordinate duplicated state, compatibility paths, or accidental modes
- External effects mixed into otherwise deterministic logic
- Broad exception handling, silent fallback, unbounded retry, or ambiguous partial success
- New layers, dependencies, services, or configuration that cost more than the capability they provide

Investigate only risks relevant to the requested scope; do not perform a generic audit of the entire repository.

### 3. Simplify in this priority order

1. **Eliminate:** Remove an unnecessary capability, mode, state value, component, or integration when the contract does not require it.
2. **Derive:** Compute a value from its authoritative input instead of storing and synchronizing another representation.
3. **Consolidate:** Give unavoidable state one clear owner and source of truth. Avoid bidirectional synchronization and multiple writers.
4. **Constrain:** Model only valid states. Prefer one explicit enum, tagged union, or state model over interacting booleans and nullable combinations when the domain has distinct modes.
5. **Centralize transitions:** Keep state changes near their owner, preserve invariants across each transition, and make multi-part transitions atomic when the platform supports it and correctness requires it.
6. **Localize effects:** Keep deterministic computation separate from fallible I/O and place external effects behind narrow, explicit boundaries.
7. **Reuse:** Prefer a suitable capability already present in the language, platform, framework, or current stack.
8. **Add only when justified:** Introduce a dependency or abstraction only when it removes more lifecycle risk than it creates and has a clear owner.

Do not introduce a new moving part unless it enables required behavior or removes greater interaction and failure risk.

### 4. Treat state and branching correctly

Minimize **independent mutable state and behavioral dimensions**, not variables or branches mechanically.

- A pure, explicit branch over an input is usually cheaper than hidden mutable state or indirect dispatch.
- Necessary domain decisions and error paths should remain visible, local, and testable.
- Eliminate branches caused by duplicated state, overlapping flags, accidental modes, or repeated policy decisions.
- Express the same decision in one authoritative place rather than reproducing its condition across callers.
- Prefer an explicit state machine with constrained transitions over scattered flags when behavior genuinely depends on lifecycle state.
- Do not replace readable control flow with boolean arithmetic, lookup indirection, exception-driven flow, or premature polymorphism merely to lower visible branch count.

State minimization may reduce branching, but that is a consequence—not the metric being optimized.

### 5. Make fallible boundaries narrow and predictable

When the scope crosses a network, filesystem, database, subprocess, parser, user-input, or other dynamic boundary:

- Validate untrusted or dynamically shaped data at ingress, then rely on the validated internal contract.
- Represent failures that can occur during valid use explicitly and preserve useful error context.
- Keep resource ownership, cleanup, cancellation, and partial-success behavior unambiguous.
- Use timeouts or cancellation where waiting can legitimately become unbounded and the surrounding platform provides the mechanism.
- Retry only a demonstrated transient operation, only when repeated execution is safe or deduplicated, and with a clear bound. Never use retries to conceal a persistent error.
- Do not silently swallow errors or fall back to behavior that can make failure look like success.

Add only the failure machinery needed by the actual contract. Every fallback and recovery path is another mode that must be reasoned about and tested.

### 6. Verify the resulting design and implementation

Before finishing:

- Confirm required behavior and public contracts remain intact.
- Check that each remaining piece of mutable state has a clear owner and purpose.
- Check that duplicate representations cannot drift and invalid state combinations are prevented where practical.
- Exercise meaningful state transitions, branches, and failure paths affected by the change.
- Add or update focused tests for changed behavior, invariants, transitions, and demonstrated boundary failures; do not add tests for impossible states excluded by the contract.
- Run the most relevant available formatting, static, and test checks.
- Review the final diff for accidental scope growth and newly introduced moving parts.

For every new state value, branch mode, abstraction, dependency, configuration option, retry, fallback, or compatibility path, ask:

1. Is it required by the contract?
2. Can it be eliminated, derived, consolidated, or implemented with an existing capability?
3. Who owns it, and what other parts must coordinate with it?
4. Which new states, transitions, interactions, and failure modes does it create?
5. Does it reduce total lifecycle risk more than it adds?

If the answer to the final question is not clearly yes, do not add it.

## Completion report

Lead with the completed result. Briefly report:

- Required behavior preserved or implemented
- Moving parts, state, modes, or interactions removed or avoided
- Necessary complexity retained and why
- Validation actually performed
- Any unresolved material uncertainty

If no safe simplification is available, say so rather than creating churn.
