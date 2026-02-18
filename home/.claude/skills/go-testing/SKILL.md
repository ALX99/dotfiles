---
name: go-testing
description: Use when writing, editing, or reviewing Go test code
---

# Go Testing

Go testing conventions for clean, parallel, maintainable tests. Use alongside the **go-code** skill for all Go test files.

## Table-Driven Tests

`t.Parallel()` at both the outer and inner level.

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

- Always `t.Helper()` — failure lines point to the call site, not the helper body.
- **Never return `error`** — call `t.Fatal`/`t.Fatalf` directly. Returning an error forces callers to handle it, defeating the purpose of the helper.

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

// ✗ Returning error — caller must check it, negates the helper
func getUser(t *testing.T, db *DB, id string) (*User, error) {
    t.Helper()
    return db.GetUser(id)
}
```

Use `t.Errorf` (non-fatal) when the test can meaningfully continue after the failure; use `t.Fatalf` when continuing would produce noise or a panic.

## Naming

- Test files: same base name as the file under test (`user.go` → `user_test.go`)
- Test functions: `TestFunctionName` or `TestTypeName_MethodName`
