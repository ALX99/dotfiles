---
name: comprehensive-review
description: Use when reviewing a PR, commit, staged change, branch, module, or codebase for correctness, security, compatibility, maintainability, and architectural fit.
---

# Comprehensive Review

Review a bounded change or module for production risk and structural health. Report only evidence-backed issues the author would likely fix.

**Core principle:** Prefer the simplest change that preserves a correct, secure, compatible system. A clean review is a useful result.

## Scope

`/comprehensive-review [pr_number] [scope]`

- A leading number is a GitHub PR. Read its metadata and diff. If the user asks to review a PR without a number, look up a matching open PR by title.
- Do not check out a PR into a dirty worktree. Review its diff directly or use an isolated workspace.
- Paths, `staged`, a commit/ref, or a branch select the corresponding local diff or module.
- With no scope, ask what to review.

## Workflow

1. **Map the change.** Identify changed behavior, public contracts, configuration/schema changes, entry points, and affected tests.
2. **Read context.** Inspect complete changed implementations plus relevant callers, types, constants, configuration, migrations, and tests—not only diff hunks.
3. **Escalate selectively.** For docs-only or small isolated changes, review directly. For cross-module/API/config/schema/auth/concurrency work, more than four production files, roughly 250 executable changed lines, or independent risk and design domains, dispatch two default subagents in parallel if the harness supports them:
   - **Risk lens:** correctness, security, state, concurrency, errors, resources, I/O, transactions, idempotency, compatibility, rollout/rollback.
   - **Design lens:** module boundaries, dependency direction, public surface, duplication, complexity, state ownership, and repository conventions.

   Each task must be self-contained: scope/base ref, assigned lens, read-only constraint, required call-site checks, and requested evidence format. The parent verifies every returned finding, removes duplicates, and is the only agent that issues the verdict.
4. **Validate impact.** Trace concrete affected paths. Check callers after signature/API/config changes; changed tests and untested behavior; authorization and input boundaries; migration/partial-failure behavior; and accessibility when UI behavior changes. Consider performance only for a demonstrated hot path or material resource regression.
5. **Report findings and residual risk.** Do not invent design-pattern findings: name a concrete structural pain and show that the proposed pattern resolves it.

## Finding Standard

Every finding needs a location, quoted code or directly observed behavior, concrete impact/maintenance scenario, and proportionate fix. Do not report style preferences, hypothetical edge cases, pre-existing issues unchanged by the scope, or compiler-only errors without runtime impact.

Use distinct severities:

| Severity | Meaning |
|---|---|
| P0–P3 | Production risk: outage, security, data, behavioral, or compatibility impact |
| S0–S2 | Structural issue: architectural blockage, likely growth pain, or minor simplification |

## Output

Start with `PASS`, `PASS WITH NOTES`, or `NEEDS WORK` (`P0`, `P1`, or `S0`). List risk findings before structural findings, ordered by severity:

> **[P1] Short title**
> `path:line`
> **Evidence:** quoted code or observed behavior.
> **Impact:** concrete failure mode.
> **Fix:** specific correction.

Use the same shape for `[S0]`–`[S2]`, replacing **Impact** with **Maintenance cost** when appropriate. End with:

- **Residual risk:** runtime paths, tests, or assumptions not verified.
- **Coverage:** scope, callers/contracts, tests, risk categories, design categories, and any subagents dispatched; mark non-applicable checks `N/A`.
- **Recommendations:** at most three highest-value changes.

A clean review still includes residual risk and coverage.
