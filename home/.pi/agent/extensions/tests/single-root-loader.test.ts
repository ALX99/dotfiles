import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi loads all personal features through the single package entry point", async (t) => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);

	const root = await mkdtemp(join(tmpdir(), "personal-extension-loader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	const loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);

	const [extension] = loaded.extensions;
	assert.ok(extension);
	for (const event of [
		"before_provider_request",
		"session_before_compact",
		"tool_call",
		"agent_settled",
		"before_agent_start",
	]) {
		assert.ok(extension.handlers.has(event), `missing ${event} handler`);
	}
	assert.ok((extension.handlers.get("before_provider_request")?.length ?? 0) > 0);
	for (const command of ["codex-web-search", "skills", "tasks", "systemprompt"]) {
		assert.ok(extension.commands.has(command), `missing /${command} command`);
	}
	for (const tool of ["apply_patch", "web_search_log", "create_tasks", "finish_task"]) {
		assert.ok(extension.tools.has(tool), `missing ${tool} tool`);
	}
});
