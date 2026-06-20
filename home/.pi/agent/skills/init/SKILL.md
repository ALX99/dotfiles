---
name: init
description: Create or update AGENTS.md with high-signal, non-obvious repository knowledge
---

Create or update AGENTS.md for this repository.

## Objective

A compact instruction file that helps future agents avoid mistakes and ramp up quickly. Every line must answer: **"Would an agent likely miss this without help?"** If not, leave it out.

## Approach

Two phases: **gather** deeply to understand big patterns, then **filter** aggressively so only non-obvious knowledge survives into AGENTS.md.

### Gather

Goal: understand patterns well enough to write rules that hold up across the codebase, not just enumerate layout. Don't stop at the surface.

1. Read the project's stated intent (README, top-level docs, architecture notes).
2. Read configs and executable sources (Makefiles, CI workflows, package scripts, lockfiles, lint/format/build configs). These run; prose can lie.
3. Map layout: top-level dirs and what each owns. Enough to know where to look, not exhaustive enumeration.
4. Read source until patterns stabilize. Read at least 70k tokens of content or everything in the repo, whichever hits first. Don't stop at 2–3 spot-checks when the codebase has subsystems, frameworks, or platform branches — read enough that claims survive cross-checks. For bi-platform repos, verify both branches; for plugin systems, both the loader and a representative plugin; for layered architectures, both the boundary and a layer that crosses it.
5. Note the gotchas and non-obvious conventions that took multiple files or cross-referencing to discover.

### Filter

Apply **What to extract**: would an agent likely miss this without help? If not, leave it out. Directory trees, single-file facts, generic advice — all noise. AGENTS.md is the filtered output, not the gathered context.

### Updating an existing AGENTS.md

- Audit every claim against current state. Delete what doesn't verify.
- **Structural rewrites are fine and often warranted.** Don't preserve the old layout or sectioning for its own sake — reorganize freely when it serves clarity, including a complete format change.
- Preserve verified guidance, reconcile with current codebase, add new claims that survive the filter.

Stop gathering when a new file in a known place doesn't change the rule.

## Sources of truth (priority order)

1. **Executable sources** — scripts, Makefiles, CI workflows, package.json scripts, lockfiles. What actually runs.
2. **Configs** — lint, format, typecheck, build configs.
3. **Existing instruction files** — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`. Migrate non-obvious rules worth keeping.
4. **Prose docs** — README, CONTRIBUTING. Lowest priority; trust executable over prose when they conflict.

## Verify before writing

Every fact must be backed by file path, command output, or git state. Enumerate tracked files, map layout, and cross-reference as needed. Read each cited file before claiming what it does.

**Only tracked files are sources of truth.** Untracked files are transient — do not include claims about them in AGENTS.md and do not cite them as evidence. If a claim can only be verified from an untracked file, drop it.

Speculation is worse than a gap. Drop uncertain claims.

## What to extract (high-signal)

- Exact commands, especially non-obvious ones (single-test, focused verification, required order like `lint → typecheck → test`)
- Monorepo / multi-package boundaries and real entrypoints
- Framework or toolchain quirks: codegen, migrations, build artifacts, env loading, dev servers
- Repo conventions that differ from language/framework defaults
- Testing quirks: fixtures, integration prerequisites, snapshot workflows, required services, flaky/expensive suites
- Non-obvious gotchas that took reading multiple files to infer

## Exclude

- Anything obvious from a single file or filename.
- Full file trees — easily enumerated on demand.
- Generic software advice.
- Long tutorials or exhaustive references.
- Speculation, "probably", "I think".
- Apologetic qualifiers (`(not an X)`, `(note: doesn't…)`). If something doesn't fit, omit it or state what it is.
- Anything the agent would pick up from reading the relevant file. Mentioning the obvious is actively detrimental — it costs tokens and crowds out real gotchas.

## Rules

- Each line earns its place.
- When updating, audit existing claims before adding new ones. A stale AGENTS.md is worse than no AGENTS.md.
- Prefer dense bullets over prose.
- Trim if a section is longer than what it documents.
