import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import modelShortcuts, { MODEL_SHORTCUTS } from "../model-shortcuts.ts";

interface Shortcut {
	handler(ctx: {
		isIdle?: () => boolean;
		modelRegistry: { find(provider: string, model: string): unknown };
		scopedModels: Array<{ model: { provider: string; id: string }; thinkingLevel?: "medium" | "high" | "max" }>;
		hasUI: boolean;
		ui: { notify(message: string, level: "warning" | "info"): void };
	}): Promise<void>;
}

function registerShortcuts(
	setModel: (model: unknown) => Promise<boolean>,
	setThinkingLevel: (level: "medium" | "high" | "max") => void = () => {},
	getThinkingLevel: () => string = () => "max",
	handlers = new Map<string, () => Promise<void> | void>(),
): Map<string, Shortcut> {
	const shortcuts = new Map<string, Shortcut>();
	modelShortcuts({
		on(event: string, handler: () => Promise<void> | void) {
			handlers.set(event, handler);
		},
		registerShortcut(shortcut: string, definition: unknown) {
			const registered = definition as Shortcut;
			shortcuts.set(shortcut, {
				handler: (ctx) => registered.handler({ isIdle: () => true, ...ctx } as Parameters<Shortcut["handler"]>[0]),
			});
		},
		setModel,
		setThinkingLevel,
		getThinkingLevel,
	} as unknown as ExtensionAPI);
	return shortcuts;
}

test("registered shortcut switches to its configured model and notifies the user", async () => {
	const selected = { id: "selected" };
	const setModels: unknown[] = [];
	const notifications: Array<{ level: string; message: string }> = [];
	const findCalls: Array<[string, string]> = [];
	const shortcuts = registerShortcuts(async (model) => {
		setModels.push(model);
		return true;
	});

	assert.equal(shortcuts.size, MODEL_SHORTCUTS.length);
	const configured = MODEL_SHORTCUTS[0]!;
	const shortcut = shortcuts.get(configured.shortcut);
	assert.ok(shortcut);
	await shortcut.handler({
		modelRegistry: {
			find: (provider, model) => {
				findCalls.push([provider, model]);
				return selected;
			},
		},
		scopedModels: [],
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});

	assert.deepEqual(findCalls, [[configured.provider, configured.model]]);
	assert.deepEqual(setModels, [selected]);
	assert.deepEqual(
		notifications.map(({ level }) => level),
		["info"],
	);
	assert.match(notifications[0]!.message, /max thinking/u);
});

test("registered shortcut reports unavailable models without attempting a switch", async () => {
	let setModelCalls = 0;
	const notifications: Array<{ level: string; message: string }> = [];
	const shortcut = registerShortcuts(async () => {
		setModelCalls += 1;
		return true;
	}).get("alt+1");

	assert.ok(shortcut);
	await shortcut.handler({
		modelRegistry: { find: () => undefined },
		scopedModels: [],
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});

	assert.equal(setModelCalls, 0);
	assert.deepEqual(
		notifications.map(({ level }) => level),
		["warning"],
	);
});

test("registered shortcut reports authentication failures after finding a model", async () => {
	const notifications: Array<{ level: string; message: string }> = [];
	const shortcut = registerShortcuts(async () => false).get("alt+1");

	assert.ok(shortcut);
	await shortcut.handler({
		modelRegistry: { find: () => ({ id: "selected" }) },
		scopedModels: [],
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});

	assert.deepEqual(
		notifications.map(({ level }) => level),
		["warning"],
	);
});

test("registered shortcut selects only matching scoped models and applies their thinking pin", async () => {
	const selected = { provider: "openai-codex", id: "gpt-5.6-luna" };
	const setModels: unknown[] = [];
	const thinkingLevels: string[] = [];
	const shortcut = registerShortcuts(
		async (model) => {
			setModels.push(model);
			return true;
		},
		(level) => thinkingLevels.push(level),
	).get("alt+1");

	assert.ok(shortcut);
	await shortcut.handler({
		modelRegistry: { find: () => assert.fail("catalogue lookup must not run when models are scoped") },
		scopedModels: [{ model: selected, thinkingLevel: "high" }],
		hasUI: false,
		ui: { notify: () => {} },
	});

	assert.deepEqual(setModels, [selected]);
	assert.deepEqual(thinkingLevels, ["high"]);
});

test("registered shortcuts apply their configured thinking defaults", async () => {
	const thinkingLevels: string[] = [];
	const shortcuts = registerShortcuts(
		async () => true,
		(level) => thinkingLevels.push(level),
	);

	for (const configured of MODEL_SHORTCUTS) {
		const shortcut = shortcuts.get(configured.shortcut);
		assert.ok(shortcut);
		await shortcut.handler({
			modelRegistry: { find: () => ({ provider: configured.provider, id: configured.model }) },
			scopedModels: [],
			hasUI: false,
			ui: { notify: () => {} },
		});
	}

	assert.deepEqual(
		thinkingLevels,
		MODEL_SHORTCUTS.map(({ thinkingLevel }) => thinkingLevel),
	);
});

test("registered shortcut does not select an unscoped catalogue model", async () => {
	let setModelCalls = 0;
	const shortcut = registerShortcuts(async () => {
		setModelCalls += 1;
		return true;
	}).get("alt+1");

	assert.ok(shortcut);
	await shortcut.handler({
		modelRegistry: { find: () => ({ provider: "openai-codex", id: "gpt-5.6-luna" }) },
		scopedModels: [{ model: { provider: "other", id: "model" } }],
		hasUI: false,
		ui: { notify: () => {} },
	});

	assert.equal(setModelCalls, 0);
});

test("busy shortcuts keep only the latest choice and session shutdown discards queued work", async () => {
	const handlers = new Map<string, () => Promise<void> | void>();
	const models: unknown[] = [];
	let idle = false;
	const shortcuts = registerShortcuts(
		async (model) => {
			models.push(model);
			return true;
		},
		undefined,
		undefined,
		handlers,
	);
	const ctx = {
		isIdle: () => idle,
		modelRegistry: { find: (_provider: string, id: string) => id },
		scopedModels: [],
		hasUI: false,
		ui: { notify() {} },
	};
	await shortcuts.get("alt+1")!.handler(ctx);
	await shortcuts.get("alt+2")!.handler(ctx);
	idle = true;
	await handlers.get("agent_settled")!();
	assert.deepEqual(models, ["gpt-5.6-terra"]);
	idle = false;
	await shortcuts.get("alt+3")!.handler(ctx);
	await handlers.get("session_shutdown")!();
	idle = true;
	await handlers.get("agent_settled")!();
	assert.deepEqual(models, ["gpt-5.6-terra"]);
});

test("a model switch completing after session replacement cannot apply stale thinking settings", async () => {
	const handlers = new Map<string, () => Promise<void> | void>();
	const switched = Promise.withResolvers<boolean>();
	const thinking: string[] = [];
	const shortcuts = registerShortcuts(
		() => switched.promise,
		(level) => thinking.push(level),
		undefined,
		handlers,
	);
	const request = shortcuts.get("alt+1")!.handler({
		modelRegistry: { find: () => ({ id: "model" }) },
		scopedModels: [],
		hasUI: false,
		ui: { notify() {} },
	});
	await handlers.get("session_shutdown")!();
	switched.resolve(true);
	await request;
	assert.deepEqual(thinking, []);
});
