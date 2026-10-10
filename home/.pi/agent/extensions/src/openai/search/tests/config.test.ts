import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runPromise } from "../../../support/effect-runtime.ts";
import { codexConfigPath, configPath, DEFAULT_CONFIG, loadConfig } from "../config.ts";

/** Loading reads the filesystem, so every case awaits the extension runtime. */
function load(path: string, codexPath = join(tmpdir(), "codex-web-search-no-codex-config.toml")) {
	return runPromise(loadConfig(path, codexPath));
}

function writeConfig(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-web-search-"));
	const path = join(dir, "config.json");
	writeFileSync(path, contents);
	return path;
}

function writeCodexConfig(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-config-"));
	const path = join(dir, "config.toml");
	writeFileSync(path, contents);
	return path;
}

test("a missing config file yields defaults without diagnostics", async () => {
	const loaded = await load(join(tmpdir(), "codex-web-search-missing", "config.json"));
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.deepEqual(loaded.diagnostics, []);
});

test("Codex web_search mode is inherited when Pi has no mode override", async () => {
	const loaded = await load(
		join(tmpdir(), "codex-web-search-missing", "config.json"),
		writeCodexConfig('web_search = "indexed"\n\n[features]\njs_repl = false\n'),
	);
	assert.equal(loaded.config.mode, "indexed");
	assert.deepEqual(loaded.diagnostics, []);
});

test("a Pi mode override is restricted to the Codex mode", async () => {
	const cases = [
		{ codex: "indexed", pi: "live", expected: "indexed" },
		{ codex: "live", pi: "cached", expected: "cached" },
		{ codex: "cached", pi: "indexed", expected: "cached" },
		{ codex: "disabled", pi: "live", expected: "disabled" },
	] as const;

	for (const { codex, pi, expected } of cases) {
		const loaded = await load(writeConfig(JSON.stringify({ mode: pi })), writeCodexConfig(`web_search = "${codex}"\n`));
		assert.equal(loaded.config.mode, expected, `Codex ${codex}, Pi ${pi}`);
		assert.deepEqual(loaded.diagnostics, []);
	}
});

test("a Pi mode can enable search only when Codex has no mode restriction", async () => {
	const loaded = await load(writeConfig(JSON.stringify({ mode: "live" })), writeCodexConfig('model = "gpt-6.1-sol"\n'));
	assert.equal(loaded.config.mode, "live");
	assert.deepEqual(loaded.diagnostics, []);
});

test("an invalid Codex search mode fails closed even with a Pi override", async () => {
	const loaded = await load(
		writeConfig(JSON.stringify({ mode: "live" })),
		writeCodexConfig('web_search = "unrestricted"\n'),
	);
	assert.equal(loaded.config.mode, "disabled");
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0] ?? "", /"web_search" must be one of disabled, cached, indexed, live/);
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
	assert.match(loaded.diagnostics[1] ?? "", /"mode" must be one of disabled, cached, indexed, live$/);
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
	assert.equal(codexConfigPath({ CODEX_HOME: "/tmp/codex" }), "/tmp/codex/config.toml");
	assert.equal(codexConfigPath({ CODEX_HOME: "  " }), join(process.env.HOME ?? "", ".codex", "config.toml"));
});
