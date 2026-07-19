---
name: comprehensive-review
description: Use when reviewing a PR, commit, staged change, branch, module, or codebase for correctness, security, compatibility, maintainability, and architectural fit.
---

# Comprehensive Review

Review a bounded change or module. Report only evidence-backed issues the author would likely fix. A clean review is a useful result.

## Scope

`/comprehensive-review [pr_number] [scope]`

- A leading number is a GitHub PR. Read its metadata and diff.
- Do not check out a PR into a dirty worktree; inspect its diff directly or use an isolated workspace.
- Paths, `staged`, a commit/ref, or a branch select the corresponding local diff or module.
- With no scope, ask what to review.

## Workflow

1. Map changed behavior, public contracts, configuration or schema changes, entry points, and affected tests.
2. Inspect complete changed implementations and the relevant callers, types, configuration, migrations, and tests.
3. Inspect risks implied by the change. Do not search for an example from every risk category.
4. Trace concrete affected paths and run the most relevant available checks.

## Finding standard

Every finding needs:

- a precise location;
- quoted code or directly observed behavior;
- a concrete impact or maintenance scenario;
- a proportionate fix.

Do not report style preferences, hypothetical edge cases, pre-existing issues unchanged by the scope, or unsupported speculation.

Use `P0`–`P3` for production risk and `S0`–`S2` for structural issues. Order findings by severity.

## Output

Start with `PASS`, `PASS WITH NOTES`, or `NEEDS WORK`. Format each finding as:

> **[P1] Short title**
> `path:line`
> **Evidence:** quoted code or observed behavior.
> **Impact:** concrete failure mode.
> **Fix:** specific correction.

Use **Maintenance cost** instead of **Impact** for structural findings. Report unresolved validation gaps only when material.
