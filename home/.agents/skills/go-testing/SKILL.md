---
name: go-testing
description: Use when writing, editing, or reviewing Go test code
---

# Go Testing

Use alongside the **go-code** skill.

## Context

- Determine the project's Go version by running `go list -m -f '{{.GoVersion}}'`. Your training data might be outdated; verify against the latest official docs.
- Use testing APIs only when supported by the module's effective Go version. Do not raise the minimum Go version merely to shorten a test.
- Go 1.27 is unreleased until August 2026 and its release notes are still draft. Re-check <https://go.dev/doc/go1.27> before relying on a 1.27 testing API.

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

Use `synctest.Test` for deterministic concurrency tests with a fake clock. The callback runs in an isolated bubble; `synctest.Wait()` waits until every goroutine in the bubble is durably blocked, allowing fake time to advance without wall-clock delays.

Do not use the obsolete experimental `synctest.Run` API. It was renamed to `synctest.Test` for the stable package and removed in Go 1.26.

```go
func TestDelayedSend(t *testing.T) {
    t.Parallel()

    synctest.Test(t, func(t *testing.T) {
        ch := make(chan string, 1)
        go func() {
            time.Sleep(time.Second)
            ch <- "done"
        }()

        synctest.Wait()
        select {
        case got := <-ch:
            t.Fatalf("received %q before delay elapsed", got)
        default:
        }

        time.Sleep(time.Second)
        synctest.Wait()
        if got := <-ch; got != "done" {
            t.Fatalf("got %q, want done", got)
        }
    })
}
```

Channels, timers, and synchronization primitives created inside the bubble are bubble-scoped; using them incorrectly across the boundary may panic.

### synctest.Sleep (Go 1.27+)

For modules targeting Go 1.27+, use `synctest.Sleep(d)` instead of the common `time.Sleep(d)` followed by `synctest.Wait()` sequence. It advances fake time and waits for the bubble to become durably blocked again.

```go
synctest.Sleep(time.Second)
if got := <-ch; got != "done" {
    t.Fatalf("got %q, want done", got)
}
```

### Standard-Library Version Checks (Go 1.27+)

`go test` runs the `stdversion` vet analyzer by default. If a test refers to a standard-library symbol newer than the file's effective Go version, fix the version mismatch rather than suppressing the check.

When consuming `go test -json`, tolerate unknown fields. Go 1.27 events may include `OutputType` for structured error and frame output.
