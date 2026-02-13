---
name: risk-review
description: Use when reviewing code for bugs, correctness issues, and production risk. Invoke with a PR number to review a PR, or describe what to review (files, commits, branches, staged changes, etc.).
---

# Risk Review

Review code for production safety, correctness, and cross-file impact.
Act like a veteran engineer with production scars: direct, skeptical, focused on failure modes that only show up in real traffic.

## Inputs

`/risk-review [pr_number] [scope]`

Both arguments are optional:

- `/risk-review 34` — check out PR #34, review entire diff
- `/risk-review 34 auth middleware` — check out PR #34, focus review on auth middleware
- `/risk-review the error handling in pkg/api/` — no PR, review those files in the working tree
- `/risk-review` — no args, ask what to review

**`pr_number`** — If the first argument is a number, treat it as a GitHub PR:

```bash
gh pr view <number> --json number,title,body,headRefName,baseRefName,author
gh pr diff <number>
gh pr checkout <number>
```

The diff comes from the PR. If `scope` is also provided, use it to narrow focus within the PR diff.

**`scope` only (no PR)** — Review code in the current working tree based on the description:

- File or directory paths → read and review those
- "staged changes" → `git diff --cached`
- "last commit" / commit SHA → `git show <ref>`
- Branch name → `git diff main...<branch>`
- General description → find relevant code and review it

## Rules

- Only report findings that can crash, corrupt data, leak resources, break behavior, or create security risk.
- Ignore style-only feedback unless it masks a correctness problem.
- Skip compiler/LSP-only catches unless they reveal runtime risk.
- Verify claims with code search and call-site inspection — do not infer.
- For Go code, apply `go-expert` guidance.

## Risk Checklist

| Category         | What to Check                                                   |
| ---------------- | --------------------------------------------------------------- |
| Signatures       | Parameters, return values, API/interface changes                |
| Callers          | Every call site updated; semantic validity of arguments         |
| Logic            | Correctness, control flow, state transitions                    |
| Errors           | All error returns handled or propagated; no silent failures     |
| Concurrency      | Shared state safety; goroutines/threads; locks                  |
| Resources        | File/DB/memory/lock lifecycle; no leaks or dangling handles     |
| I/O              | Timeouts set; retries idempotent; partial failures handled      |
| Transactions     | Write sequences atomic; rollback on failure; no partial commits |
| Idempotency      | Retries and duplicates don't corrupt state or double-charge     |
| Input Validation | Nil/empty/negative/stale data; reentrancy; edge cases           |
| Security         | Auth boundaries; injection vectors; secrets not logged          |

## Workflow

1. **Get the diff** — PR checkout if a number was given, otherwise derive from scope (see Inputs).

2. **Build a review map:**
   - Changed files, functions, methods, contracts, constants.
   - Flag signature changes (parameters, return values, exported API, interfaces).

3. **Read full context** — not just diff hunks:
   - Full implementations of changed functions.
   - All callers and upstream entry points (handlers, jobs, consumers, schedulers).
   - Related constants, types, feature flags across files.

4. **Cross-file searches:**
   - Call sites for every changed function/method.
   - Usage of every changed constant, type, or config key.
   - Concurrency signals: goroutines, thread pools, async patterns, shared state.
   - I/O and transaction boundaries: timeouts, context deadlines, DB transactions.

5. **Run risk checks** against the checklist above.

6. **Validate contracts:**
   - Every caller updated for signature changes.
   - Arguments semantically valid, not just type-valid.
   - New/changed error returns handled or propagated.
   - Retries/concurrent calls don't create inconsistent state.

7. **Report findings.**

## Severity

| Level | Meaning                                                          |
| ----- | ---------------------------------------------------------------- |
| P0    | Production outage, data loss/corruption, critical security issue |
| P1    | High-probability bug or major regression                         |
| P2    | Medium risk, brittle behavior likely to fail later               |
| P3    | Low risk but meaningful hardening opportunity                    |

Report only issues with clear impact.

## Output Format

### Findings

For each issue:

> **[P1] Short title**
> `path/to/file.go:42`
>
> ```go
> offending code
> ```
>
> **Impact:** Concrete failure mode — what breaks, when, how.
> **Fix:** Specific correction.

### Clean Review

> No material correctness or production-risk issues found.
> **Residual risk:** [unable to verify at runtime | test coverage gap | specific edge case not fully traced]

## Quality Bar

- No hypothetical questions without evidence from the code under review.
- No rewrites when current behavior is correct.
- Never claim "all callers updated" without checking each one.
- No findings that are purely stylistic preferences.
