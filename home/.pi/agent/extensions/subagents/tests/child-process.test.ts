import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
	parseChildExecutionContext,
	serializeChildExecutionContext,
	writeTempPrompt,
	type ChildExecutionContext,
} from "../child-process.ts";

const context: ChildExecutionContext = {
	agent: "worker",
	profile: "balanced",
	parentSessionId: "parent-session-1",
};

test("child execution context serialization round-trips through the strict parser", () => {
	assert.deepEqual(parseChildExecutionContext(serializeChildExecutionContext(context)), context);
	assert.throws(() => serializeChildExecutionContext({ ...context, depth: 1 } as ChildExecutionContext));
});

test("temporary role prompts preserve content in a private sanitized file", async (t) => {
	const prompt = await writeTempPrompt("worker / unsafe", "Role instructions\n");
	t.after(() => fs.rm(prompt.dir, { recursive: true, force: true }));

	assert.equal(path.basename(prompt.path), "worker_unsafe.md");
	assert.equal(await fs.readFile(prompt.path, "utf8"), "Role instructions\n");
	assert.equal((await fs.stat(prompt.path)).mode & 0o777, 0o600);
});
