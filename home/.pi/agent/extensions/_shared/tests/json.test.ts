import assert from "node:assert/strict";
import test from "node:test";
import { isRecord, parseJson } from "../json.ts";

test("parseJson returns unknown data and source-aware diagnostics", () => {
	assert.deepEqual(parseJson('{"ok":true}', "settings.json"), {
		ok: true,
		value: { ok: true },
	});
	const invalid = parseJson("{", "profiles.json");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) {
		assert.equal(invalid.diagnostic.source, "profiles.json");
		assert.match(invalid.diagnostic.message, /^profiles\.json: invalid JSON:/);
	}
});

test("isRecord excludes arrays and null", () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord([]), false);
	assert.equal(isRecord(null), false);
});
