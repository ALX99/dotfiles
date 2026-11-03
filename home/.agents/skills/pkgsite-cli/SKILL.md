---
name: pkgsite-cli
description: Use when looking up Go package or module documentation, APIs, exported symbols, examples, or versions on pkg.go.dev; discovering packages; or checking imports, dependencies, vulnerabilities, and licenses. Uses pkgsite-cli for published public Go packages and modules.
---

# pkgsite-cli

Use `pkgsite-cli` to discover public Go packages and modules, then inspect
their published metadata on pkg.go.dev. Choose `search` for discovery,
`package` for an import path, and `module` for a module path.

## Search packages

```sh
pkgsite-cli search 'uuid'
pkgsite-cli search -symbol NewClient client
```

`-symbol <name>` requires a matching exported symbol. The positional query still
restricts the package search, so use a broad related term such as `client`;
it is not documentation text or a second symbol name.

## Inspect a package

```sh
pkgsite-cli package github.com/google/go-cmp/cmp
pkgsite-cli package -doc md -examples github.com/google/go-cmp/cmp
pkgsite-cli package -symbols -imports -licenses github.com/google/go-cmp/cmp
pkgsite-cli package -imported-by github.com/google/go-cmp/cmp
```

## Inspect a module

```sh
pkgsite-cli module golang.org/x/tools
pkgsite-cli module -versions -packages golang.org/x/tools
pkgsite-cli module -vulns -licenses -readme golang.org/x/tools
```

## Versions and ambiguous paths

- Append `@version` to a package or module path; omit it for the latest
  version. `@main` and `@master` resolve to pseudo-versions.
- If a package belongs to more than one module, pass its module path with
  `-module` rather than guessing.

```sh
pkgsite-cli package github.com/google/go-cmp/cmp@v0.7.0
pkgsite-cli package -module google.golang.org/genproto/googleapis/rpc google.golang.org/genproto/googleapis/rpc/status
```

## Structured output

Pass `-json` when another command or script needs structured output:

```sh
pkgsite-cli module -json -versions golang.org/x/tools
pkgsite-cli package -json -symbols github.com/google/go-cmp/cmp
```
