---
name: go-code
description: Use for every task that writes, edits, reviews, designs, or tests Go code. Apply the user's Go style preferences and stable modern Go features supported by the module's Go version.
---

# Go Code

Write clear, direct Go with the smallest API and dependency set that satisfies
the task. Follow repository contracts and supported versions; do not preserve
outdated patterns merely because nearby code uses them.

## Version and sources

- Read the relevant module's `go` and `toolchain` directives, workspace configuration when present, and active toolchain version (`go version`). A newer local toolchain does not raise the module's compatibility target.
- Use stable features supported by that target. Do not upgrade the target or introduce experimental APIs without a task requirement.
- Verify version-sensitive APIs against installed documentation or official release notes. Installed documentation describes the installed toolchain, not necessarily the target version.
- Consult [modern Go](references/MODERN_GO.md) when choosing version-sensitive helpers or deliberately modernizing code.

## Navigation with `gopls`

Prefer `gopls` for definitions, references, implementations, and renames. Run it
from the relevant module or workspace. Use text search for literal strings,
configuration, and initial discovery, or when the workspace cannot load.
Positions are `path/file.go:line:column` (1-based).

```sh
gopls definition ./internal/cache/cache.go:42:7
gopls references ./internal/cache/cache.go:42:7
gopls implementation ./internal/cache/cache.go:42:7
gopls call_hierarchy ./internal/cache/cache.go:42:7
gopls workspace_symbol -matcher=fuzzy Cache
gopls symbols ./internal/cache/cache.go
gopls check ./internal/cache/cache.go
```

`references -declaration` includes the declaration. Output locations can be
used directly in follow-up commands. Preview edits before applying them:

```sh
gopls rename -diff ./internal/cache/cache.go:42:7 NewName
gopls imports -diff ./internal/cache/cache.go
gopls codeaction -kind=quickfix -exec -diff ./internal/cache/cache.go
```

Use `-write` only when applying changes. Check the installed command's help if
flags or available actions differ.

## Contracts and validation

- Rely on language and API contracts, constructor/parser invariants, and prior control-flow narrowing inside trusted code.
- Validate external input at real boundaries: user input, decoded data, configuration, protocols, and foreign values.
- A `context.Context` argument is non-nil by convention. Do not add a nil check.
- Give nil pointer inputs behavior only when the API supports nil; do not invent returned-error paths for programmer misuse.
- Follow each API's result/error contract. Partial results with an error are valid when defined by the API, as with `io.Reader`; callers must handle them accordingly.
- Represent absence through an established convention such as `(T, bool)` or a documented sentinel error. Distinguish it from failure when callers need that distinction.

## Errors

- Add context when it identifies a useful operation or input; avoid redundant wrapping at every layer.
- Use `%w` when callers should be able to inspect the cause. Exposing an underlying error becomes part of the API contract.
- Use `errors.Is` and `errors.As` (or version-supported `errors.AsType`) for wrapped errors, not string matching.
- Keep error messages lowercase and without trailing punctuation unless a proper name or literal requires otherwise. Describe the operation directly rather than adding `failed to` or `error`.
- Handle an error once: return it or log it, unless an explicit boundary policy requires both.
- Name sentinel errors `ErrName` when exported and `errName` otherwise. Add sentinels or error types only when callers need to distinguish them.

```go
return Config{}, fmt.Errorf("load config: %w", err)
```

## APIs and types

- Keep identifiers unexported unless consumers require them. Let package names supply context, and avoid redundant names and `Get` prefixes on simple accessors.
- Accept the type the contract needs. Define small interfaces in the consuming package when genuine substitutability is needed; do not introduce interfaces preemptively or solely to mirror a concrete type for mocking.
- Usually return concrete types; return an interface when abstraction is part of the contract.
- Prefer values when copying is appropriate. Use pointers for mutation, identity, shared ownership, or types whose established semantics require them. Avoid pointers to interfaces in ordinary APIs.
- Do not copy synchronization-bearing values after first use. Choose receiver types consistently with mutation and copy semantics.
- Make slice/map aliasing and mutation ownership clear. Copy when isolation is required, not automatically.
- Use generics when they express a shared, type-safe algorithm or data structure more clearly than concrete code; avoid speculative frameworks.
- Use descriptive names in wide scopes and short conventional names in narrow scopes.

## Structure and resource ownership

- Keep the happy path flat with early returns. Avoid unnecessary `else` branches after a return.
- Prefer explicit initialization over `init()` when ordering, dependencies, or failures matter.
- Prefer keyed struct literals, especially across package boundaries or for structs with several fields.
- Use `defer` for cleanup when its enclosing function matches the resource lifetime. Extract a function or clean up explicitly when a loop would otherwise retain resources.
- Check close or flush errors when they can determine whether an operation succeeded, especially for writes. Preserve the primary failure if cleanup also fails.
- Keep dependencies minimal, but use an established dependency when it materially reduces maintenance or failure risk.

## Concurrency and context

- Give every goroutine an owner and termination path. The owner must know when work has finished before releasing resources it uses.
- Bound concurrent work when its volume comes from input.
- Establish synchronization and data ownership before adding parallelism. Use mutexes or channels according to the problem, not a blanket preference.
- Pass `context.Context` as the first parameter, conventionally named `ctx`, when the operation supports cancellation or request-scoped values. Do not use context values for optional parameters.
- Propagate the caller's context rather than replacing it with `context.Background()`. Call cancellation functions when their scope ends.
- Prefer passing context to operations rather than storing it in long-lived structs, unless an established API requires otherwise.

## Verification

- Format changed Go files with `gofmt` or the repository's formatter; organize imports using existing tooling.
- Run focused tests for changed behavior, then the broader checks required by the repository. Use `go vet` for affected packages and race testing when concurrency changes make it relevant and the environment supports it.
- Check relevant build tags and platform constraints when the change affects them.
- Review the diff for unintended API, dependency, generated-file, or compatibility changes. Report checks that could not run.
- Do not run repository-wide modernization or dependency updates as incidental cleanup.

## Related guidance

- Load the **go-testing** skill when writing or reviewing Go tests.
- Read [package design](references/PKG_DESIGN.md) when creating packages or changing package boundaries and public APIs.
- Use official Go documentation to resolve language and library questions; external style guides fill gaps rather than override project requirements.
