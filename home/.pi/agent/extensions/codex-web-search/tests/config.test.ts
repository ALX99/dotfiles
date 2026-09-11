import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configPath, DEFAULT_CONFIG, loadConfig } from "../config.ts";

function writeConfig(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-web-search-"));
	const path = join(dir, "config.json");
	writeFileSync(path, contents);
	return path;
}

test("a missing config file yields defaults without diagnostics", () => {
	const loaded = loadConfig(join(tmpdir(), "codex-web-search-missing", "config.json"));
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.deepEqual(loaded.diagnostics, []);
});

test("optional fields override defaults", () => {
	const loaded = loadConfig(writeConfig(JSON.stringify({ enabled: false, mode: "cached", suppressClientTools: [] })));
	assert.deepEqual(loaded.diagnostics, []);
	assert.deepEqual(loaded.config, { enabled: false, mode: "cached", suppressClientTools: [] });
});

test("invalid fields fall back with diagnostics instead of disabling the extension", () => {
	const loaded = loadConfig(
		writeConfig(JSON.stringify({ enabled: "yes", mode: "everything", suppressClientTools: ["ok", 7] })),
	);
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.equal(loaded.diagnostics.length, 3);
	assert.match(loaded.diagnostics[0] ?? "", /"enabled" must be a boolean$/);
	assert.match(loaded.diagnostics[1] ?? "", /"mode" must be one of cached, live, indexed$/);
	assert.match(loaded.diagnostics[2] ?? "", /"suppressClientTools" must be an array of strings$/);
});

test("invalid JSON and non-object configs report a diagnostic", () => {
	const invalid = loadConfig(writeConfig("{"));
	assert.equal(invalid.diagnostics.length, 1);
	assert.match(invalid.diagnostics[0] ?? "", /invalid JSON/);
	assert.deepEqual(invalid.config, DEFAULT_CONFIG);

	const array = loadConfig(writeConfig("[]"));
	assert.equal(array.diagnostics.length, 1);
	assert.match(array.diagnostics[0] ?? "", /expected a JSON object/);
	assert.deepEqual(array.config, DEFAULT_CONFIG);
});

test("an unreadable config path reports a diagnostic", () => {
	const loaded = loadConfig(mkdtempSync(join(tmpdir(), "codex-web-search-dir-")));
	assert.equal(loaded.diagnostics.length, 1);
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
});

test("the environment variable overrides the config path", () => {
	assert.equal(configPath({ PI_CODEX_WEB_SEARCH_CONFIG: "/tmp/other.json" }), "/tmp/other.json");
	assert.equal(
		configPath({ PI_CODEX_WEB_SEARCH_CONFIG: "  " }),
		join(process.env.HOME ?? "", ".pi", "codex-web-search.json"),
	);
});
