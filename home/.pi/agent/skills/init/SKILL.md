---
name: init
description: Generate AGENTS.md — a contributor guide for this repository
disable-model-invocation: true
---

Generate a file named AGENTS.md that serves as a contributor guide for this repository.

Before writing, check whether AGENTS.md already exists in the current working directory. If it does, verify its contents against the repository, correct inaccurate or outdated information, and add any important information that is missing. Preserve existing accurate guidance and avoid unnecessary rewrites.

Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section. Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

## Process

Gather targeted evidence, then filter aggressively. Don't just list what you see—cross-reference until non-obvious patterns emerge.

1. **Read executable sources first** — Makefiles, CI workflows, package scripts, lockfiles, lint/format/build configs. These run; prose can lie.
2. **Map layout** — top-level dirs and what each owns. Enough to navigate, not a full tree.
3. **Sample representative implementation and test files** — read both sides of important plugin systems, platform branches, and abstraction boundaries. Stop when commands, structure, conventions, and architectural constraints have stabilized.
4. **Extract only what an agent would miss without help.** If it's obvious from a single file or filename, leave it out.

Every fact must be backed by a file path, command output, or git state. Speculation is worse than a gap — drop uncertain claims.

## Document Requirements

- **Title**: `# Repository Guidelines`
- **Format**: Markdown headings (`#`, `##`, `###`)
- **Length**: 200–400 words is optimal. Keep explanations short, direct, and specific to this repository.
- **Tone**: Professional, instructional.
- **Examples**: Include concrete examples where helpful (commands, directory paths, naming patterns, code snippets).

## Recommended Sections

### Project Structure & Module Organization

Outline where source code, tests, and assets live. Enough to know where to look.

**Good**: A concise entry for each top-level dir with what it owns:
```
main.go              CLI entry point (cobra)
internal/
  agent/             Session manager, coordinator, tools, MCP client integration
  config/            Config struct loading from crush.json with provider resolution
  lsp/               LSP client manager with lazy init per file type
```
**Better**: Also note the dependency that matters:
```
charm.land/fantasy   LLM provider abstraction — handles protocol differences between Anthropic, OpenAI, Gemini
```

### Key Patterns & Architecture Decisions

This is the highest-signal section. Capture the non-obvious architectural idioms that would take hours to rediscover.

- **Config is a Service** — accessed via `config.Service`, not global state.
- **Tools are self-documenting** — each tool has a `.go` implementation and a `.md` description file in `internal/agent/tools/`.
- **System prompts are Go templates** — `internal/agent/templates/*.md.tpl` with runtime data injected.
- **Separation of concerns** — event system (PostHog telemetry) uses internal pub/sub for decoupling between agent, UI, and services.

Include concrete details: config file names, module paths, env vars that control behavior.

### Build, Test, and Development Commands

List key commands for building, testing, and running locally. Briefly explain what each does. Include non-obvious ones:

- Single-test command: `go test ./internal/llm/prompt -run TestGetContextFromPaths`
- Golden file updates: `go test ./... -update` (regenerates `.golden` files)
- Formatting fallback chain: try `gofumpt`, then `goimports`, then `gofmt`
- Required command order if applicable (e.g., `lint → typecheck → test`)

### Coding Style & Naming Conventions

Specify indentation rules, language-specific preferences, naming patterns, and any formatting/linting tools used.

**Good**: "Use gofumpt (stricter than gofmt), enabled in golangci-lint. Imports grouped as stdlib, external, internal. Log messages start with a capital letter."

### Testing Guidelines

Frameworks, coverage expectations, test naming conventions, how to run tests. Include practical code snippets for common patterns:

```go
// Example: using mock providers to avoid API calls in tests
config.UseMockProviders = true
defer func() {
    config.UseMockProviders = originalUseMock
    config.ResetProviders()
}()
```

### Commit & Pull Request Guidelines

Summarize commit message conventions from the project's Git history. Outline PR requirements (descriptions, linked issues, screenshots).

### Common Gotchas

Optional but valuable. Capture the non-obvious pitfalls that took reading multiple files to infer:

- "CGO is disabled — builds with `CGO_ENABLED=0` and `GOEXPERIMENT=greenteagc`"
- "Always account for padding/borders in width calculations in the TUI"
- "Dialog messages are intercepted first in `Update` before other routing"

(Optional) Add other sections if relevant: Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
