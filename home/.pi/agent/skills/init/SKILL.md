---
name: init
description: Create or update AGENTS.md with high-signal, non-obvious repository knowledge
---

Create or update AGENTS.md for this repository.

## Objective

Produce a high-signal reference that helps future agents:
- understand stable architecture and patterns
- avoid non-obvious mistakes
- find things quickly

Do not restate obvious details.

---

## Approach

- Identify project type from root files
- Extract real commands from scripts/config
- Read a small set of representative files
- Infer patterns from repetition (not single instances)
- Stop once patterns stabilize

---

## Include

### Essential Commands
Only what an agent will actually run (build/test/run/lint).
Include flags only if non-obvious.

### Architecture
- overall structure (monolith, layered, etc.)
- key directories and responsibilities
- control/data flow at a high level

### Patterns & Conventions
Only stable, repeated patterns:
- naming
- structure
- layering
- error handling

### Gotchas
Non-obvious rules, edge cases, surprising behavior.

### Navigation
Where to start and how to trace features.

### Testing
Only if non-trivial.

---

## Exclude
- obvious facts from a single file
- full file listings
- CI/CD, infra, deployment
- speculation

---

## Rules
- Prefer dense, useful information
- No filler, no repetition
- Only include what is clearly supported by the code
