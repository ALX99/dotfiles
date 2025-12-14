# INSTRUCTIONS

## GENERAL

- Keep it concise, clear, and to the point
- Always consider alternatives, best practices and, ways to improve
- Before saying something is wrong, use `WebSearch` and `WebFetch` to verify
- Before writing code, launch an `Explore` subagent to gather context, problem domain knowledge, and then ask clarifying questions

## CODE

- Do not add code comments for trivial things
- I want simple and KISS code, no over-engineered bullshit

### GOLANG

- Use the gopls MCP's go_search to find code you are looking for
- Use the gopls MCP's go_diagnostics to find build errors
- Use the gopls MCP's go_symbol_references to find usages of symbols
- Prefer to use table-driven tests.
