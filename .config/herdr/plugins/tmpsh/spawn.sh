#!/bin/sh
# Keybound action for dozy.tmpsh: give the tmpsh pane its own focused
# workspace. Plugin panes cannot be born into a new workspace, so the pane
# opens as an unzoomed staging tab (overlay panes are zoomed and zoomed
# panes refuse to move) and is moved immediately. The pane runs the stowed
# tmpsh, whose exit trap deletes the temp directory when the shell exits;
# Herdr then closes the emptied workspace.
#
# Actions can inherit a HERDR_BIN_PATH that no longer exists and a PATH
# without herdr, hence the fallback chain.
set -eu

if [ -x "${HERDR_BIN_PATH:-}" ]; then
	bin=$HERDR_BIN_PATH
elif command -v herdr >/dev/null 2>&1; then
	bin=herdr
else
	bin=$HOME/.local/share/mise/shims/herdr
fi

fail() {
	"$bin" notification show "Tmpsh failed" "$1" || true
	echo "dozy.tmpsh: $1" >&2
	exit 1
}

staged=$("$bin" plugin pane open \
	--plugin dozy.tmpsh --entrypoint tmpsh --no-focus) ||
	fail "could not open tmpsh pane"

# The open response contains exactly one pane_id: the staged pane's.
pane_id=$(printf '%s' "$staged" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p')
[ -n "$pane_id" ] || fail "open response had no pane_id"

moved=$("$bin" pane move "$pane_id" \
	--new-workspace --label tmpsh --focus) ||
	fail "could not move tmpsh pane to a new workspace"
case $moved in
*'"changed":true'*) ;;
*) fail "herdr refused to relocate the tmpsh pane" ;;
esac
