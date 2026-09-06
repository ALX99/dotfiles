---
name: zg
description: Search code by concept with zvec-grep (zg) when the implementation name or location is unknown, or use zg explicitly for indexed symbol search and scope-annotated ripgrep. Use for requests such as "find where retries are handled" or "locate the session cleanup logic." Prefer native grep for exact text and a language server for precise definitions or references.
---

# zg

Find candidate code with hybrid full-text/vector search, then verify it
against the working tree. Indexed results are ranked candidates, not an
exhaustive definition-and-reference graph.

## Search workflow

1. Run from the intended workspace root. Check `command -v zg` if availability
   is unknown. If unavailable, use native search tools; do not install it
   merely to complete a lookup.
2. Before the first indexed search in a workspace, run `zg status` to check
   index coverage and readiness. If no usable index exists, use grep or
   managed `rg` instead. See **Index setup and recovery** only when indexing
   is needed.
3. Start with one focused hybrid query describing the behavior. Include
   domain terms, not a long task description. Request a few short previews:

   ```sh
   zg query "where child sessions are cleaned up" --limit 5 --preview short --refresh off
   ```

4. Open the best matching files with the harness file reader. Follow concrete
   symbols with grep or a language server. Once a relevant implementation is
   found, inspect its callers and tests instead of issuing more broad queries.
5. If results are weak, reformulate once with terms found in the code or narrow
   the paths. If expected files are still absent, check coverage and freshness
   before drawing conclusions.
6. Report verified file paths and line numbers with a brief explanation.
   Distinguish "no indexed matches" from "the code does not exist."

## Targeted searches

Use these when the default hybrid query needs refinement:

```sh
# Lexical search for a known name; not exhaustive references.
zg query --fts "AuthService" --prefer-symbol --limit 5 --refresh off

# Restrict candidates to TypeScript outside test directories.
zg query "session cleanup" -t ts -g '!**/tests/**' --limit 5 --refresh off

# Combine distinct lexical and semantic queries into one ranked list.
zg query --fts "AuthService" --vector "validate access tokens" --fuse --limit 5 --refresh off

# Read the working tree without an index, with symbol scopes.
zg query --rg --hidden -F "ManagedAgent" home/.pi/agent/extensions
```

- `-g/--glob` filters paths case-sensitively; `--iglob` is case-insensitive.
  Repeat either flag; prefix a glob with `!` to exclude paths.
- `-t/--type` and `-T/--type-not` select ripgrep file types, not directory
  categories. Exclude tests with path globs matching the repository layout.
- `--symbol-type` filters to `module`, `class`, `interface`, `function`,
  `value`, or `alias`.
- Results default to agent markdown. Indexed previews default to `none`;
  use `--preview short` to triage candidates, then read current files.

## Coverage and freshness gotchas

- **Hidden paths:** indexing and managed `rg` skip hidden paths by default.
  Use `zg index --hidden` when building coverage for dot-directories and
  `zg query --rg --hidden` when searching them directly. An indexed query
  cannot recover files omitted during indexing, even with a matching glob.
- **Stale results:** indexes are snapshots. Verify hits in current source,
  especially after edits. Use grep or managed `rg` for fresh, exhaustive text
  matching within the selected paths.
- **Refresh side effects:** the examples use `--refresh off` to avoid
  implicit refresh work. `--refresh wait` updates before searching;
  `background` is supported in server mode but falls back to `off` in direct
  mode. Refresh only when index updates are appropriate for the task.
- **Empty results:** check the workspace root, hidden-path coverage, ignore
  rules, file filters, and index status. Do not rebuild solely because one
  query returned nothing.

## Index setup and recovery

When the task warrants creating an index, use a local embedding model:

```sh
zg index --embedding local/potion-code-16m-v2
# For dotfile workspaces, include hidden paths:
zg index --hidden --embedding local/potion-code-16m-v2
```

Choose one command appropriate to the workspace. Indexing writes
`<root>/.zvec-grep` and local models may download on first use. New indexes
require an explicit model or configured default; existing indexes reuse
their stored embedding schema.

Do not enable remote embeddings or grant workspace authorization without
user approval: remote providers can receive source content. Do not drop
indexes, change global configuration, start daemons, or install agent
integrations as a search fallback.

For setup requests or version-specific errors, consult `zg index --help`,
`zg query --help`, or `zg help models` rather than guessing flags.
