---
name: go-code
description: Use for every task that writes, edits, reviews, designs, or tests Go code. Apply the user's Go style preferences and stable modern Go features supported by the module's Go version.
---

# Go Code

Follow the repository's supported Go version and local conventions. Prefer the standard library and clear, direct code.

## Version and sources

- Read both the module's `go` directive and the active toolchain version (`go version` or `go env GOVERSION`).
- Use stable modern features supported by the project's compatibility target.
- Prefer current official Go idioms even when nearby code predates them, unless compatibility, consistency, or migration cost materially outweighs the improvement.
- Verify version-sensitive APIs against installed documentation or official release notes rather than relying on training data.
- Do not use draft, experimental, or prerelease APIs by default.

## Contracts and validation

- Follow conventional Go and API contracts even when they are not repeated in local documentation.
- A `context.Context` parameter is non-nil by convention. Do not add a nil check.
- Pointer parameters are the caller's responsibility unless nil is an intentional, meaningful input for that API.
- Rely on types, constructor and parser invariants, prior control-flow narrowing, standard-library conventions, and framework guarantees inside trusted code.
- Validate user input, decoded data, configuration, protocol input, unsafe or foreign values, and other real boundaries.
- Do not turn programmer misuse into an ordinary returned-error path unless the API defines that behavior.
- For `(T, error)` returns, return a usable `T` or a non-nil error according to the API; do not create ambiguous partial-success states.
- Represent absence explicitly with `(T, bool)`, a documented sentinel error, or another established API convention.

```go
// The caller owns the non-nil precondition.
func (s *Service) DisableUser(user *User) error {
	user.Active = false
	return s.db.SaveUser(user)
}
```

## Errors

- Add context when propagating an error, preserve the cause with `%w`, and keep messages lowercase.
- Describe the failed operation directly; avoid prefixes such as `failed to` or `error`.
- Handle an error once. Return it or log it, not both, unless the repository has an explicit boundary policy.
- Use `ErrName` for exported sentinel errors and `errName` for unexported ones.

```go
return Config{}, fmt.Errorf("load config: %w", err)
```

## APIs and types

- Keep APIs unexported unless callers require them.
- Let the package name provide context: prefer `server.New()` over `server.NewServer()`.
- Avoid `Get` prefixes for simple accessors.
- Define interfaces in the consuming package. Accept interfaces and return concrete types unless the contract requires otherwise.
- Do not add an interface only to make a test mockable.
- Prefer value semantics. Use pointers when mutation, identity, lifecycle, or the type's established semantics require them.
- Never use a pointer to an interface.
- Use descriptive names in wide scopes and short conventional names in narrow scopes.

## Structure

- Keep the happy path flat with early returns when handling actual error states.
- Prefer explicit initialization over `init()`.
- Use named struct fields and group fields by responsibility.
- Use `defer` for cleanup and unlocking when ownership is clear.
- Keep the public surface and dependency set minimal.

## Concurrency

- Every goroutine needs clear ownership and a termination path.
- Bound work when input can create an unbounded number of goroutines.
- Propagate cancellation through the established context.
- Establish synchronization and data ownership before adding parallelism.

## Modern Go

Use these features only when the module's compatibility target supports them.

### Go 1.26+

Prefer the generic, type-safe `errors.AsType` over a predeclared target for
ordinary error-tree matching:

```go
if urlErr, ok := errors.AsType[*url.Error](err); ok {
	return urlErr.URL
}
```

Use `new(expr)` when a pointer to a computed value is needed:

```go
cfg := Config{Timeout: new(defaultTimeout())}
```

When deliberately modernizing a Go 1.26+ module, use `go fix ./...` as a
reviewable migration tool rather than mechanically rewriting APIs by hand.
Inspect and test its changes like any other code change.

Do not use draft Go 1.27 APIs unless the project explicitly targets a
compatible prerelease. Reverify preview guidance after the stable release.

### Go 1.25+

Use `sync.WaitGroup.Go` when its no-panic contract fits and no error propagation
is required:

```go
var wg sync.WaitGroup
for _, item := range items {
	wg.Go(func() { process(item) })
}
wg.Wait()
```

Use `testing/synctest.Test` for deterministic concurrent tests; see the
**go-testing** skill.

### Go 1.24+

Use `omitzero` when JSON zero-value semantics are intended, especially for
types such as `time.Time` that define `IsZero`:

```go
StartTime time.Time `json:"start_time,omitzero"`
```

Use lazy string and byte iterators (`SplitSeq`, `SplitAfterSeq`, `FieldsSeq`,
`FieldsFuncSeq`, and `Lines`) when all substrings need not be retained:

```go
for line := range strings.Lines(text) {
	consume(line)
}
for part := range strings.SplitSeq(text, ",") {
	consume(part)
}
```

Use `t.Context` and `t.Chdir` in tests when supported by the module.

### Go 1.23+

Use `unique.Make` for frequently repeated comparable values when canonical
handles provide a measured or clear benefit. Do not intern values speculatively:

```go
host := unique.Make(hostname)
if host == previousHost {
	// Same canonical value.
}
```

### Stable standard-library helpers

Use `cmp.Or` for concise zero-value fallback when its eager evaluation and
left-to-right semantics are appropriate:

```go
dir := cmp.Or(os.Getenv("XDG_CONFIG_HOME"), filepath.Join(home, ".config"))
```

## Dependency choices

- Prefer the standard library before adding a dependency.
- Use external style guides to resolve gaps, not as co-equal authorities.

## Testing

Load the **go-testing** skill whenever writing or reviewing Go tests. Tests should encode requested or established contracts rather than invented invalid-input behavior.

## Additional reference

- [PKG_DESIGN.md](references/PKG_DESIGN.md) — package naming, layouts, and API surface design
