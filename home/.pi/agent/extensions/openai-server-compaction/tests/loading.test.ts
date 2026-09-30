import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("compaction loads through Pi's extension loader and registers its handlers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "compaction-loading-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

	const loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0]!.handlers.keys()], ["session_before_compact", "before_provider_request"]);
});
