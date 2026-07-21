---
name: commit
description: Create a git commit. Use before creating a git commit.
---

Create one coherent git commit.

Inspect the repository changes and use any description supplied by the user to
determine what belongs in the commit. Stage the relevant changes before
committing.

Do not include unrelated changes. If the intended commit is unclear, or the
changes cannot be separated confidently, ask the user what to include.

Use Conventional Commits:

```text
<type>[optional scope]: <summary>
```

Choose the type based on the purpose and outcome:

* `feat`: adds or materially changes behavior
* `fix`: corrects an actual bug or unintended behavior
* `refactor`: restructures code without changing behavior
* `perf`: improves performance
* `docs`: documentation only
* `test`: tests only
* `build`: dependencies, build tooling, or packaging
* `ci`: CI/CD configuration
* `chore`: maintenance that does not fit another type

Do not use `fix` merely because an implementation, dependency, or
configuration was updated.

The scope is optional. Use a broad, stable area of the codebase, such as
`shell`, `nvim`, `backend`, or `frontend`. Prefer scopes already used by the
repository. Do not use filenames, function names, or narrow implementation
details. Omit the scope when no single area clearly fits.

The summary must be imperative, lowercase, have no trailing period, and stay
under 72 characters. Describe the outcome or problem solved rather than the
files or implementation details.

Add a short body only when the motivation or impact is not obvious.

Do not discard existing changes, amend commits, bypass hooks, or commit
suspected secrets unless explicitly requested.

After committing, verify the commit and remaining working-tree changes.

Do not narrate routine steps. Only send a message when user input is required
or the commit cannot safely be created.
