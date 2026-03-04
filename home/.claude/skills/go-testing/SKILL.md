---
name: go-testing
description: Use when writing, editing, or reviewing Go test code
---

# Go Testing

Go testing best practices for clean, parallel, maintainable tests. Use alongside the **go-code** skill.

## Context

- The project is using Go version !`go list -m -f '{{.GoVersion}}'`. Your training data might be outdated; verify against the latest docs.

## Principles

- **Parallel by default**: `t.Parallel()` at both outer and subtest level
- **No error returns from helpers**: call `t.Fatal`/`t.Fatalf` directly
- **Table-driven**: default structure for multiple cases
- **Minimal assertions**: stdlib only — no testify unless already in the project

## Table-Driven Tests

```go
func TestGetUser(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name    string
        id      string
        wantErr bool
    }{
        {name: "found", id: "user-1", wantErr: false},
        {name: "not found", id: "missing", wantErr: true},
        {name: "empty id", id: "", wantErr: true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()
            _, err := svc.GetUser(t.Context(), tt.id)
            if (err != nil) != tt.wantErr {
                t.Errorf("GetUser(%q) error = %v, wantErr %v", tt.id, err, tt.wantErr)
            }
        })
    }
}
```

## Test Helpers

- Always `t.Helper()` — failure lines point to the call site, not the helper body
- **Never return `error`** — call `t.Fatal`/`t.Fatalf` directly

```go
// ✓ Fatal on failure — caller stays clean
func requireUser(t *testing.T, db *DB, id string) *User {
    t.Helper()
    u, err := db.GetUser(id)
    if err != nil {
        t.Fatalf("get user %q: %v", id, err)
    }
    return u
}

// ✗ Returning error — negates the helper
func getUser(t *testing.T, db *DB, id string) (*User, error) { ... }
```

Use `t.Errorf` (non-fatal) when the test can meaningfully continue; `t.Fatalf` when continuing would produce noise or panic.

## Naming

- Test files: same base name as the file under test (`user.go` → `user_test.go`)
- Test functions: `TestFunctionName` or `TestTypeName_MethodName`

## Modern Testing Idioms

### t.Context / t.Chdir (Go 1.24+)

```go
client.Fetch(t.Context(), url) // context canceled when test finishes
t.Chdir(t.TempDir())           // cwd restored after test
```

### testing/synctest (Go 1.25+)

Deterministic concurrency testing with fake clock. `synctest.Run(func() { ... })` creates an isolated bubble; `synctest.Wait()` blocks until all goroutines are durably blocked, then fake time advances to next timer event. Eliminates timing-dependent flakiness.

```go
func TestRetryBackoff(t *testing.T) {
    synctest.Run(func() {
        attempts := 0
        go retry(func() error {
            attempts++
            return errors.New("fail")
        }, 3)

        synctest.Wait() // goroutine is sleeping between retries
        // fake time is now past first backoff; no wall-clock time spent
        synctest.Wait()
        if attempts != 3 {
            t.Fatalf("got %d attempts, want 3", attempts)
        }
    })
}
```

Channels/timers inside bubble are bubble-scoped; using from outside panics.
