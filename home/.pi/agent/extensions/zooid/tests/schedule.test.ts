import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import schedule from "../schedule.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => void;

function createHarness(options: { idle?: boolean; failNextSend?: boolean } = {}) {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const notifications: Array<{ message: string; type: string }> = [];
	let idle = options.idle ?? true;
	let failNextSend = options.failNextSend ?? false;

	const ctx = {
		hasUI: true,
		isIdle: () => idle,
		ui: {
			notify: (message: string, type: string = "info") => notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext & ExtensionContext;

	const pi = {
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
		sendUserMessage(message: unknown, sendOptions: unknown) {
			if (failNextSend) {
				failNextSend = false;
				throw new Error("temporary send failure");
			}
			sent.push({ message, options: sendOptions });
			idle = false;
		},
	} as unknown as ExtensionAPI;

	schedule(pi);

	return {
		commands,
		ctx,
		emitSettled() {
			idle = true;
			events.get("agent_settled")?.({}, ctx);
		},
		notifications,
		sent,
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

test("sends immediately when the agent is idle", async () => {
	const harness = createHarness();

	await harness.commands.get("sch")!("Check the deployment", harness.ctx);

	assert.deepEqual(harness.sent, [
		{
			message: "Check the deployment",
			options: { expandPromptTemplates: true },
		},
	]);
	assert.equal(harness.notifications[0]?.message, "Agent is idle; sent the scheduled message.");
});

test("delivers scheduled messages FIFO, only after each agent run settles", async () => {
	const harness = createHarness({ idle: false });
	const command = harness.commands.get("sch")!;

	await command("First", harness.ctx);
	await command("Second", harness.ctx);
	assert.deepEqual(harness.sent, []);

	harness.emitSettled();
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["First"],
	);

	harness.emitSettled();
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["First", "Second"],
	);
});

test("keeps a message queued if sending throws, then retries it before later messages", async () => {
	const harness = createHarness({ failNextSend: true });
	const command = harness.commands.get("sch")!;

	await command("First", harness.ctx);
	assert.deepEqual(harness.sent, []);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Could not send the scheduled message: temporary send failure",
		type: "error",
	});

	await command("Second", harness.ctx);
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["First"],
	);

	harness.emitSettled();
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["First", "Second"],
	);
});

test("/sch without a message reports queue status without sending anything", async () => {
	const harness = createHarness();

	await harness.commands.get("sch")!("  ", harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.deepEqual(harness.notifications, [{ message: "No scheduled messages are waiting.", type: "info" }]);
});
