import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runPromise } from "../../_shared/effect-runtime.ts";
import { configPath, DEFAULT_CONFIG, loadConfig } from "../config.ts";

/** Loading reads the filesystem, so every case awaits the extension runtime. */
function load(path: string) {
	return runPromise(loadConfig(path));
}

function writeConfig(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-web-search-"));
	const path = join(dir, "config.json");
	writeFileSync(path, contents);
	return path;
}

test("a missing config file yields defaults without diagnostics", async () => {
	const loaded = await load(join(tmpdir(), "codex-web-search-missing", "config.json"));
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.deepEqual(loaded.diagnostics, []);
});

test("optional fields override defaults", async () => {
	const loaded = await load(writeConfig(JSON.stringify({ enabled: false, mode: "cached", suppressClientTools: [] })));
	assert.deepEqual(loaded.diagnostics, []);
	assert.deepEqual(loaded.config, { enabled: false, mode: "cached", suppressClientTools: [] });
});

test("hosted search options load from config", async () => {
	const loaded = await load(
		writeConfig(
			JSON.stringify({
				filters: { allowedDomains: ["example.com", "docs.example.com"] },
				userLocation: { country: "US", region: "California", city: "Los Angeles", timezone: "America/Los_Angeles" },
				searchContextSize: "low",
			}),
		),
	);
	assert.deepEqual(loaded.diagnostics, []);
	assert.deepEqual(loaded.config, {
		...DEFAULT_CONFIG,
		filters: { allowedDomains: ["example.com", "docs.example.com"] },
		userLocation: { country: "US", region: "California", city: "Los Angeles", timezone: "America/Los_Angeles" },
		searchContextSize: "low",
	});
});

test("invalid fields fall back with diagnostics instead of disabling the extension", async () => {
	const loaded = await load(
		writeConfig(
			JSON.stringify({
				enabled: "yes",
				mode: "everything",
				suppressClientTools: ["ok", 7],
				filters: "not an object",
				userLocation: { city: 7 },
				searchContextSize: "huge",
			}),
		),
	);
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.equal(loaded.diagnostics.length, 6);
	assert.match(loaded.diagnostics[0] ?? "", /"enabled" must be a boolean$/);
	assert.match(loaded.diagnostics[1] ?? "", /"mode" must be one of cached, live, indexed$/);
	assert.match(loaded.diagnostics[2] ?? "", /"suppressClientTools" must be an array of strings$/);
	assert.match(loaded.diagnostics[3] ?? "", /"filters" must be an object$/);
	assert.match(loaded.diagnostics[4] ?? "", /"userLocation.city" must be a string$/);
	assert.match(loaded.diagnostics[5] ?? "", /"searchContextSize" must be one of low, medium, high$/);
});

test("invalid JSON and non-object configs report a diagnostic", async () => {
	const invalid = await load(writeConfig("{"));
	assert.equal(invalid.diagnostics.length, 1);
	assert.match(invalid.diagnostics[0] ?? "", /invalid JSON/);
	assert.deepEqual(invalid.config, DEFAULT_CONFIG);

	const array = await load(writeConfig("[]"));
	assert.equal(array.diagnostics.length, 1);
	assert.match(array.diagnostics[0] ?? "", /expected a JSON object/);
	assert.deepEqual(array.config, DEFAULT_CONFIG);
});

test("an unreadable config path reports a diagnostic", async () => {
	const loaded = await load(mkdtempSync(join(tmpdir(), "codex-web-search-dir-")));
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
