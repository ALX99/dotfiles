import * as assert from "node:assert/strict";
import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
	supportsApplyPatchTransport,
	type SpawnApplyPatchProcess,
} from "../index.ts";
import {
	APPLY_PATCH_OPENAI_LARK_GRAMMAR,
	APPLY_PATCH_TOOL_DESCRIPTION,
	APPLY_PATCH_TOOL_GUIDELINES,
	APPLY_PATCH_TOOL_SNIPPET,
} from "../types.ts";

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

/** A model whose transport emits OpenAI custom tools with a Lark grammar, as Codex's freeform models do. */
function grammarModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return model({ compat: { supportsOpenAIGrammarTools: true }, ...overrides });
}

/** Resolves the Codex CLI the extension runs, or undefined when it is not installed. */
function resolveCodexBinary(): string | undefined {
	try {
		const resolved = execFileSync(process.platform === "win32" ? "where" : "which", ["codex"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n")[0];
		return resolved !== undefined && resolved.length > 0 && existsSync(resolved) ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/** Streams a file so a 200+ MB binary is never held in memory at once. */
async function fileContains(file: string, needle: string): Promise<boolean> {
	let carry = Buffer.alloc(0);
	for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
		const data = Buffer.concat([carry, chunk as Buffer]);
		if (data.includes(needle)) return true;
		carry = data.subarray(Math.max(0, data.length - needle.length + 1));
	}
	return false;
}

test("the tool definition matches Codex's freeform apply_patch spec", () => {
	const tool = createApplyPatchTool();
	assert.equal(tool.name, "apply_patch");
	assert.equal(tool.description, APPLY_PATCH_TOOL_DESCRIPTION);
	assert.equal(tool.promptSnippet, APPLY_PATCH_TOOL_SNIPPET);
	assert.deepEqual(tool.promptGuidelines, APPLY_PATCH_TOOL_GUIDELINES);
	assert.deepEqual(tool.constrainedSampling, {
		type: "grammar",
		variants: { openai_lark: APPLY_PATCH_OPENAI_LARK_GRAMMAR },
	});
	assert.ok(APPLY_PATCH_OPENAI_LARK_GRAMMAR.startsWith("start: begin_patch hunk+ end_patch\n"));
	assert.ok(APPLY_PATCH_OPENAI_LARK_GRAMMAR.endsWith("%import common.LF\n"));
});

test("the vendored grammar is the one the installed Codex CLI ships", async (t) => {
	const codex = resolveCodexBinary();
	if (codex === undefined) {
		t.skip("codex is not installed");
		return;
	}
	assert.equal(
		await fileContains(codex, APPLY_PATCH_OPENAI_LARK_GRAMMAR),
		true,
		"grammar drifted from the Codex binary",
	);
});

test("adapter spawns a fake executable directly with raw stdin and ctx.cwd", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "codex-apply-patch-process-"));
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

test("nonzero exit surfaces the engine diagnostic and exit status", async () => {
	await assert.rejects(runApplyPatchProcess(FAKE_EXECUTABLE, "FAIL", process.cwd(), undefined), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "upstream stderr\nupstream stdout\napply_patch exited with status 7");
		return true;
	});

	await assert.rejects(runApplyPatchProcess(FAKE_EXECUTABLE, "LARGE_FAILURE", process.cwd(), undefined), (error) => {
		assert.ok(error instanceof Error);
		assert.ok(error.message.length < MAX_CAPTURED_OUTPUT_BYTES * 2 + 1_000);
		assert.match(error.message, new RegExp(`stderr truncated: captured ${MAX_CAPTURED_OUTPUT_BYTES}`));
		assert.match(error.message, new RegExp(`stdout truncated: captured ${MAX_CAPTURED_OUTPUT_BYTES}`));
		assert.match(error.message, /apply_patch exited with status 9$/);
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

test("apply_patch transport support requires the model's grammar compat flag", () => {
	assert.equal(supportsApplyPatchTransport(undefined), false);
	assert.equal(supportsApplyPatchTransport({}), false);
	assert.equal(supportsApplyPatchTransport({ compat: null }), false);
	assert.equal(supportsApplyPatchTransport({ compat: {} }), false);
	assert.equal(supportsApplyPatchTransport({ compat: { supportsOpenAIGrammarTools: false } }), false);
	assert.equal(supportsApplyPatchTransport({ compat: { supportsOpenAIGrammarTools: true } }), true);
});

test("activation follows the transport's OpenAI grammar-tool support, not the model name", () => {
	const fixture = registerActivationFixture(["read", "edit", "write"]);
	assert.equal(fixture.registeredTool?.executionMode, "sequential");
	assert.equal(fixture.providerRegistered, false);
	fixture.start(model());
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
	// Codex selects the freeform tool from model metadata on any provider.
	fixture.select(grammarModel({ provider: "other-provider", id: "gpt-5.6-terra" }));
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	fixture.select(grammarModel({ provider: "openai-codex", id: "gpt-5.6-terra" }));
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	fixture.select(grammarModel({ id: "claude-opus" }));
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	// Without the flag Pi would send an ordinary JSON function tool, so keep the built-ins.
	fixture.select(model({ compat: { supportsOpenAIGrammarTools: false } }));
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
	fixture.select(model({ id: "claude-opus" }));
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
	fixture.select(model());
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
});

test("activation is idempotent and restores only built-ins it suppressed", () => {
	const fixture = registerActivationFixture(["read", "edit"]);
	const codex = grammarModel();

	fixture.start(codex);
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	assert.deepEqual(fixture.setCalls, [["read", "apply_patch"]]);

	fixture.start(codex);
	fixture.select(codex);
	assert.deepEqual(fixture.setCalls, [["read", "apply_patch"]], "repeated activation must be a no-op");

	fixture.select(model());
	assert.deepEqual(fixture.active, ["read", "edit"], "write was never suppressed and must not be added");
	assert.deepEqual(fixture.setCalls, [
		["read", "apply_patch"],
		["read", "edit"],
	]);

	fixture.select(model());
	assert.equal(fixture.setCalls.length, 2, "repeated deactivation must be a no-op");
});

test("activation restores suppressed built-ins in their original order", () => {
	const fixture = registerActivationFixture(["read", "write", "edit"]);

	fixture.start(grammarModel());
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);

	fixture.select(model());
	assert.deepEqual(fixture.active, ["read", "write", "edit"]);
});

test("startup without grammar support removes only a pre-existing apply_patch activation", () => {
	const fixture = registerActivationFixture(["read", "apply_patch"]);
	fixture.start(model());
	assert.deepEqual(fixture.active, ["read"]);
	assert.deepEqual(fixture.setCalls, [["read"]]);
});
