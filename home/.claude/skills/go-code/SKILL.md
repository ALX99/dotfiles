---
name: go-code
description: Use ALWAYS when writing, editing, or reviewing ANY Go code — no exceptions, no matter how simple the task
---

# Go Code

## Overview

Go best practices for clean, idiomatic, maintainable code. Core principle: **Clear > Clever**.

## Context

- The project is using Go version !`go list -m -f '{{.GoVersion}}'`. Your training data might be outdated; verify against the latest docs.

## Principles

- **KISS**: As simple as possible; avoid premature abstractions and optimizations
- **DRY**: Extract shared patterns
- **YAGNI**: Don't build until needed
- **Clear > Clever**: Do not sacrifice readability for cleverness
- **Idiomatic Go**: stdlib first; don't import other languages' idioms
- Follow Uber's Go Style Guide, Google's Go Style Guide, and Effective Go

## Naming

### Constructors

Default to `New()` when the package name provides context. Only use `NewX()` when the package contains multiple constructible types.

```go
// ✓ package.New() - the default
package server
func New() *Server { ... }  // server.New()

// ✓ NewX() only when package has multiple types
package storage
func NewRedis() *Redis { ... }
func NewPostgres() *Postgres { ... }

// ✗ Redundant - package already says "server"
func NewServer() *Server { ... }
```

### Methods & Receivers

```go
// ✓ No Get prefix; 1-2 letter receiver abbreviation
func (u *User) Name() string { ... }
func (c *Client) FetchUser(id string) (*User, error) { ... }
func (ns *Namespace) Name() string { ... }

// ✗ Get prefix
func (u *User) GetName() string { ... }
```

### Variables

Rule: distance from declaration → name length.

```go
for i := range len(items) { ... }           // ✓ short scope → short name
func parse(r io.Reader) error { ... }        // ✓ short scope → short name
func (s *Server) sendNotifications(userID string) error { ... } // ✓ wide scope → descriptive
```

## Errors

### Wrapping Format

```go
// ✓ Imperative, lowercase, no "failed/error"
fmt.Errorf("connect to database: %w", err)

// ✗ NEVER use these prefixes
fmt.Errorf("failed to connect: %w", err)
fmt.Errorf("error connecting to database: %w", err)
```

### Naming

```go
var ErrNotFound = errors.New("not found")   // ✓ Err prefix
var errInternal = errors.New("internal error")
```

### errors.AsType (Go 1.26+)

Prefer over `errors.As` — generic, type-safe, no pre-declared target variable.

```go
if e, ok := errors.AsType[*url.Error](err); ok { ... } // ✓
```

## Structure

### Initialization

```go
var users []User                                       // ✓ nil slice, not make
user := User{Name: "John", Email: "john@example.com"}  // ✓ named fields
```

### Struct Field Grouping

```go
// ✓ Grouped logically, embedded types first
type Server struct {
    httpSrv *http.Server

    host string
    port int

    log     *slog.Logger
    metrics *Metrics

    mu    sync.Mutex
    conns map[string]*Conn
}
```

### Early Returns

```go
// ✓ Guard clauses, flat happy path
if id == "" {
    http.Error(w, "missing id", http.StatusBadRequest)
    return
}
user, err := s.db.GetUser(r.Context(), id)
if err != nil { ... }
// happy path continues...
```

### Handle Errors Once

Return OR log, never both.

```go
// ✓ Return the error — let caller decide
return Config{}, fmt.Errorf("load config: %w", err)

// ✗ Log AND return — error gets reported twice
log.Error("failed to load config", "err", err)
return Config{}, fmt.Errorf("load config: %w", err)
```

### Nil Handling

1. `(T, error)` returns: valid T or non-nil error. Never both zero.
2. Pointer params: caller's responsibility to ensure non-nil.

```go
// ✓ No defensive nil check — caller's contract
func (s *Service) DisableUser(user *User) error {
    user.Active = false
    return s.db.SaveUser(user)
}

// ✗ Defensive check that's the caller's responsibility
func (s *Service) DisableUser(user *User) error {
    if user == nil { return errors.New("user is nil") }
    // ...
}
```

### Pass by Value

Default to value semantics. Use pointers only for:

- Types with pointer semantics (`sync.Mutex`, `sql.DB`)
- Types conventionally returned as pointers (`*bytes.Buffer`)
- Long-lifecycle structs needing mutation (servers, clients, handlers)

```go
func (s *Server) Start(cfg Config) error { ... }  // ✓ value for config
func formatTimestamp(t time.Time) string { ... }  // ✓ value for time
```

## Goroutines

- Must not leak. Use contexts or wait groups to manage lifecycle.
- Must not be unbounded in number.

```go
func deleteUsers(ctx context.Context, userIDs []int) ([]User, error) {
	eg, ctx := errgroup.WithContext(ctx)
	eg.SetLimit(5)
	users := make([]User, len(userIDs))

	for i, id := range userIDs {
		eg.Go(func() error {
			user, err := fetchUser(ctx, id)
			if err != nil {
				return fmt.Errorf("fetch user %d: %w", id, err)
			}
			users[i] = user
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return nil, err
	}
	return users, nil
}
```

## Interfaces

- Define in the consuming package, not the implementing package
- Prefer composition over type embedding
- Don't add interfaces just for testing — accept interfaces, return structs

```go
func parseYAML(r io.Reader) (Config, error) { ... }   // ✓ interface by value
func parseYAML(r *io.Reader) (Config, error) { ... }   // ✗ pointer to interface
```

## Modern Go Idioms

### new() (Go 1.26+)

Use `new()` to get a pointer to a value instead of the `temp := val; &temp` pattern, or `func[T any](v T) *T { return &v }(val)` if you need to specify the type.

```go
// ✓ new() — direct pointer to value
Age: new(yearsSince(born)),

// ✗ temp variable just for addressing
age := yearsSince(born)
Age: &age,
```

### cmp.Or

```go
// ✓ cmp.Or for defaulting
return cmp.Or(os.Getenv("XDG_CONFIG_HOME"), filepath.Join(os.Getenv("HOME"), ".config"))

// ✗ manual defaulting
dir := os.Getenv("XDG_CONFIG_HOME")
if dir != "" { return dir }
return filepath.Join(os.Getenv("HOME"), ".config")
```

### unique.Make (Go 1.23+)

Canonicalizes comparable values (interning). `Handle[T]` comparison is O(1) pointer check. Use for high-cardinality repeated values (IPs, hostnames, labels). Don't use for rarely-repeated values — intern table has overhead.

```go
h1 := unique.Make("hello")
h2 := unique.Make("hello")
h1 == h2 // true — same canonical copy
h1.Value() // "hello"
```

### omitzero (Go 1.24+)

JSON tag option — omits field when zero. Prefer over `omitempty` for types with `IsZero() bool` (e.g. `time.Time`). Can combine both tags.

```go
StartTime time.Time `json:"start_time,omitzero"` // ✓ works correctly for zero time
```

### strings/bytes Iterators (Go 1.24+)

Lazy iterator versions of `Split`, `SplitAfter`, `Fields`, `FieldsFunc` → `SplitSeq`, `SplitAfterSeq`, `FieldsSeq`, `FieldsFuncSeq`. Plus `Lines`. All work with `range`. Prefer over slice-returning variants when you don't need all substrings at once. Available in both `strings` and `bytes`.

```go
for line := range strings.Lines(text) { ... }
for part := range strings.SplitSeq(text, ",") { ... }
```

## Miscellaneous

- Unexported by default; minimal API surface
- Prefer stdlib over third-party unless necessary
- Avoid `init()`; prefer explicit initialization
- Use `iota` (starting from `1`) for related constants; `stringer` for string representations
- Use `defer` for resource cleanup and mutex unlocking

## Additional References

- **go-testing** skill — anything related to Go tests
- [PKG_DESIGN.md](references/PKG_DESIGN.md) - Package naming, project layouts, API surface design
