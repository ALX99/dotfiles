---
paths: "**/*.go"
---

# Go Code Standards

Write minimal, idiomatic Go with KISS-first design.

## Core Principles

- **KISS**: Simplify; remove unnecessary interfaces
- **DRY**: Extract shared patterns; avoid premature abstraction
- **YAGNI**: Don't build until needed
- **Clear > clever**: Readability is paramount
- **Idiomatic Go**: stdlib first; don't import other languages' idioms

## Naming

### Constructors

- Use `New()` when package name provides context: `server.New()` not `server.NewServer()`

### Methods

- No `Get` prefix: `Name()` not `GetName()`
- Use `Fetch`/`Load` for operations that do work: `FetchUser(id)`

### Variables

- Distance from declaration → name length
- Short names for small scopes: `for i := range items`
- Descriptive for wider scopes: `userID` not `u`

### Receivers

- 1-2 letter abbreviation: `(s *Server)`, `(c *Client)`
- Never `this` or `self`

### Loggers

- Name `*slog.Logger` as `log`

## Errors

### Wrapping

- Imperative, lowercase, no "failed/error": `fmt.Errorf("connect to database: %w", err)`
- Bad: `fmt.Errorf("failed to connect: %w", err)`

### Handle Once

- Return OR log, never both
- Prefer `fmt.Errorf` over `errors.New` with `fmt.Sprintf`

### Naming

- `Err` prefix: `var ErrNotFound = errors.New("not found")`

## Structure

### Early Returns

- Flat with early returns, avoid nested conditionals
- Guard clauses at the top

### Initialization

- Empty slice: `var s []T` not `make([]T, 0)`
- Named struct fields: `User{Name: "John"}` not `User{"John"}`
- Zero-value mutexes: `mu sync.Mutex` not `mu *sync.Mutex`

### Struct Field Grouping

- Embedded types first, then grouped logically
- Mutex with the fields it protects

### Pass by Value

- Default to value semantics
- Pointers only for: types with pointer semantics (`sync.Mutex`), large structs needing mutation, conventionally pointer types (`*bytes.Buffer`)

## Resource Management

- `defer` for cleanup immediately after acquiring resource
- `defer` for mutex unlock

## Context

- Always first parameter
- Never stored in structs
- Pass explicitly through call chain

## Interfaces

- Pass by value, never pointer to interface
- Define in consuming package, not implementing package
- Prefer composition over embedding

## Performance

- `strconv` over `fmt` for simple conversions
- Minimize string-to-byte conversions
- Reduce variable scope

## Testing

- Table-driven tests with `t.Parallel()`
- `t.Helper()` in test helpers
- Target 80%+ coverage
- Prefer `io.Reader`/`io.Writer` over filesystem

## Package Design

- Singular form: `package user` not `package users`
- Lowercase, no underscores
- Short and clear, avoid `common`, `util`
- `main` package: small, focused on initialization

## Other

- Avoid `init()` except for registry patterns
- `os.Exit`/`log.Fatal` only in `main()`
- Use `time.Duration` for durations, `time.Time` for timestamps
- Avoid naked returns
- Use `iota` for enums, implement `String()`
