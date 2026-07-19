---
name: init
description: Create or maintain a concise, evidence-backed AGENTS.md with a useful repository map
disable-model-invocation: true
---

Create or update `AGENTS.md` at the repository root. Resolve the root with
`git rev-parse --show-toplevel`; if this is not a Git repository, use the current
working directory.

Treat `AGENTS.md` as the agent-facing **table of contents** for the repository,
not an encyclopedia. Route an unfamiliar agent to the right code, commands, and
deeper sources of truth while recording only constraints that are hard to infer
from the repository itself.

If `AGENTS.md` already exists, preserve accurate high-signal guidance, correct
stale facts, remove noise and contradictions, and refresh the repository map.
Do not rewrite accurate text merely for style.

`AGENTS.md` has no mandatory Markdown schema. Use the order below as the default
because it front-loads navigation and universally useful actions. Adapt headings
to the repository, but always include **Repository Map** and
**Keeping This File Accurate**.

The final file should let an unfamiliar agent determine where a change belongs,
which boundaries and sources of truth matter, which focused and final checks to
run, and which non-obvious constraints apply.

Back every retained claim with a path, executable configuration, command output,
source code, or repository history. Omit uncertain claims rather than guessing.

## Investigation Process

1. **Establish scope.** Inspect root and nested `AGENTS.md`,
   `AGENTS.override.md`, and compatibility files such as `CLAUDE.md`. Note scope
   and precedence. Resolve instruction-file symlinks before editing so you
   update the canonical source. Create nested files only when a subtree has
   genuinely different commands or constraints.
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
   commands are defined or runnable. Record required working directories and
   important side effects. Never claim a command passes unless you ran it.
6. **Prune aggressively.** Remove generic advice, README duplication, stale
   version details, exhaustive inventories, and rules already enforced by
   formatters or linters unless a non-obvious exception matters.

## Default Document Structure

Use this order by default:

```md
# Repository Guidelines

[Optional: one or two sentences describing the product and repository shape
only when that context affects where changes belong.]

## Repository Map
- `path/` — responsibility; when to look here; important boundary or relationship.

## Essential Commands
- `command` — purpose; working directory; notable side effect or scope.

## Architecture & Working Agreements
- Non-obvious invariant, ownership rule, or project-specific constraint.

## Keeping This File Accurate
This file must stay accurate. Before finishing any change, check whether it
alters a mapped path or responsibility, or a documented command, workflow,
dependency, or architectural rule. If so, update `AGENTS.md` in the same change.
When creating, deleting, moving, renaming, or repurposing files or directories,
always review the repository map; do not add entries for ordinary files already
covered by an existing responsibility.
```

Optional sections such as Testing, Security, Pull Requests, Generated Assets, or
Deployment belong only when they add broadly applicable repository-specific guidance.

## Example of a Strong Generated File

This example is illustrative only. Never copy its paths, toolchain, or rules
unless the target repository proves them.

```md
# Repository Guidelines

This pnpm workspace contains a web app, an API, and shared domain packages.
Treat `packages/contracts/` as the public boundary between clients and services.

## Repository Map
- `apps/api/src/` — HTTP entry point and request orchestration; put reusable
  domain behavior in `packages/core/`, not route handlers.
- `apps/web/src/` — React client; generated API bindings come from
  `generated/client/` and must not be edited by hand.
- `packages/core/src/` — framework-independent domain logic shared by API jobs
  and tests; it must not import from `apps/`.
- `packages/contracts/` — request/response schemas and compatibility boundary;
  regenerate clients after changing a schema.
- `tests/e2e/` — cross-service behavior; use after focused package tests pass.
- `docs/architecture.md` — canonical dependency rules; read before moving code
  between apps and packages.
- `generated/` — generated artifacts; update only through `pnpm generate`.

## Essential Commands
- `pnpm --filter @acme/api test -- <test>` — fastest API feedback; run at root.
- `pnpm --filter @acme/web test -- <test>` — focused web test; run at root.
- `pnpm lint` — repository lint and type checks; run at root.
- `pnpm test` — full suite; expensive, so run after focused checks pass.
- `pnpm generate` — refreshes `generated/`; review and commit the resulting diff.

## Architecture & Working Agreements
- Dependencies point from `apps/*` to `packages/*`; shared packages never import
  application code.
- Validate external data in `packages/contracts/` before it reaches core logic.
- Add schema changes and regenerated clients in the same change.

## Keeping This File Accurate
This file must stay accurate. Before finishing any change, check whether it
alters a mapped path or responsibility, or a documented command, workflow,
dependency, or architectural rule. If so, update `AGENTS.md` in the same change.
When creating, deleting, moving, renaming, or repurposing files or directories,
always review the repository map; do not add entries for ordinary files already
covered by an existing responsibility.
```

## Section Guidance

### Repository Map — Mandatory and Near the Top

This is the highest-priority section. Map **responsibilities and navigation
choices**, not every file. Use the smallest stable set that lets an unfamiliar
agent locate the right subsystem. Treat 5–15 entries as a starting heuristic,
not a quota.

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
or ephemeral build output. Use repository search or indexing tools for
task-specific symbol discovery.

### Essential Commands

Include only commands likely to be needed for setup, focused validation, full
validation, formatting/linting, building, or running the project. Prefer a fast
targeted command before an expensive repository-wide command. State where to
run it and flag destructive, privileged, networked, or generated-file effects.

### Architecture & Working Agreements

Capture only non-obvious dependency direction, ownership boundaries, canonical
examples, generated-file workflows, environment requirements, security hazards,
and project-specific review expectations. Use short imperative bullets. Put rare
or task-specific procedures in dedicated skills or playbooks rather than loading
them into every agent session.

## Writing Rules

- Keep the root file comfortably under 200 lines; many repositories should fit
  near 100. If it grows, move details into focused docs or genuinely scoped
  nested `AGENTS.md` files and link to them with a reason to read them.
- Use descriptive headings, short self-contained instructions, concrete paths,
  and exact commands. No minimum length and no padding.
- Prefer one canonical instruction over repeated or conflicting variants.
- Name the formatter, linter, or validation command instead of restating every
  rule it already enforces.
- Prefer a path to a canonical example over a long embedded code sample.
- Never include secrets, credentials, private endpoints, or machine-specific
  values.

## Maintenance Check

Before finishing an update:

1. Compare structural changes with `git diff --name-status`.
2. If files or directories were added, deleted, moved, renamed, or repurposed,
   verify that every repository-map entry remains accurate.
3. Re-check every path and command mentioned in the final document.
4. Read the complete instruction chain for contradictions and overly broad rules.
5. Report any command or claim you could not verify instead of presenting it as
   fact.
