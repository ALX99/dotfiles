---
name: init
description: Create or maintain a concise, evidence-backed AGENTS.md with a useful repository map
disable-model-invocation: true
---

Create or update `AGENTS.md` at the repository root. Resolve the root with
`git rev-parse --show-toplevel`; if this is not a Git repository, use the current
working directory.

Treat `AGENTS.md` as the agent-facing **table of contents** for the repository,
not an encyclopedia. Its job is to route an agent to the right code, commands,
and deeper sources of truth while recording only constraints that are hard to
infer from the repository itself.

If `AGENTS.md` already exists, preserve accurate high-signal guidance, correct
stale facts, remove noise and contradictions, and refresh the repository map.
Do not rewrite accurate text merely for style.

## Questions the File Must Answer

- Where does a change of this kind belong?
- Which entry points, ownership boundaries, and source-of-truth documents matter?
- Which commands provide the fastest relevant feedback and the required final validation?
- Which project-specific constraints are non-obvious and not already enforced mechanically?

Every retained claim must be backed by a path, executable configuration, command
output, source code, or repository history. Omit uncertain claims rather than
guessing.

## Investigation Process

1. **Establish scope.** Inspect root and nested `AGENTS.md`,
   `AGENTS.override.md`, and compatibility instruction files such as
   `CLAUDE.md`. Note their scope and precedence, and resolve instruction-file
   symlinks before editing so you update the canonical source instead of
   replacing the link. Do not create nested files by default; use them only when
   a subtree genuinely has different commands or constraints.
2. **Read executable sources first.** Inspect CI workflows, `Makefile`,
   `justfile`, package scripts, workspace and lock files, formatter/linter/type
   configuration, test configuration, and setup scripts. Executable evidence
   outranks prose when they disagree.
3. **Build a structural map.** Inspect top-level directories, runnable entry
   points, package/workspace manifests, dependency boundaries, generated or
   vendored areas, and test locations. Sample representative implementation and
   test files until ownership and architecture stabilize.
4. **Use history selectively.** Inspect recent commits or pull requests only
   when needed to establish naming or review conventions. Do not turn one
   example into a policy.
5. **Verify before retaining.** Confirm that referenced paths exist and that
   commands are defined or runnable. Record a required working directory and
   important side effects where applicable. Never claim a command passes unless
   you ran it successfully.
6. **Prune aggressively.** Remove generic advice, README duplication, stale
   version details, exhaustive inventories, and rules already enforced by
   formatters or linters unless a non-obvious exception matters.

## Required Document Shape

Use this skeleton, adapting headings only when the repository calls for it:

```md
# Repository Guidelines

## Repository Map
- `path/` — responsibility; when to look here; important boundary or relationship.

## Essential Commands
- `command` — purpose; working directory; notable side effect or scope.

## Architecture & Working Agreements
- Non-obvious invariant, ownership rule, or project-specific constraint.

## Keeping This File Accurate
When a change adds, removes, moves, or repurposes a mapped path—or changes a
documented command, dependency, workflow, or architectural constraint—update
`AGENTS.md` in the same change. Do not edit the map for ordinary files already
covered by an existing entry.
```

### Repository Map — Mandatory and Near the Top

This is the highest-priority section. Map **responsibilities and navigation
choices**, not every file. Use the fewest stable entries that let an unfamiliar
agent locate the right subsystem; most repositories need roughly 5–15 entries.

Each entry should combine:

- a path or glob;
- what it owns;
- when an agent should inspect or change it; and
- a non-obvious boundary, dependency, generated-file rule, or relationship when
  one matters.

Include runnable entry points, primary implementation areas, test locations,
and generated/vendor/external areas that should not be edited. Mention nested
instruction files and their scope when present. A reference to another document
must say **why and when** to read it.

Do not paste a full directory tree, per-file inventory, generated symbol dump,
or ephemeral build output. Those maps become stale and consume context; use
repository search or indexing tools for task-specific symbol discovery.

### Essential Commands

Include only commands an agent is likely to need for setup, focused validation,
full validation, formatting/linting, building, or running the project. Prefer a
fast targeted command before an expensive repository-wide command. State where
to run it and flag destructive, privileged, networked, or generated-file side
effects.

### Architecture & Working Agreements

Capture only non-obvious information such as dependency direction, ownership
boundaries, canonical examples, generated-file workflows, environment
requirements, security hazards, and project-specific review expectations. Use
short imperative bullets. Put rare or task-specific procedures in dedicated
skills or playbooks rather than loading them into every agent session.

Optional sections such as Testing, Security, Pull Requests, or Common Gotchas
are welcome only when they add repository-specific signal not already covered.

## Writing Rules

- Keep the root file comfortably under 200 lines; many repositories should fit
  near 100. If it grows, move detailed material into focused docs or genuinely
  scoped nested `AGENTS.md` files and link to them with a reason to read them.
- Use descriptive headings, short imperative bullets, concrete paths, and exact
  commands. No minimum length and no padding.
- Prefer one canonical instruction over repeated or conflicting variants.
- Name the formatter, linter, or validation command instead of restating every
  rule it already enforces.
- Prefer a path to a canonical example over a long embedded code sample.
- Never include secrets, credentials, private endpoints, or machine-specific
  values.

## Maintenance Check

Before finishing an update:

1. Compare structural changes with `git diff --name-status` and update the map
   only when a mapped responsibility or path changed.
2. Re-check every path and command mentioned in the final document.
3. Read the complete instruction chain for contradictions and overly broad
   rules.
4. Report any command or claim you could not verify instead of presenting it as
   fact.
