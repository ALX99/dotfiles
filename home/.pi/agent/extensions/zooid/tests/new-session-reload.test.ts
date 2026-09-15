import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import newSessionReloadExtension from "../new-session-reload.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
type Command = { handler(args: string, ctx: unknown): Promise<void> };

function createHarness() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const sentMessages: Array<{ content: string; expandPromptTemplates?: boolean }> = [];

	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }) {
			sentMessages.push({ content, ...options });
		},
	} as unknown as ExtensionAPI;

	newSessionReloadExtension(pi);

	return {
		commands,
		sentMessages,
		async runSessionStart(reason: string) {
			await handlers.get("session_start")?.({ reason }, {});
		},
		async runResourcesDiscover() {
			await handlers.get("resources_discover")?.({ type: "resources_discover" }, {});
		},
		runSessionShutdown() {
			handlers.get("session_shutdown")?.({}, {});
		},
	};
}

function waitForDeferredWork(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("reloads after a new session but not after other session starts", async () => {
	const harness = createHarness();

	await harness.runSessionStart("startup");
	await harness.runSessionStart("reload");
	await harness.runSessionStart("resume");
	await waitForDeferredWork();
	assert.deepEqual(harness.sentMessages, []);

	await harness.runSessionStart("new");
	await harness.runResourcesDiscover();
	await waitForDeferredWork();
	assert.deepEqual(harness.sentMessages, [
		{
			content: "/reload-after-new",
			expandPromptTemplates: true,
		},
	]);
});

test("cancels the deferred reload when the session shuts down", async () => {
	const harness = createHarness();

	await harness.runSessionStart("new");
	harness.runSessionShutdown();
	await harness.runResourcesDiscover();
	await waitForDeferredWork();

	assert.deepEqual(harness.sentMessages, []);
});

test("waits for resource discovery before scheduling the reload", async () => {
	const harness = createHarness();

	await harness.runSessionStart("new");
	await waitForDeferredWork();
	assert.deepEqual(harness.sentMessages, []);

	await harness.runResourcesDiscover();
	await waitForDeferredWork();
	assert.deepEqual(harness.sentMessages, [
		{
			content: "/reload-after-new",
			expandPromptTemplates: true,
		},
	]);
});

test("the internal command runs the normal reload flow", async () => {
	const harness = createHarness();
	let reloads = 0;

	const command = harness.commands.get("reload-after-new");
	assert.ok(command);
	await command.handler("", {
		reload: async () => {
			reloads += 1;
		},
	});

	assert.equal(reloads, 1);
});
