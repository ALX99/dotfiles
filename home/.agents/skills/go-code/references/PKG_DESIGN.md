# Package design

Organize packages around cohesive capabilities and consumer needs, not file
counts or a prescribed directory template.

## Names and boundaries

- Use short, descriptive lowercase names without underscores or mixed capitals.
- Choose singular or plural according to meaning; `bytes`, `strings`, and `errors` are valid examples.
- Avoid vague packages such as `common`, `util`, or `helpers`. Name the capability instead.
- Read exported names with their package qualifier. Avoid stuttering, but retain useful distinctions: `server.New` fits a single primary type; packages with multiple constructors may need `NewClient` and `NewServer`.
- Split packages when responsibilities, consumers, or dependency boundaries genuinely differ. Neither many files nor a small package is inherently a design problem.
- Keep closely related types together. Do not create layers that mainly forward calls or force consumers to coordinate tightly coupled packages.
- Keep imports acyclic. Resolve cycles by reconsidering ownership and dependencies, not by moving arbitrary code into a shared bucket.

## Visibility and layout

- Start with the simplest layout. A small library or single-command application can live at the module root.
- Use `cmd/<name>/` when multiple commands or separation from a root library makes it useful.
- Use `internal/` for code that must not be imported outside its allowed tree. Go enforces this: importers must be within the tree rooted at the parent of `internal`.
- `pkg/` has no special visibility semantics and is not required for public libraries. Prefer meaningful packages at the module root unless the repository has an established reason for it.
- Do not create empty architectural directories in anticipation of future growth.

For example, an application with two commands might use:

```text
myapp/
├── cmd/
│   ├── api/main.go
│   └── worker/main.go
├── internal/
│   ├── server/
│   └── store/
└── go.mod
```

## Command entry points

Keep `main` focused on process setup and exit policy. Put work that needs
deferred cleanup in a returning function: `os.Exit` does not run defers.
Choose signal handling and cancellation exit status according to the command's
contract rather than imposing a universal policy.

```go
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	return serve(ctx)
}
```

## Public APIs

- Export only what consumers need. Constructors should establish required invariants; make zero values useful when that is natural, not mandatory.
- Keep fields private when mutation would violate invariants or expose implementation details. Public fields are appropriate for plain data and configuration.
- Define interfaces around consumer operations, not every method of an implementation.
- Document ownership, mutation, concurrency safety, nil/zero behavior, and error semantics when callers need that information.
- Treat observable behavior—including wrapped errors and serialization—as compatibility commitments. Avoid expanding the public surface for hypothetical reuse.

## Documentation

Use package comments to explain purpose and important usage constraints.
Place them in `doc.go` when they warrant a separate file; it is not required
for every package. Document exported identifiers with comments beginning with
their names, and prefer executable examples for nontrivial usage.
