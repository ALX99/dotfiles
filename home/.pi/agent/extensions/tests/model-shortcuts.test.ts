import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import modelShortcuts, { MODEL_SHORTCUTS } from "../model-shortcuts.ts";

interface Shortcut {
	handler(ctx: {
		modelRegistry: { find(provider: string, model: string): unknown };
		hasUI: boolean;
		ui: { notify(message: string, level: "warning" | "info"): void };
	}): Promise<void>;
}

function registerShortcuts(setModel: (model: unknown) => Promise<boolean>): Map<string, Shortcut> {
	const shortcuts = new Map<string, Shortcut>();
	modelShortcuts({
		registerShortcut(shortcut: string, definition: unknown) {
			shortcuts.set(shortcut, definition as Shortcut);
		},
		setModel,
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
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});

	assert.deepEqual(findCalls, [[configured.provider, configured.model]]);
	assert.deepEqual(setModels, [selected]);
	assert.deepEqual(
		notifications.map(({ level }) => level),
		["info"],
	);
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
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});

	assert.deepEqual(
		notifications.map(({ level }) => level),
		["warning"],
	);
});
