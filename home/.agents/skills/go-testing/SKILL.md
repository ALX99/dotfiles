---
name: go-testing
description: Use when writing, editing, or reviewing Go tests. Applies contract-driven test design and repository-specific testing conventions.
---

# Go Testing

Use alongside the **go-code** skill. Follow the repository's supported Go version, existing test style, and established dependencies.

## Version and sources

- Read both the module's `go` directive and the active toolchain version.
- Use stable testing APIs supported by the module; verify version-sensitive behavior against installed documentation or official release notes.
- Do not copy experimental spellings from old examples into code targeting current Go.

## Contract-driven tests

- Tests encode requested behavior and applicable language, API, framework, and project contracts; those contracts need not all be restated locally.
- Do not add invalid-input cases merely because a value can be represented.
- Add boundary and malformed-input tests when code parses or accepts user, network, file, configuration, database, or other external data.
- Use table-driven tests when multiple cases genuinely share setup and assertions.
- Use `t.Parallel()` only when isolation is clear and parallel execution provides value.
- Do not change an implementation contract merely to satisfy a newly invented test case.

## Assertions and helpers

- Prefer the standard library unless the repository already uses an assertion package.
- Call `t.Helper()` in test helpers so failures identify the caller.
- A helper running in the test goroutine can use `t.Fatal` or `t.Fatalf` when it cannot continue. Do not call fatal methods from worker goroutines; report errors back to the test goroutine.
- Use `t.Errorf` when the test can meaningfully continue and `t.Fatalf` when continuing would create noise or panic.
- Keep assertions focused on behavior relevant to the test.

## Structure

- Use `_test.go` files, usually beside the implementation. Group by behavior when that is clearer than matching implementation files.
- Use descriptive `Test...` names that identify the behavior or API under test; follow repository naming conventions.
- Prefer direct tests for one or two cases. Use subtests or tables only when they improve clarity.
- Use current testing APIs only when supported by the module's declared Go version.

```go
func TestNormalizeID(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "user-1", want: "user-1"},
		{name: "mixed case", in: "User-2", want: "user-2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeID(tt.in); got != tt.want {
				t.Errorf("NormalizeID(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
```

## Isolation and checks

- Use `t.TempDir` for temporary files and `t.Cleanup` for fixture lifetimes shared with subtests.
- Use `t.Setenv` for environment changes. Like `t.Chdir`, it cannot be used in parallel tests or tests with parallel ancestors because it changes process-wide state.
- Prefer observable synchronization to wall-clock sleeps. Timeouts bound a failure; they are not proof that concurrent work completed.
- Test error identity or type with `errors.Is` or `errors.As` when that is the contract. Assert exact text only when wording is part of the behavior being tested.
- Choose package-internal tests for internal contracts and external `_test` packages when exercising the consumer-facing API is useful. Do not export internals just for tests.
- Run focused tests while iterating and repository-required checks before finishing. Use race testing for relevant concurrency changes; a clean run is evidence, not proof of race freedom.

## Modern testing APIs

### Go 1.25+: `testing/synctest`

Use `synctest.Test` when the code's timers and synchronization fit its bubble
model. It is not a fake environment for external network or filesystem I/O.
Use the stable API, not the removed experimental `synctest.Run`:

```go
func TestCacheExpiry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache := NewCache(time.Minute)
		cache.Put("key", "value")

		time.Sleep(time.Minute)
		synctest.Wait()

		if _, ok := cache.Get("key"); ok {
			t.Fatal("entry did not expire")
		}
	})
}
```

The callback runs in an isolated bubble with a fake clock. `synctest.Wait`
blocks until other goroutines in the bubble are durably blocked. Do not call
`t.Run`, `t.Parallel`, or `t.Deadline` on the `*testing.T` supplied to the
callback.

### Go 1.24+: `t.Context` and `t.Chdir`

```go
client.Fetch(t.Context(), url) // canceled just before test cleanup runs
t.Chdir(t.TempDir())           // working directory restored after the test
```

Do not use `t.Chdir` in a parallel test or a test with parallel ancestors.
