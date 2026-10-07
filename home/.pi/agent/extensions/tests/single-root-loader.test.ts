import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("the package entry point loads its core features through Pi's extension loader", async (t) => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	const extensions = manifest.pi?.extensions;
	assert.deepEqual(extensions, ["./index.ts"]);
	if (extensions === undefined) throw new Error("missing Pi extension entry point");

	const root = await mkdtemp(join(tmpdir(), "personal-extension-loader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const packageRoot = new URL("../", import.meta.url);
	const entry = fileURLToPath(new URL(extensions[0]!, packageRoot));
	const loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0]!;
	for (const event of ["before_provider_request", "tool_call", "agent_settled"]) {
		assert.ok(extension.handlers.has(event), `missing ${event} handler`);
	}
	for (const command of ["skills", "tasks"]) {
		assert.ok(extension.commands.has(command), `missing /${command} command`);
	}
	for (const tool of ["create_tasks", "finish_task", "spawn_agent"]) {
		assert.ok(extension.tools.has(tool), `missing ${tool} tool`);
	}
});
