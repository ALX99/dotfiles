import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("harness learning loads offline without starting work or writing state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harness-learning-loading-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

	const loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0]!;
	assert.deepEqual([...extension.tools.keys()], ["harness_evidence", "harness_propose"]);
	assert.deepEqual([...extension.commands.keys()], ["harness"]);
	assert.deepEqual(
		[...extension.handlers.keys()],
		[
			"session_start",
			"session_tree",
			"session_shutdown",
			"model_select",
			"before_agent_start",
			"context",
			"before_provider_request",
		],
	);
	assert.deepEqual(await readdir(root), []);
});
