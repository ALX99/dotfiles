.PHONY: user-cfg pi check

user-cfg:
	./init.sh 1

# Install npm dependencies for pi extensions in the stow target (~/.pi/agent/extensions/).
# Required after first `make user-cfg` or when package.json changes.
# The source's node_modules/ is a stale artifact — the target is canonical.
pi:
	cd ~/.pi/agent/extensions && npm install

# Run typecheck + lint + tests for the supervisor extension. Dev tooling
# lives in home/.pi/agent/extensions/; eslint.config.mjs ends in .mjs
# so pi's loader skips it.
check:
	cd home/.pi/agent/extensions && npm run check
