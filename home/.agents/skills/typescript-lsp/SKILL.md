---
name: typescript-lsp
description: "Use for TypeScript/JavaScript symbol navigation: resolve definitions, references, types, implementations, call-site information, or file/workspace symbols before text search."
---

# TypeScript LSP navigation

Use `tsc_lsp.py` for semantic TypeScript/JavaScript navigation before text
search when resolving a symbol, its type, implementations, or references.

Positions are `path/file.ts:line:column` (1-based), matching `gopls`. The
project root is inferred from the nearest `tsconfig.json` or `jsconfig.json`;
use `--root /path/to/project` when needed.
For `workspace-symbols`, there is no source file from which to infer the
project, so run it from the project directory or pass `--root` explicitly.
This is especially important when the current directory is a repository
containing multiple TypeScript projects.

```sh
tsc='python3 ~/.agents/skills/typescript-lsp/scripts/tsc_lsp.py'
$tsc definition src/service.ts:42:7
$tsc references src/service.ts:42:7
$tsc implementations src/service.ts:42:7
$tsc type-definition src/service.ts:42:7
$tsc hover src/service.ts:42:7
$tsc document-symbols src/service.ts
$tsc workspace-symbols --query UserService
```

Results are line-oriented locations using 1-based positions. Use returned
locations directly in follow-up queries.
