# pi-web

A localhost browser UI for [pi](https://github.com/badlogic/pi-mono), the
coding agent. Drop-in TUI replacement: same sessions, same extensions,
same skills — just a browser tab instead of a terminal.

## Run it

```bash
cd pi-web
npm install
npm run dev
```

This starts an HTTP server on `http://127.0.0.1:7878` and opens your
browser. The session lives in whatever directory you ran `npm run dev`
from (use `--cwd <path>` to chat about a different project).

## What's in scope (v0.1)

- Chat (streaming text, thinking, tool calls)
- New session, switch session, list prior sessions
- Model picker, thinking-level picker
- Abort
- Persists to the same `~/.pi/agent/sessions/` tree the TUI uses

## What's not

Session tree UI (fork/branch), steering/follow-up queue UI, compaction
controls, image attachments, markdown rendering. See
`docs/superpowers/specs/2026-06-21-pi-web-design.md` for the full spec.

## Layout

```
src/        # server + bridge + protocol
src/web/    # static frontend (Preact + HTM, no build step)
tests/      # node:test
```
