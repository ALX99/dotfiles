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
- A helper that cannot continue should call `t.Fatal` or `t.Fatalf`; return an error when the caller genuinely needs to inspect it.
- Use `t.Errorf` when the test can meaningfully continue and `t.Fatalf` when continuing would create noise or panic.
- Keep assertions focused on behavior relevant to the test.

## Structure

- Name test files after the implementation file (`user.go` → `user_test.go`).
- Name tests `TestFunctionName` or `TestTypeName_MethodName`.
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

## Modern testing APIs

### Go 1.25+: `testing/synctest`

Use `synctest.Test`, not the removed experimental `synctest.Run`, for
deterministic tests of timers and concurrent code:

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
