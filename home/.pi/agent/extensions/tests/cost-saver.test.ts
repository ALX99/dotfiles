import assert from "node:assert/strict";
import test from "node:test";

import { CostSaverController, type CostSaverFileSystem } from "../cost-saver.ts";

function makeFileSystem(initial: string): {
	readonly fs: CostSaverFileSystem;
	setContents(contents: string): void;
	readonly reads: () => number;
} {
	let contents = initial;
	let readCount = 0;
	return {
		fs: {
			async stat() {
				return { size: Buffer.byteLength(contents), isFile: () => true };
			},
			async readFile() {
				readCount += 1;
				return Buffer.from(contents);
			},
		},
		setContents(next: string) {
			contents = next;
		},
		reads: () => readCount,
	};
}

test("cost saver rejects blank paths instead of resolving the working directory", async () => {
	const files = makeFileSystem("contents");
	const controller = new CostSaverController(files.fs);

	const result = await controller.preflight({ toolCallId: "blank", cwd: "/workspace", path: "  " });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /must not be blank/);
	assert.equal(files.reads(), 0);
});

test("successful results reuse the call-specific preflight fingerprint", async () => {
	const files = makeFileSystem("first version");
	const controller = new CostSaverController(files.fs);
	const call = { toolCallId: "read-1", cwd: "/workspace", path: "file.txt" };

	assert.equal(await controller.preflight(call), undefined);
	assert.equal(files.reads(), 1);
	controller.rememberResult({ ...call, input: { path: "file.txt" }, isError: false });
	assert.equal(files.reads(), 1, "result does not hash the file a second time");

	const duplicate = await controller.preflight({ ...call, toolCallId: "read-2" });
	assert.equal(duplicate?.block, true);
});

test("a change between preflight and completion is not deduplicated as the old version", async () => {
	const files = makeFileSystem("before");
	const controller = new CostSaverController(files.fs);
	const firstCall = { toolCallId: "read-1", cwd: "/workspace", path: "file.txt" };

	assert.equal(await controller.preflight(firstCall), undefined);
	files.setContents("after");
	controller.rememberResult({ ...firstCall, input: { path: "file.txt" }, isError: false });

	const nextCall = await controller.preflight({ ...firstCall, toolCallId: "read-2" });
	assert.equal(nextCall, undefined, "the changed contents require another read");
});

test("a result cannot record another tool call's fingerprint", async () => {
	const files = makeFileSystem("first");
	const controller = new CostSaverController(files.fs);
	const firstCall = { toolCallId: "read-1", cwd: "/workspace", path: "file.txt" };

	await controller.preflight(firstCall);
	controller.rememberResult({
		toolCallId: "different-call",
		cwd: "/workspace",
		input: { path: "file.txt" },
		isError: false,
	});

	const repeated = await controller.preflight({ ...firstCall, toolCallId: "read-2" });
	assert.equal(repeated, undefined);
});
