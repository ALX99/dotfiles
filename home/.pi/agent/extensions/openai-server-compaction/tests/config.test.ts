import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Effect } from "effect";

import { DEFAULT_CONFIG, loadConfig, projectConfigPath } from "../config.ts";

const workspace = mkdtempSync(join(tmpdir(), "openai-server-compaction-config-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

function writeProjectConfig(contents: string): string {
	const cwd = mkdtempSync(join(workspace, "project-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "openai-server-compaction.json"), contents);
	return cwd;
}

test("a session without a config file gets the defaults", async () => {
	const loaded = await Effect.runPromise(loadConfig(workspace, {}));
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.deepEqual(loaded.diagnostics, []);
});

test("the project file is read from the session's working directory", async () => {
	const cwd = writeProjectConfig(JSON.stringify({ enabled: false }));
	assert.equal(projectConfigPath(cwd), join(cwd, ".pi", "openai-server-compaction.json"));
	const loaded = await Effect.runPromise(loadConfig(cwd, {}));
	assert.equal(loaded.config.enabled, false);
});

test("the environment wins over the file and accepts shell spellings", async () => {
	const cwd = writeProjectConfig(JSON.stringify({ enabled: true }));
	const loaded = await Effect.runPromise(loadConfig(cwd, { PI_OPENAI_SERVER_COMPACTION_ENABLED: "off" }));
	assert.equal(loaded.config.enabled, false);
});

test("an unusable value falls back to its default and is reported", async () => {
	const cwd = writeProjectConfig(JSON.stringify({ enabled: "maybe" }));
	const loaded = await Effect.runPromise(loadConfig(cwd, {}));
	assert.equal(loaded.config.enabled, DEFAULT_CONFIG.enabled);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0] ?? "", /"enabled" must be a boolean/);

	const numeric = await Effect.runPromise(loadConfig(writeProjectConfig(JSON.stringify({ enabled: 0 })), {}));
	assert.equal(numeric.config.enabled, false, "a shell passes 0 and 1");
});

test("a file that is not a JSON object is reported, not thrown", async () => {
	const cwd = writeProjectConfig("[1, 2, 3]");
	const loaded = await Effect.runPromise(loadConfig(cwd, {}));
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
	assert.match(loaded.diagnostics[0] ?? "", /expected a JSON object/);

	const broken = writeProjectConfig("{ not json");
	const brokenLoaded = await Effect.runPromise(loadConfig(broken, {}));
	assert.deepEqual(brokenLoaded.config, DEFAULT_CONFIG);
	assert.match(brokenLoaded.diagnostics[0] ?? "", /invalid JSON/);
});
