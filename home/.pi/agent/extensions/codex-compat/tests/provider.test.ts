import * as assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createApplyPatchTool,
	MAX_CAPTURED_OUTPUT_BYTES,
	registerCodexCompat,
	runApplyPatchProcess,
	type SpawnApplyPatchProcess,
} from "../index.ts";
import { APPLY_PATCH_TOOL_DESCRIPTION } from "../types.ts";

const FAKE_EXECUTABLE = fileURLToPath(new URL("./fake-apply-patch.mjs", import.meta.url));

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "fixture",
		name: "fixture",
		api: "openai-codex-responses",
		provider: "other-provider",
		baseUrl: "https://api.openai.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		...overrides,
	};
}

function toolText(result: Awaited<ReturnType<ReturnType<typeof createApplyPatchTool>["execute"]>>): string {
	const content = result.content.find((item) => item.type === "text");
	assert.ok(content && content.type === "text");
	return content.text;
}

test("adapter spawns a fake executable directly with raw stdin and ctx.cwd", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "codex-compat-process-"));
	try {
		const patch = "*** Begin Patch\n*** Add File: test.txt\n+raw\n*** End Patch\n";
		const result = await createApplyPatchTool({ executable: FAKE_EXECUTABLE }).execute(
			"tool_1",
			{ patch },
			undefined,
			undefined,
			{ cwd } as ExtensionContext,
		);
		const upstream = toolText(result);
		assert.equal(upstream.endsWith("\n"), false, "successful stdout must not be trimmed or rewritten");
		assert.deepEqual(JSON.parse(upstream), {
			input: patch,
			cwd: await realpath(cwd),
			args: [],
		});
		assert.deepEqual(result.details, { exitCode: 0 });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("adapter smoke-tests an installed Codex in apply_patch multicall mode", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "codex-compat-upstream-"));
	try {
		let result;
		try {
			result = await createApplyPatchTool().execute(
				"tool_upstream",
				{ patch: "*** Begin Patch\n*** Add File: smoke.txt\n+from upstream\n*** End Patch\n" },
				undefined,
				undefined,
				{ cwd } as ExtensionContext,
			);
		} catch (error) {
			if (error instanceof Error && /spawn codex ENOENT/.test(error.message)) {
				t.skip("Codex is not installed on PATH");
				return;
			}
			throw error;
		}
		assert.equal(toolText(result), "Success. Updated the following files:\nA smoke.txt\n");
		assert.equal(await readFile(path.join(cwd, "smoke.txt"), "utf8"), "from upstream\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("nonzero exit surfaces bounded upstream stdout and stderr", async () => {
	await assert.rejects(runApplyPatchProcess(FAKE_EXECUTABLE, "FAIL", process.cwd(), undefined), (error) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /apply_patch exited with status 7/);
		assert.match(error.message, /stdout:\nupstream stdout\n/);
		assert.match(error.message, /stderr:\nupstream stderr\n/);
		return true;
	});

	await assert.rejects(runApplyPatchProcess(FAKE_EXECUTABLE, "LARGE_FAILURE", process.cwd(), undefined), (error) => {
		assert.ok(error instanceof Error);
		assert.ok(error.message.length < MAX_CAPTURED_OUTPUT_BYTES * 2 + 1_000);
		assert.match(error.message, new RegExp(`stdout truncated: captured ${MAX_CAPTURED_OUTPUT_BYTES}`));
		assert.match(error.message, new RegExp(`stderr truncated: captured ${MAX_CAPTURED_OUTPUT_BYTES}`));
		return true;
	});
});

test("cancellation terminates the direct child", async () => {
	const controller = new AbortController();
	const run = runApplyPatchProcess(FAKE_EXECUTABLE, "HANG", process.cwd(), controller.signal);
	setTimeout(() => controller.abort(), 100).unref();
	await assert.rejects(run, /apply_patch was cancelled/);
});

test("a pre-aborted signal does not spawn a child", async () => {
	const controller = new AbortController();
	controller.abort();
	let spawnCount = 0;
	const spawnProcess: SpawnApplyPatchProcess = () => {
		spawnCount++;
		throw new Error("must not spawn");
	};

	await assert.rejects(
		runApplyPatchProcess("/fake/apply_patch", "raw patch", "/workspace", controller.signal, spawnProcess),
		/apply_patch was cancelled before it started/,
	);
	assert.equal(spawnCount, 0);
});

test("cancellation escalates an uncooperative child from SIGTERM to SIGKILL in order", async () => {
	const signals: NodeJS.Signals[] = [];
	const spawnProcess: SpawnApplyPatchProcess = () => {
		const child = new EventEmitter() as EventEmitter & {
			stdin: Writable;
			stdout: PassThrough;
			stderr: PassThrough;
			exitCode: number | null;
			signalCode: NodeJS.Signals | null;
			pid: number;
			kill(signal: NodeJS.Signals): boolean;
		};
		child.stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.exitCode = null;
		child.signalCode = null;
		child.pid = 42;
		child.kill = (signal) => {
			signals.push(signal);
			if (signal === "SIGKILL") {
				child.signalCode = signal;
				queueMicrotask(() => {
					child.stdout.end();
					child.stderr.end();
					child.emit("close", null, signal);
				});
			}
			return true;
		};
		return child as unknown as ChildProcessWithoutNullStreams;
	};
	const controller = new AbortController();
	const run = runApplyPatchProcess("/fake/apply_patch", "raw patch", "/workspace", controller.signal, spawnProcess);
	controller.abort();

	await assert.rejects(run, /apply_patch was cancelled/);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("stdin errors are observed and terminate the child without hiding captured output", async () => {
	const spawnProcess: SpawnApplyPatchProcess = (executable, args, options) => {
		assert.equal(executable, "/fake/apply_patch");
		assert.deepEqual(args, []);
		assert.equal(options.argv0, "apply_patch");
		assert.equal(options.shell, false);
		assert.equal(options.cwd, "/workspace");

		const child = new EventEmitter() as EventEmitter & {
			stdin: Writable;
			stdout: PassThrough;
			stderr: PassThrough;
			exitCode: number | null;
			signalCode: NodeJS.Signals | null;
			pid: undefined;
			kill(signal: NodeJS.Signals): boolean;
		};
		child.stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error("injected stdin failure"));
			},
		});
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.exitCode = null;
		child.signalCode = null;
		child.pid = undefined;
		child.kill = (signal) => {
			child.signalCode = signal;
			queueMicrotask(() => {
				child.stdout.end();
				child.stderr.end();
				child.emit("close", null, signal);
			});
			return true;
		};
		child.stdout.write("partial stdout\n");
		child.stderr.write("partial stderr\n");
		return child as unknown as ChildProcessWithoutNullStreams;
	};

	await assert.rejects(
		runApplyPatchProcess("/fake/apply_patch", "raw patch", "/workspace", undefined, spawnProcess),
		(error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Could not send the patch.*injected stdin failure/);
			assert.match(error.message, /partial stdout/);
			assert.match(error.message, /partial stderr/);
			return true;
		},
	);
});

test("a child spawn error is observed through the close lifecycle", async () => {
	await assert.rejects(
		runApplyPatchProcess(
			path.join(tmpdir(), `missing-apply-patch-${process.pid}`),
			"raw patch",
			process.cwd(),
			undefined,
		),
		/Could not run apply_patch: spawn .* ENOENT/,
	);
});

function registerActivationFixture(initialActive: string[]) {
	let active = [...initialActive];
	let registeredTool: ToolDefinition | undefined;
	let providerRegistered = false;
	const setCalls: string[][] = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			registeredTool = tool;
		},
		registerProvider() {
			providerRegistered = true;
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
			setCalls.push([...names]);
		},
		on(name: string, handler: (...args: never[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	registerCodexCompat(pi, { executable: FAKE_EXECUTABLE });
	const sessionStart = handlers.get("session_start") as unknown as (_event: object, ctx: { model: Model<Api> }) => void;
	const modelSelect = handlers.get("model_select") as unknown as (event: { model: Model<Api> }) => void;
	return {
		get active() {
			return [...active];
		},
		get setCalls() {
			return setCalls.map((names) => [...names]);
		},
		registeredTool,
		providerRegistered,
		start(selectedModel: Model<Api>) {
			sessionStart({}, { model: selectedModel });
		},
		select(selectedModel: Model<Api>) {
			modelSelect({ model: selectedModel });
		},
	};
}

test("activation remains scoped to openai-codex with the exact upstream description", () => {
	const fixture = registerActivationFixture(["read", "edit", "write"]);
	assert.equal(
		APPLY_PATCH_TOOL_DESCRIPTION,
		"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
	);
	assert.equal(fixture.registeredTool?.executionMode, "sequential");
	assert.equal(fixture.registeredTool?.description, APPLY_PATCH_TOOL_DESCRIPTION);
	assert.equal(fixture.providerRegistered, false);
	fixture.start(model());
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
	fixture.select(model({ provider: "openai-codex", id: "any-codex-model" }));
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	fixture.select(model());
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
});

test("activation is idempotent and restores only built-ins it suppressed", () => {
	const fixture = registerActivationFixture(["read", "edit"]);
	const codex = model({ provider: "openai-codex" });

	fixture.start(codex);
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	assert.deepEqual(fixture.setCalls, [["read", "apply_patch"]]);

	fixture.start(codex);
	fixture.select(codex);
	assert.deepEqual(fixture.setCalls, [["read", "apply_patch"]], "repeated Codex selection must be a no-op");

	fixture.select(model());
	assert.deepEqual(fixture.active, ["read", "edit"], "write was never suppressed and must not be added");
	assert.deepEqual(fixture.setCalls, [
		["read", "apply_patch"],
		["read", "edit"],
	]);

	fixture.select(model());
	assert.equal(fixture.setCalls.length, 2, "repeated non-Codex selection must be a no-op");
});

test("non-Codex startup removes only a pre-existing apply_patch activation", () => {
	const fixture = registerActivationFixture(["read", "apply_patch"]);
	fixture.start(model());
	assert.deepEqual(fixture.active, ["read"]);
	assert.deepEqual(fixture.setCalls, [["read"]]);
});
