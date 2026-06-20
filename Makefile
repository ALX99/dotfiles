.PHONY: user-cfg check lint typecheck test

user-cfg:
	./init.sh 1

# Run typecheck, lint, and tests in order. Stops on first failure.
# Dev tooling lives in home/.pi/agent/extensions.dev/ (sibling of
# extensions/, with no index.ts/index.js so pi's loader skips it).
check:
	cd home/.pi/agent/extensions.dev && npm run check

# Run only the supervisor extension's linter (eslint).
lint:
	cd home/.pi/agent/extensions.dev && npm run lint

# Run only the supervisor extension's typecheck (tsc).
typecheck:
	cd home/.pi/agent/extensions.dev && npm run typecheck

# Run only the supervisor extension's tests (node --test).
test:
	cd home/.pi/agent/extensions.dev && npm run test
