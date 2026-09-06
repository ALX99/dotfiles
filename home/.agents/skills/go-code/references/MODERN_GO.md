# Modern Go

Use these features when they improve the code and the module's compatibility
target supports them. This is a selection guide, not a mandatory migration
checklist. Verify APIs against documentation for the target version.

## Go 1.26+

Prefer `errors.AsType` for ordinary type-safe error-tree matching:

```go
if urlErr, ok := errors.AsType[*url.Error](err); ok {
	return urlErr.URL
}
```

Use `new(expr)` when a pointer to a computed value is needed:

```go
cfg := Config{Timeout: new(defaultTimeout())}
```

For a deliberate modernization task, `go fix ./...` can provide reviewable
migrations. Inspect and test its changes; do not run it as unrelated cleanup.

## Go 1.25+

Use `sync.WaitGroup.Go` when its no-panic contract fits and error propagation
is not needed:

```go
var wg sync.WaitGroup
for _, item := range items {
	wg.Go(func() { process(item) })
}
wg.Wait()
```

This does not bound concurrency. Use an appropriate limit when work volume
requires one. Use existing error-group tooling when error propagation and
cancellation are needed rather than rebuilding it unnecessarily.

For deterministic concurrent tests, consider `testing/synctest.Test`; see
the **go-testing** skill for constraints.

## Go 1.24+

Use JSON `omitzero` when omission should follow zero-value semantics, including
a type's `IsZero` method. It is not interchangeable with `omitempty`.

```go
StartTime time.Time `json:"start_time,omitzero"`
```

Use string/byte iterators such as `SplitSeq`, `FieldsSeq`, and `Lines` when
iteration avoids materializing an unnecessary slice. `Lines` retains newline
terminators.

```go
for part := range strings.SplitSeq(text, ",") {
	consume(part)
}
```

Use `t.Context` and `t.Chdir` where appropriate; see **go-testing**.

## Go 1.23+

Use range-over-function iterators and `iter`, `slices`, or `maps` helpers when
they simplify traversal. Do not add custom iterator abstractions around
otherwise straightforward loops without a concrete benefit.

Use `unique.Make` only when canonical handles for repeated comparable values
provide a measured or clear benefit; do not intern speculatively.

## Go 1.22+

Use integer range when only an iteration count is needed.

Loop variables declared by the loop have per-iteration identity under Go 1.22+
language semantics. Do not add obsolete `v := v` capture workarounds, but
remember that variables assigned with `=` remain shared and referenced data
can still alias.

Use `cmp.Or` for first-nonzero fallback when zero really means absent:

```go
dir := cmp.Or(os.Getenv("XDG_CONFIG_HOME"), filepath.Join(home, ".config"))
```

All arguments are evaluated eagerly; use explicit control flow for fallbacks
with effects or expensive computation.

## Go 1.21+

Prefer applicable `slices`, `maps`, and `cmp` helpers over handwritten
equivalents. Use built-in `min`, `max`, and `clear` when their semantics match
the operation.
