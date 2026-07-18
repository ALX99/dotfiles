import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createApplyPatchTool,
	MAX_APPLY_PATCH_BYTES,
	registerCodexCompat,
	type FileMutationQueue,
	withSortedFileMutationLocks,
} from "../index.ts";
import { PatchEngineError } from "../engine.ts";

const patch = "*** Begin Patch\n*** Add File: z.txt\n+z\n*** Add File: a.txt\n+a\n*** End Patch\n";

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

test("apply_patch preflights, locks sorted paths, and applies without confirmation", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "codex-compat-tool-"));
	try {
		const locks: string[] = [];
		const queue: FileMutationQueue = async (filePath, run) => {
			locks.push(filePath);
			return run();
		};
		const result = await createApplyPatchTool({ mutationQueue: queue }).execute(
			"tool_1", { patch }, undefined, undefined,
			{ cwd: root, hasUI: false } as ExtensionContext,
		);
		const canonicalRoot = await realpath(root);
		assert.deepEqual(locks, [path.join(canonicalRoot, "a.txt"), path.join(canonicalRoot, "z.txt")]);
		assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "a\n");
		assert.equal(await readFile(path.join(root, "z.txt"), "utf8"), "z\n");
		assert.match(result.content[0].type === "text" ? result.content[0].text : "", /Applied patch successfully/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("canonical lock aliases are rejected before queue acquisition", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "codex-compat-lock-"));
	try {
		const target = path.join(root, "target.txt");
		const alias = path.join(root, "alias.txt");
		await writeFile(target, "content\n");
		await symlink(target, alias);
		let queueCalls = 0;
		await assert.rejects(
			withSortedFileMutationLocks(
				[target, alias],
				async () => undefined,
				async (_filePath, run) => {
					queueCalls++;
					return run();
				},
			),
			(error) => error instanceof PatchEngineError && error.code === "path_conflict",
		);
		assert.equal(queueCalls, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("oversized patches are rejected before locking or preflight", async () => {
	let queueCalls = 0;
	const tool = createApplyPatchTool({
		mutationQueue: async (_filePath, run) => {
			queueCalls++;
			return run();
		},
	});
	await assert.rejects(
		tool.execute("tool_oversized", { patch: "x".repeat(MAX_APPLY_PATCH_BYTES + 1) }, undefined, undefined,
			{ cwd: process.cwd(), hasUI: false } as ExtensionContext),
		(error) => error instanceof RangeError,
	);
	assert.equal(queueCalls, 0);
});

function registerActivationFixture(initialActive: string[]) {
	let active = [...initialActive];
	let registeredTool: ToolDefinition | undefined;
	let providerRegistered = false;
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const pi = {
		registerTool(tool: ToolDefinition) { registeredTool = tool; },
		registerProvider() { providerRegistered = true; },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active = [...names]; },
		on(name: string, handler: (...args: never[]) => unknown) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	registerCodexCompat(pi);
	const sessionStart = handlers.get("session_start") as unknown as (_event: object, ctx: { model: Model<Api> }) => void;
	const modelSelect = handlers.get("model_select") as unknown as (event: { model: Model<Api> }) => void;
	return {
		get active() { return [...active]; },
		registeredTool,
		providerRegistered,
		start(selectedModel: Model<Api>) { sessionStart({}, { model: selectedModel }); },
		select(selectedModel: Model<Api>) { modelSelect({ model: selectedModel }); },
	};
}

test("activation is scoped to openai-codex and no longer registers a direct API provider", () => {
	const fixture = registerActivationFixture(["read", "edit", "write"]);
	assert.equal(fixture.registeredTool?.executionMode, "sequential");
	assert.equal(fixture.providerRegistered, false);
	fixture.start(model());
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
	fixture.select(model({ provider: "openai-codex", id: "any-codex-model" }));
	assert.deepEqual(fixture.active, ["read", "apply_patch"]);
	fixture.select(model());
	assert.deepEqual(fixture.active, ["read", "edit", "write"]);
});
