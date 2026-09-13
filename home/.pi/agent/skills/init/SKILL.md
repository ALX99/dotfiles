---
name: init
description: Create or refresh a minimal, evidence-backed AGENTS.md containing only durable repository-wide architecture, navigation, and critical invariants.
disable-model-invocation: true
---

# Create a Minimal Repository Map

Create or update the root `AGENTS.md`. Its primary audience is a coding agent arriving with no repository context. The file should let that agent quickly answer:

1. What does this repository contain?
2. What are the major subsystems, and which paths own them?
3. Where should work on each major kind of task begin?
4. Which durable, non-obvious constraints could make a reasonable change seriously incorrect?

This is a small orientation and constraints file, not a contributor handbook, architecture encyclopedia, product specification, or bug-history archive. Default to omission. A shorter file that routes agents to authoritative sources is better than a self-contained file that duplicates them.

## Investigate

Gather current repository evidence before writing:

1. Read the existing root and nested instruction files. Existing prose is evidence, not a preservation requirement. Remove stale, duplicated, local, or over-specified guidance. Keep subtree-specific rules in their subtree.
2. Inspect the top-level layout, manifests, workspace definitions, entry points, architecture documentation, and canonical contributor commands. Ignore generated, vendored, cache, and build-output directories.
3. Identify only the major runtime or build-time subsystems. Trace representative paths far enough to understand their boundaries, owners, and connections.
4. Locate the few important sources of truth: contracts, persisted state, configuration ownership, generated artifacts, security boundaries, and test boundaries.
5. Sample implementation and tests only where needed to verify a surprising invariant. Stop once an unfamiliar agent can route work correctly.

Back every repository-specific claim with current files or configuration. Do not infer architecture from names alone, copy prose without verifying it, or preserve guidance merely because it already exists. If an architectural claim cannot be verified, omit it or identify the uncertainty rather than presenting an inference as fact.

When refreshing an existing file, draft the replacement from a blank outline using repository evidence, then compare the old file only for important omissions. Do not incrementally shorten the old prose; that preserves its framing and turns verified implementation detail into permanent policy.

Do not audit every old statement or search the implementation for a new home for every removed detail. First make a private keep/move/drop list, then verify only the small set of claims that might remain. Verification is necessary but not sufficient: a verified fact must still pass every admission test below. This analysis is working material and must not appear in the generated file.

## Decide What Belongs

Put information in its narrowest durable home:

- User-visible behavior, setup, configuration, and run modes belong in `README.md` or user documentation.
- UI specifications and design conventions belong in design documentation.
- Operational procedures belong in skills, runbooks, or contributor documentation.
- Local implementation traps belong beside the code and in focused tests.
- Historical rationale belongs in commits, ADRs, or a short local comment when it remains necessary.
- Subsystem-only rules belong in a nested `AGENTS.md`, not the repository root.

Root `AGENTS.md` may retain a constraint only when **all** of these are true:

1. It applies across a subsystem or the whole repository.
2. Violating it can cause a serious, silent, security-sensitive, or otherwise expensive failure.
3. It is not readily discoverable from types, tests, filenames, or nearby code.
4. It is expected to remain true through normal refactoring.
5. No source listed above is a better home.

Do not promote individual bug fixes, edge-case catalogs, command internals, exact protocol values, performance anecdotes, or implementation histories into repository-wide law. A passing test or nearby comment is usually a better guard for such details.

Treat these as hard exclusions unless they define an otherwise undocumented repository-wide trust or ownership boundary:

- exact CLI flags, argument ordering, commands, protocol sequences, callback signatures, numeric thresholds, or artifact digests;
- fetched dependency versions, pinning, download mechanics, or other artifact-management details;
- the mechanics of one operation, component, hook, or bug fix;
- facts already named by a focused test or authoritative subsystem document.

Do not move excluded detail into another section to preserve it. A fact being verified, safety-related, bolded in the old file, or connected to a past regression does not make it a root invariant.

## Write the Map

Use headings that fit the repository. Prefer a small set such as:

- **Purpose and Documentation** — one short description and pointers to authoritative detail.
- **Architecture and Ownership** — the major components, trust boundaries, and sources of truth.
- **Critical Invariants** — only constraints that pass every admission test above.
- **Where to Start** — a compact table routing major work categories to primary entry points.
- **Validation** — only canonical gates and any repository-specific live verification boundary.
- **Maintaining This File** — the strong anti-accumulation rule below.

Adapt or merge sections rather than filling a template mechanically. Use exact paths and stable architectural concepts. Prefer relationships and ownership over directory inventories, feature descriptions, and end-to-end flow narration.

Include commands when they are essential to begin work or are canonical validation commands agents should not have to rediscover, even if they appear in manifests. Keep commands tied to the work they support. Do not add command catalogs, single-test examples, exhaustive style rules, dependency inventories, generic Git advice, or PR boilerplate. Link to an existing source of detail instead of duplicating it.

Write terse bullets and compact tables:

- Keep Purpose and Documentation to one short paragraph plus only the most useful authoritative links.
- Use three to five ownership bullets. Each should name one primary path and its role in one sentence, not inventory its files, symbols, or responsibilities after a colon.
- Give each source of truth one exact owner. Do not compress several values or owners into a sentence that blurs which component receives or owns which value.
- When a sentence names multiple resources and multiple consumers, spell out each mapping or split the sentence. Avoid collective pronouns such as “them” unless every resource truly has the same owner.
- Admit critical invariants from scratch; none survives merely because the old file called it critical. Use two to six bullets when that many qualify, and omit the section when none do. Each bullet states one durable rule and its owner in at most two short sentences.
- Combine adjacent work categories in the routing table; prefer twelve or fewer rows.
- Keep Validation to the canonical command block and, when necessary, one short sentence about a verification boundary. No other prose belongs there; do not explain command internals, fetched artifacts, dependencies, or ordinary test behavior.
- State the rule and owner; omit examples and rationale unless the rule is otherwise ambiguous.

Aim for roughly 70–110 lines for a substantial repository. This is not a budget to fill. Approaching 130 lines is a signal to prune or move material; exceeding it should be exceptional.

Ownership-bullet example:

- Good: `` `apps/server/` — the privileged runtime and service composition root. ``
- Bad: `` `apps/server/` — lifecycle, IPC, authentication, storage, jobs, logging, caching, configuration, and every file that implements them. ``

## Preferred Template

Use this as the default shape unless repository evidence calls for something simpler or materially different. It is a ceiling, not a checklist: remove empty sections and irrelevant rows rather than inventing content to fill them. Replace every placeholder with verified repository-specific content.

````md
# AGENTS.md

## Purpose and Documentation

[One or two sentences describing what the repository contains and its primary
runtime or deliverable.]

Use:

- `[path]` for [authoritative product, setup, or contributor documentation].
- `[path]` for [design or subsystem documentation].
- `[path]` for [operational procedures or skills].

Do not duplicate those documents here.

## Architecture and Ownership

- `[path/]` — [major subsystem and what it owns].
- `[path/]` — [major subsystem and what it owns].
- `[path/]` — [shared contracts, state, or integration boundary].

[Two or three short bullets describing only important relationships, trust
boundaries, or sources of truth that are not clear from the directory names.]

## Critical Invariants

- [Durable, non-obvious, cross-cutting rule whose violation causes a serious or
  silent failure.]
- [Another rule that passes every admission criterion.]

Omit this section when no rule meets that bar. Do not include local edge cases,
bug histories, protocol catalogs, or implementation walkthroughs.

## Where to Start

| Work | Start |
|---|---|
| [Major category of change] | `[primary path or symbol]` |
| [Major category of change] | `[primary path or symbol]` |
| [Major category of change] | `[primary path or authoritative documentation]` |

## Validation

Run the canonical repository gates:

```sh
[test command]
[type or static-analysis command]
[build command]
```

[One short sentence about any important verification boundary that commands do
not cover, such as driving a real application or testing against an external
artifact.]

## Maintaining This File

Treat this file as a size-constrained set of repository-wide invariants, not an
append-only knowledge base.

Do not add an entry unless all of the following are true:

- It applies across a subsystem or the whole repository.
- Violating it can cause a serious, silent, security-sensitive, or otherwise
  expensive failure.
- It is not readily discoverable from types, tests, filenames, or nearby code.
- It is expected to remain true through normal refactoring.
- No user documentation, design document, skill, test, local comment, or nested
  `AGENTS.md` is a better home.

Before adding an entry, identify the existing statement it replaces or
consolidates, remove unnecessary examples and history, and keep this file the
same size or smaller when practical. New features do not automatically justify
new entries.

Do not record feature descriptions, exhaustive file maps, individual bug fixes,
debugging notes, test cases, edge-case catalogs, performance measurements, or
facts readily inferred from the relevant module. When a rule becomes clearly
encoded in structure, types, tests, or local documentation, remove it from this
file.
````

The finished file must not retain the template's bracketed prompts or explanatory instructions. Collapse sections when that produces a clearer map; for a small repository, purpose, ownership, validation, and maintenance may be enough.

## Require Ongoing Maintenance

The generated `AGENTS.md` must include a self-contained maintenance section at least as strong as the one in the template. Do not weaken or omit its admission test, replacement-before-growth rule, exclusions, or deletion rule when updating an existing file.

## Final Check

Before finishing, verify that:

- a new agent can identify the correct starting area for the repository's major kinds of work;
- the map explains only the relationships, ownership, and sources of truth needed to route work;
- every path and architectural statement still matches the repository;
- every critical invariant passes all five admission tests;
- no critical invariant remains merely because it was verified or appeared in the previous file;
- no ownership bullet is a disguised file inventory and no invariant bundles unrelated rules;
- no excluded command, protocol, artifact, measurement, or local bug detail was preserved in another section;
- every ownership sentence assigns each value or responsibility to its actual owner without ambiguous grouping;
- Validation contains only canonical gates and at most one essential verification-boundary sentence;
- product documentation, local implementation detail, bug history, and low-level edge cases have been omitted or moved to a better home;
- existing root guidance was pruned rather than preserved by default;
- the file is materially concise for the repository and contains no repeated rule in different words; and
- the strong maintenance instruction is present.
