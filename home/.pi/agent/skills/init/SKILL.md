---
name: init
description: Create or refresh AGENTS.md as a concise, evidence-backed repository map that orients coding agents to the architecture, ownership boundaries, and best starting points.
disable-model-invocation: true
---

# Create a Repository Map

Create or update the root `AGENTS.md`. Its primary audience is a coding agent arriving with no repository context. The file should let that agent quickly answer:

1. What does this repository contain?
2. What are the major subsystems, and which paths own them?
3. How do those subsystems relate, and where are the important sources of truth?
4. Where should work on each major kind of task begin?
5. Which non-obvious constraints could make an otherwise reasonable change incorrect?

This is a high-level navigation and architecture map, not a complete contributor handbook.

## Investigate

Gather current repository evidence before writing:

1. Read an existing root `AGENTS.md` and discover scoped or nested instruction files. Read those relevant to the major subsystems and any areas inspected. Preserve applicable project-specific rules, even when they do not fit the map format. Verify architectural claims and remove stale detail. Keep subtree-specific guidance scoped rather than promoting it into root rules; relocate detail only when its discoverability and scope remain intact.
2. Inspect the top-level layout, manifests, workspace definitions, entry points, and architecture documentation. Ignore generated, vendored, cache, and build-output directories.
3. Identify the few major runtime or build-time subsystems. Trace representative paths far enough to understand how they connect rather than describing directories in isolation.
4. Locate the important ownership boundaries and sources of truth: shared contracts, configuration, state, generated artifacts, platform-specific implementations, integrations, and test boundaries.
5. Sample implementation and tests only where they clarify architecture or a non-obvious invariant. Stop once an unfamiliar agent can route likely tasks to the correct area.

Back every repository-specific claim with current files or configuration. Do not infer architecture from names alone, copy prose without verifying it, or preserve guidance merely because it already exists. If an architectural claim cannot be verified, omit it or identify the uncertainty rather than presenting an inference as fact.

## Write the Map

Use headings that fit the repository. Prefer a small set such as:

- **Repository Purpose** — briefly describe the product or role of the repository.
- **Architecture and Ownership** — the major components and the paths that own them. A compact annotated tree is useful when it shows real boundaries; do not inventory every top-level directory.
- **Key Flows and Sources of Truth** — how components connect, where state or contracts originate, and which files are derived.
- **Where to Start** — route common categories of work to their primary entry points, modules, or documentation.
- **Critical Constraints** — only cross-cutting, non-obvious rules that materially affect safe changes.

Adapt or merge sections rather than filling a template mechanically. Use exact paths and stable architectural concepts. Prefer relationships and ownership over file-by-file descriptions.

Include commands when they are essential to begin work or are canonical validation commands agents should not have to rediscover, even if they appear in manifests. Keep commands tied to the work they support. Do not add command catalogs, single-test examples, exhaustive style rules, dependency inventories, generic Git advice, or PR boilerplate. Link to an existing source of detail instead of duplicating it.

Let the repository's complexity determine the length. Keep the map concise, and include only content that helps an agent locate work, understand a boundary, or avoid a repository-specific mistake.

## Require Ongoing Maintenance

The generated `AGENTS.md` must include a short instruction with this meaning:

> Keep this repository map current. When a change adds, removes, or relocates a major subsystem; changes an architectural boundary or source of truth; or introduces a critical repository-wide constraint, update `AGENTS.md` in the same commit. Do not record routine implementation details or file-level churn.

Integrate this instruction naturally under a final maintenance or change-guidance section. It is required even when updating an existing file.

## Final Check

Before finishing, verify that:

- a new agent can identify the correct starting area for the repository's major kinds of work;
- the map explains relationships and ownership, not just directory names;
- every path and architectural statement still matches the repository;
- applicable existing rules remain available at the correct scope;
- low-level details that will age quickly have been omitted; and
- the maintenance instruction is present.
