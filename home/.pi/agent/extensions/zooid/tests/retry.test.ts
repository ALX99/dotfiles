import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import retry, { getLastUserPrompt, retryLastPrompt } from "../retry.ts";

function userMessage(content: string | readonly object[], id = "user"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-16T00:00:00.000Z",
		message: {
			role: "user",
			content,
			timestamp: Date.parse("2026-09-16T00:00:00.000Z"),
		},
	} as SessionEntry;
}

function createHarness(
	options: { branch?: SessionEntry[]; idle?: boolean; cancelled?: boolean; editorText?: string } = {},
) {
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const sent: unknown[] = [];
	const events: unknown[] = [];
	let editorText = options.editorText ?? "";
	const notifications: Array<{ message: string; type: string }> = [];
	const branch = options.branch ?? [];
	const ctx = {
		isIdle: () => options.idle ?? true,
		sessionManager: { getBranch: () => branch },
		async navigateTree(entryId: string, navigationOptions: unknown) {
			events.push({ navigate: entryId, options: navigationOptions });
			if (!options.cancelled && !editorText.trim()) editorText = "restored prompt";
			return { cancelled: options.cancelled ?? false };
		},
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
			commands.set(name, command);
		},
		sendUserMessage(content: unknown) {
			events.push({ send: content, editorText });
			sent.push(content);
		},
	} as unknown as ExtensionAPI;

	retry(pi);

	return { commands, ctx, events, notifications, pi, sent };
}

test("selects the latest user message on the active branch", () => {
	const first = userMessage("first", "first");
	const second = userMessage("second", "second");
	const response = {
		type: "message",
		message: { role: "assistant", content: [] },
	} as unknown as SessionEntry;

	assert.deepEqual(getLastUserPrompt([first, second, response]), { entryId: "second", content: "second" });
});

test("retry rewinds without a summary before replaying the prompt with its attachments", async () => {
	const content = [
		{ type: "text", text: "Describe this image." },
		{ type: "image", mimeType: "image/png", data: "abc" },
	] as const;
	const harness = createHarness({ branch: [userMessage("old", "old"), userMessage(content, "latest")] });

	await retryLastPrompt(harness.pi, harness.ctx);

	assert.deepEqual(harness.events, [
		{ navigate: "latest", options: { summarize: false } },
		{ send: content, editorText: "" },
	]);
	assert.deepEqual(harness.sent, [content]);
	assert.deepEqual(harness.notifications, []);
});

test("retry preserves an existing editor draft", async () => {
	const harness = createHarness({ branch: [userMessage("original")], editorText: "draft" });

	await retryLastPrompt(harness.pi, harness.ctx);

	assert.equal(harness.ctx.ui.getEditorText(), "draft");
	assert.deepEqual(harness.sent, ["original"]);
});

test("retry does not replay when tree navigation is cancelled", async () => {
	const harness = createHarness({ branch: [userMessage("original")], cancelled: true, editorText: "draft" });

	await retryLastPrompt(harness.pi, harness.ctx);

	assert.deepEqual(harness.events, [{ navigate: "user", options: { summarize: false } }]);
	assert.deepEqual(harness.sent, []);
	assert.equal(harness.ctx.ui.getEditorText(), "draft");
});

test("retry warns when there is no previous prompt", async () => {
	const harness = createHarness();

	await harness.commands.get("retry")!.handler("", harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.deepEqual(harness.events, []);
	assert.deepEqual(harness.notifications, [{ message: "No previous prompt to retry.", type: "warning" }]);
});

test("retry does not interrupt a busy agent", async () => {
	const harness = createHarness({ branch: [userMessage("try again")], idle: false });

	await harness.commands.get("retry")!.handler("", harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.deepEqual(harness.events, []);
	assert.deepEqual(harness.notifications, [{ message: "Cannot retry while the agent is busy.", type: "warning" }]);
});
