# pi-web smoke test

Run before merging any change to `pi-web/`.

## Setup

```bash
cd pi-web
npm install
npm run typecheck
npm test
```

All three must succeed. Tests: 38 across `protocol.test.ts`,
`open-browser.test.ts`, `bridge.test.ts`, `server.test.ts`,
`runtime.test.ts` (one is skipped if no API key is available).

## Manual end-to-end

```bash
mkdir -p /tmp/pw-smoke
cd /tmp/pw-smoke
PI_WEB=0 /path/to/pi-web/node_modules/.bin/tsx /path/to/pi-web/src/server.ts --cwd /tmp/pw-smoke
```

In another terminal:

```bash
open http://127.0.0.1:7878/
```

Verify:

1. Page loads. Sidebar shows Session, Model, Thinking sections.
2. The Model picker is empty if no API key is configured; if a key
   exists, the picker lists available models.
3. Type a message and press Enter. The user message appears; an
   assistant response streams in (if a key is configured). If no key,
   an error toast appears with the SDK's error message.
4. Click `+ New session`. The chat clears. A new session entry
   appears in the session list.
5. Click a prior session in the list. The chat shows that session's
   messages.
6. Change the model in the picker. The next prompt uses the new
   model.
7. Change the thinking level. The next prompt uses the new level.
8. Send a long prompt; press Abort. The "Abort" button works, the
   partial response is discarded.
9. Close the browser tab. The server still runs.
10. Press Ctrl-C in the server terminal. Clean exit.

## What is not tested in v0.1

- Streaming deltas rendering (covered in `bridge.test.ts` only at the
  event-forwarding level; visual verification is manual).
- Multiple browser tabs in sync.
- Session tree (forks, branches) — not in v0.1.
- Image attachments — not in v0.1.
- Markdown rendering — text is shown as-is.
