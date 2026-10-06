import * as assert from "node:assert/strict";
import { test } from "node:test";
import { observeToolFiles } from "../tool-observations.ts";

const cwd = "/workspace/project";

test("read paths are attempted targets but not mutations", () => {
	assert.deepEqual(observeToolFiles("read", { path: "src/./file.ts" }, cwd), {
		attemptedPaths: ["/workspace/project/src/file.ts"],
		mutationPaths: [],
	});
});

test("edit and write paths are both attempted and possible mutations", () => {
	assert.deepEqual(observeToolFiles("edit", { path: "@src/file.ts" }, cwd), {
		attemptedPaths: ["/workspace/project/src/file.ts"],
		mutationPaths: ["/workspace/project/src/file.ts"],
	});
	assert.deepEqual(observeToolFiles("write", { path: "/outside/file.ts" }, cwd), {
		attemptedPaths: ["/outside/file.ts"],
		mutationPaths: ["/outside/file.ts"],
	});
});

test("patch additions, deletions, edits, and moves share deduplicated source and destination paths", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: src/old.ts",
		"*** Move to: src/new.ts",
		"*** Add File: src/added.ts",
		"*** Delete File: src/deleted.ts",
		"*** Update File: src/new.ts",
		"*** End Patch",
	].join("\r\n");

	assert.deepEqual(observeToolFiles("apply_patch", { patch }, cwd), {
		attemptedPaths: [
			"/workspace/project/src/old.ts",
			"/workspace/project/src/new.ts",
			"/workspace/project/src/added.ts",
			"/workspace/project/src/deleted.ts",
		],
		mutationPaths: [
			"/workspace/project/src/old.ts",
			"/workspace/project/src/new.ts",
			"/workspace/project/src/added.ts",
			"/workspace/project/src/deleted.ts",
		],
	});
});

test("invalid inputs and unrelated tools do not report file targets", () => {
	assert.deepEqual(observeToolFiles("edit", { path: "" }, cwd), {
		attemptedPaths: [],
		mutationPaths: [],
	});
	assert.deepEqual(observeToolFiles("bash", { command: "echo hi > file" }, cwd), {
		attemptedPaths: [],
		mutationPaths: [],
	});
});
