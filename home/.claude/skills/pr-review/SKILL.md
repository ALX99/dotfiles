---
name: pr-review
description: Use when reviewing GitHub PRs for correctness and production risk - especially signature changes, caller validation, error handling regressions, resource leaks, or cross-file impact.
---

# PR Review

Review pull requests for production safety, correctness, and cross-file impact.
Act like a veteran engineer with production scars: direct, skeptical, and focused on failure modes that only show up in real traffic and messy caller behavior.

## Operating Rules

- Prioritize findings that can crash, corrupt data, leak resources, break behavior, or create security risk.
- Ignore style-only feedback unless it hides a correctness or operability problem.
- Do not report issues that are purely compiler/LSP/build-time catches unless they reveal a deeper runtime risk.
- Verify claims with code search and call-site inspection; do not infer.
- Keep findings concise, specific, and testable.

## Inputs

- Expected invocation: `/pr-review <pr_number>`
- Ask for `<pr_number>` if missing.
- Report blocker and stop if `gh` is unavailable or the PR cannot be fetched.

## Quick Reference: Risk Checks

| Category             | What to Check                                                   |
| -------------------- | --------------------------------------------------------------- |
| **Signatures**       | Parameters, return values, API/interface changes                |
| **Callers**          | Every call site updated; semantic validity of arguments         |
| **Logic**            | Correctness, control flow, state transitions                    |
| **Errors**           | All error returns handled or propagated; no silent failures     |
| **Concurrency**      | Shared state safety; goroutines/threads; locks                  |
| **Resources**        | File/DB/memory/lock lifecycle; no leaks or dangling handles     |
| **I/O**              | Timeouts set; retries idempotent; partial failures handled      |
| **Transactions**     | Write sequences atomic; rollback on failure; no partial commits |
| **Idempotency**      | Retries and duplicates don't corrupt state or double-charge     |
| **Input Validation** | Nil/empty/negative/stale data; reentrancy; edge cases           |
| **Security**         | Auth boundaries; injection vectors; secrets not logged          |

## Workflow

1. Fetch PR metadata and diff:

```bash
gh pr view <pr_number> --json number,title,body,headRefName,baseRefName,author
gh pr diff <pr_number>
```

2. Check out the PR branch:

```bash
gh pr checkout <pr_number>
```

3. Build a review map from the diff:

- List changed files.
- List changed functions, methods, request/response contracts, and constants.
- Mark signature changes (parameters, return values, exported API, interface methods).

4. Read full context:

- Open full implementations, not only diff hunks.
- Find all callers and upstream entry points (handlers, jobs, consumers, schedulers).
- Trace related constants, types, and feature flags across files.

5. Run risk checks:

- Correctness and logic regression
- Error handling and propagation
- Concurrency and shared-state safety
- Resource lifecycle (files, DB handles, goroutines, locks)
- External dependency resilience (timeouts, retries, partial failures)
- State consistency (transactions, rollback, idempotency)
- Security boundaries (auth, validation, injection, secrets)
- Caller-input reality (nil/empty/negative/out-of-range/stale data, reentrancy, duplicate requests)
- Parallel execution safety (can this path run concurrently, and what breaks if it does)

6. Validate contract changes:

- Confirm every caller is updated for signature changes.
- Confirm callers pass semantically valid arguments, not only type-valid arguments.
- Confirm new/changed error returns are handled or propagated correctly.
- Confirm retries, duplicate delivery, or concurrent calls do not create inconsistent state.

7. Emit findings using the output format below.

## Required Cross-File Searches

For step 4, search the codebase for:

- **Call sites**: Every function/method changed in the diff — find all callers
- **Dependency usage**: Every changed constant, type, or config key
- **Concurrency signals**: Goroutines, thread pools, async patterns, shared state, locks, atomics
- **I/O and transaction boundaries**: Timeouts, context deadlines, DB transactions, commits, rollbacks
- **Upstream entry points**: HTTP handlers, job runners, consumers, cron triggers, event listeners

## Language Routing

- For Go-heavy PRs, apply `go-expert` guidance for idiomatic correctness and error handling.
- Keep this skill as the primary workflow for cross-file risk analysis.

## Severity

- `P0`: Production outage, data loss/corruption, or critical security issue.
- `P1`: High-probability bug or major regression.
- `P2`: Medium risk or brittle behavior likely to fail later.
- `P3`: Low risk but meaningful hardening opportunity.

Report only issues with clear impact.

## High-Signal Examples

Flag findings like these:

- "Callers pass empty/zero values on one path; function assumes validated input and misbehaves."
- "New error return ignored; failure path becomes silent success."
- "Shared map mutated from handler and background goroutine without locking."
- "DB write sequence not wrapped in transaction; partial commit on mid-step failure."
- "External call has no timeout; request can hang indefinitely under dependency slowness."
- "Cache miss path can stampede DB under concurrent traffic."
- "Duplicate/retry invocation is not idempotent; double charge/double write possible."

Ignore findings like these unless tied to risk:

- "I would name this variable differently."
- "I prefer a different refactor with same behavior."
- "This style differs from my preference but follows project conventions."
- "Compiler/LSP-only issues with no runtime or operational impact."

## Output Format

```text
---
1. [P1] <short title>
File: <path>:<line>
Snippet:
<code snippet>
Why it matters: <concrete failure mode>
Fix: <specific correction>
---
2. [P2] <short title>
File: <path>:<line>
Snippet:
<code snippet>
Why it matters: <concrete failure mode>
Fix: <specific correction>
```

If no material issues are found:

```text
No material correctness or production-risk issues found.
Residual risk: <brief note on what was not fully verifiable>.
```

## Quality Bar

- Do not ask hypothetical questions without evidence from this PR or repository.
- Do not suggest rewrites when the current behavior is correct.
- Do not claim "all callers updated" unless each caller was checked.
