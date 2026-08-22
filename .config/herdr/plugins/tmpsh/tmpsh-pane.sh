#!/bin/sh
# Pane entrypoint for dozy.tmpsh: reuse the stowed ~/.local/bin/tmpsh so the
# temp-directory semantics stay defined in one place, with a PATH fallback.

if [ -x "$HOME/.local/bin/tmpsh" ]; then
	exec "$HOME/.local/bin/tmpsh"
fi

if command -v tmpsh >/dev/null 2>&1; then
	exec tmpsh
fi

echo "dozy.tmpsh: tmpsh not found at ~/.local/bin/tmpsh or on PATH" >&2
exit 127
