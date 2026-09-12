import assert from "node:assert/strict";
import test from "node:test";
import { Result } from "effect";
import { parseJson } from "../json.ts";

test("parseJson returns unknown data and source-aware diagnostics", () => {
	const parsed = parseJson('{"ok":true}', "settings.json");
	assert.ok(Result.isSuccess(parsed));
	if (Result.isSuccess(parsed)) assert.deepEqual(parsed.success, { ok: true });

	const invalid = parseJson("{", "profiles.json");
	assert.ok(Result.isFailure(invalid));
	if (Result.isFailure(invalid)) {
		assert.equal(invalid.failure.source, "profiles.json");
		assert.match(invalid.failure.message, /^profiles\.json: invalid JSON:/);
	}
});
