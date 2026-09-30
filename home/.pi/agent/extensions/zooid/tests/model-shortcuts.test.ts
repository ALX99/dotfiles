import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ScopedModel,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import modelShortcuts, { MODEL_SHORTCUTS, resolveShortcutModel } from "../model-shortcuts.ts";

const luna = MODEL_SHORTCUTS[0];
const free = MODEL_SHORTCUTS.find((shortcut) => shortcut.command === "free");
assert.ok(free, "expected a /free shortcut");

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

function context(options: {
	scoped?: ScopedModel[];
	catalogue?: Model<any>[];
}): Pick<ExtensionContext, "modelRegistry" | "scopedModels"> {
	const catalogue = options.catalogue ?? [];
	return {
		scopedModels: options.scoped ?? [],
		modelRegistry: {
			find: (provider: string, id: string) => catalogue.find((m) => m.provider === provider && m.id === id),
		},
	} as unknown as Pick<ExtensionContext, "modelRegistry" | "scopedModels">;
}

test("resolves a shortcut from the session scope and its pattern thinking level", () => {
	const scoped = model(luna.provider, luna.model);
	const resolved = resolveShortcutModel(luna, context({ scoped: [{ model: scoped, thinkingLevel: "low" }] }));

	assert.deepEqual(resolved, { model: scoped, thinkingLevel: "low" });
});

test("resolves the shortcut's own thinking level when the scope sets none", () => {
	const scoped = model(luna.provider, luna.model);
	const resolved = resolveShortcutModel(luna, context({ scoped: [{ model: scoped }] }));

	assert.equal(resolved?.thinkingLevel, luna.thinkingLevel);
});

test("falls back to the full catalogue for a model outside the scope", () => {
	const catalogued = model(free.provider, free.model);
	const resolved = resolveShortcutModel(free, context({ scoped: [], catalogue: [catalogued] }));

	assert.deepEqual(resolved, { model: catalogued, thinkingLevel: free.thinkingLevel });
});

test("prefers the scoped model over an identically referenced catalogue entry", () => {
	const scoped = model(free.provider, free.model);
	const other = { ...model(free.provider, free.model), name: "from catalogue" } as Model<any>;
	const resolved = resolveShortcutModel(free, context({ scoped: [{ model: scoped }], catalogue: [other] }));

	assert.equal(resolved?.model, scoped);
});

test("reports no resolution when the model is in neither the scope nor the catalogue", () => {
	assert.equal(resolveShortcutModel(free, context({ scoped: [], catalogue: [model("other", "x")] })), undefined);
});

/**
 * A session that is busy (streaming, compacting, or summarizing a branch) and only
 * settles when the harness says so, mirroring AgentSession.isIdle and the idle
 * promise that waitForIdle resolves.
 */
function createHarness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const modelChanges: string[] = [];
	const thinkingLevels: string[] = [];
	const idleWaiters: Array<() => void> = [];
	let idle = true;
	const catalogue = MODEL_SHORTCUTS.map((shortcut) => model(shortcut.provider, shortcut.model));

	const pi = {
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, handler);
		},
		async setModel(selected: Model<any>) {
			modelChanges.push(`${selected.provider}/${selected.id}`);
			return true;
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel: (level: string) => thinkingLevels.push(level),
	} as unknown as ExtensionAPI;

	const ctx = {
		isIdle: () => idle,
		hasUI: true,
		waitForIdle: () =>
			new Promise<void>((resolve) => {
				if (idle) resolve();
				else idleWaiters.push(resolve);
			}),
		scopedModels: [],
		modelRegistry: {
			find: (provider: string, id: string) =>
				catalogue.find((candidate) => candidate.provider === provider && candidate.id === id),
		},
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push(type === undefined ? { message } : { message, type }),
		},
	} as unknown as ExtensionCommandContext;

	modelShortcuts(pi);

	return {
		notifications,
		modelChanges,
		thinkingLevels,
		beginWork() {
			idle = false;
		},
		/** Compaction or branch summarization finishing: no agent_settled follows. */
		async endWork() {
			idle = true;
			for (const resolve of idleWaiters.splice(0)) resolve();
			await Promise.resolve();
		},
		/** An agent run ending, which is what fires agent_settled in Pi. */
		async settleAgent() {
			idle = true;
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
			for (const resolve of idleWaiters.splice(0)) resolve();
			await Promise.resolve();
		},
		async runCommand(name: string) {
			await commands.get(name)?.handler("", ctx);
		},
		async emit(name: string) {
			await handlers.get(name)?.({ type: name }, ctx);
		},
	};
}

test("switches immediately when the session is idle", async () => {
	const harness = createHarness();

	await harness.runCommand("luna");

	assert.deepEqual(harness.modelChanges, ["openai/gpt-6-luna"]);
	assert.deepEqual(harness.thinkingLevels, [luna.thinkingLevel]);
});

test("applies a shortcut queued during compaction once the session goes idle", async () => {
	const harness = createHarness();
	harness.beginWork();

	await harness.runCommand("luna");
	assert.deepEqual(harness.modelChanges, [], "must not switch while compaction is running");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Queued gpt-6-luna/u);

	await harness.endWork();

	assert.deepEqual(harness.modelChanges, ["openai/gpt-6-luna"]);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Switched to openai\/gpt-6-luna/u);
});

test("applies a shortcut queued during a turn when the agent settles", async () => {
	const harness = createHarness();
	harness.beginWork();

	await harness.runCommand("sol");
	assert.deepEqual(harness.modelChanges, []);

	await harness.settleAgent();

	assert.deepEqual(harness.modelChanges, ["openai/gpt-6.1-sol"]);
});

test("applies only the latest shortcut when several are queued", async () => {
	const harness = createHarness();
	harness.beginWork();

	await harness.runCommand("sol");
	await harness.runCommand("free");
	await harness.endWork();

	assert.deepEqual(harness.modelChanges, [`${free.provider}/${free.model}`]);
});

test("drops a queued shortcut when the session restarts", async () => {
	const harness = createHarness();
	harness.beginWork();

	await harness.runCommand("astra");
	await harness.emit("session_start");
	await harness.endWork();

	assert.deepEqual(harness.modelChanges, []);
});
