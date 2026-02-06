---
name: go-expert
description: Use when writing or reviewing Go code - covers naming, error handling, struct design, goroutines, and interfaces
---

# Go Expert Developer

## Overview

This skill provides Go best practices for writing clean, idiomatic, and maintainable code. Core principle: **Clear > Clever** - prioritize readability and simplicity over cleverness.

## When to Use

**Apply when:**

- Writing new Go code
- Reviewing Go code
- Modifying existing Go code (refactor to comply)

**Red flags:**

- "Existing code does it this way" - don't copy bad patterns
- "It's just a small change" - standards always apply
- "I'll refactor later" - refactor now while context is fresh

## Principles

- **KISS**: Code should be as simple as possible; avoid premature abstractions and optimizations
- **DRY**: Extract shared patterns
- **YAGNI**: Don't build until needed
- **Clear > Clever**: Readability is EXTREMELY important. Do not sacrifice clarity for cleverness.
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
func NewRedis() *Redis { ... }   // storage.NewRedis()
func NewPostgres() *Postgres { ... }

// ✗ Redundant - package already says "server"
package server
func NewServer() *Server { ... }
```

### Methods

```go
// ✓ No Get prefix
func (u *User) Name() string { ... }
func (c *Client) FetchUser(id string) (*User, error) { ... }

// ✗ Get prefix
func (u *User) GetName() string { ... }
```

### Variables

Rule: distance from declaration → name length.

```go
// ✓ Short names for small scopes
for i := range len(items) { ... }
func parse(r io.Reader) error { ... }

// ✓ Descriptive for wider scopes
func (s *Server) sendNotifications(userID string) error {
    user, err := s.db.GetUser(userID)
    // ...
}
```

### Receivers

```go
// ✓ 1-2 letter abbreviation
func (c *Client) Connect() error { ... }
func (ns *Namespace) Name() string { ... }
```

## Errors

### Wrapping Format

```go
// ✓ Imperative, lowercase, no "failed/error"
fmt.Errorf("connect to database: %w", err)
fmt.Errorf("parse config: %w", err)

// ✗ NEVER use these prefixes
fmt.Errorf("failed to connect: %w", err)
fmt.Errorf("error connecting to database: %w", err)
fmt.Errorf("could not connect: %w", err)
fmt.Errorf("unable to parse config: %w", err)
fmt.Errorf("Error parsing config: %w", err)
```

### Naming

```go
// ✓ Err prefix
var ErrNotFound = errors.New("not found")
var errInternal = errors.New("internal error")
```

## Structure

### Initialization

```go
// ✓ Empty slice
var users []User

// ✓ Named fields
user := User{Name: "John", Email: "john@example.com"}
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

### Reduce Nesting & Early Returns

```go
// ✓ Flat with early returns
func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
    id := r.URL.Query().Get("id")
    if id == "" {
        http.Error(w, "missing id", http.StatusBadRequest)
        return
    }

    user, err := s.db.GetUser(r.Context(), id)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    // happy path continues...
}
```

### Handle Once

```go
// ✓ Return OR log, never both
func loadConfig() (Config, error) {
    data, err := os.ReadFile("config.json")
    if err != nil {
        return Config{}, fmt.Errorf("load config: %w", err)
    }
    // ...
}
```

### Nil Handling

1. Functions returning `(T, error)` must return either a valid T or a non-nil error. Never both zero.
2. Pointer parameters are the caller's responsibility to ensure non-nil unless documented otherwise.

```go
// ✓ Caller ensures valid input — no defensive nil/zero checks
func (s *Service) DisableUser(user *User) error {
    user.Active = false
    if err := s.db.SaveUser(user); err != nil {
        return fmt.Errorf("save user: %w", err)
    }
    if err := s.cache.Invalidate(user.ID); err != nil {
        return fmt.Errorf("invalidate cache: %w", err)
    }
    return nil
}

// ✗ Defensive checks that are the caller's responsibility
func (s *Service) DisableUser(user *User) error {
    if user == nil {
        return errors.New("user is nil")
    }
    // ...
}
```

### Pass by Value

Default to value semantics. Use pointers only for:

- Types with pointer semantics (`sync.Mutex`, `sql.DB`)
- Types conventionally returned as pointers (`*bytes.Buffer`)
- Non-data structs such as servers, clients, handlers with a long lifecycle needing mutation

```go
// ✓ Value for config, time
func (s *Server) Start(cfg Config) error { ... }
func formatTimestamp(t time.Time) string { ... }

// ✓ Pointer for mutation, semantics
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request)
```

## Goroutines

- Goroutines must not leak. Use contexts or wait groups to manage lifecycle.
- Goroutines must not be unbounded in number.

```go
func deleteUsers(ctx context.Context, userIDs []int) ([]User, error) {
	eg, ctx := errgroup.WithContext(ctx)
	eg.SetLimit(5) // ✓ Bound concurrency
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

    // ✓ Wait for all goroutines to finish
	if err := eg.Wait(); err != nil {
		return nil, err
	}

	return users, nil
}
```

## Interfaces

**Placement**: Define interfaces in the consuming package, not the implementing package.
**Embedding**: Prefer composition over type embedding to avoid surprises.

```go
// ✓ Pass interface by value
func parseYAML(r io.Reader) (Config, error) { ... }

// ✗ Pointer to interface
func parseYAML(r *io.Reader) (Config, error) { ... }
```

### Testability

Don't add interfaces just for testing. Code should be testable as-is. Accept interfaces and return structs.

## Documentation

```go
// Package server provides HTTP server functionality.
package server

// Config contains server configuration.
type Config struct {
    Port int
}

// New creates a server instance.
func New(cfg Config) *Server { ... }
```

## Miscellaneous

- API surface should be minimal; unexported by default.
- Use logging sparingly; log only when it adds important context.
- Prefer the standard library over third-party packages unless absolutely necessary.
- Avoid init functions; prefer explicit initialization.
- Use `iota` (starting from `1`) for related constants. `stringer` can be used for generating string representations.
- Use `defer` for resource cleanup and unlocking mutexes.

## Additional References

- [TESTING.md](references/TESTING.md) - Table-driven tests, test helpers, naming conventions
- [PKG_DESIGN.md](references/PKG_DESIGN.md) - Package naming, project layouts, API surface design
