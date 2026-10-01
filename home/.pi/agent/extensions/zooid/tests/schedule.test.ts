import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import schedule, { formatDelay, parseDelay } from "../schedule.ts";

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
		emit(name: string) {
			events.get(name)?.({}, ctx);
		},
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

test("parses the compact and compound delay forms", () => {
	assert.equal(parseDelay("2s"), 2_000);
	assert.equal(parseDelay("3m"), 180_000);
	assert.equal(parseDelay("1h"), 3_600_000);
	assert.equal(parseDelay("1d"), 86_400_000);
	assert.equal(parseDelay("1h30m20s"), 5_420_000);
	assert.equal(parseDelay("2h1s"), 7_201_000);
});

test("rejects text that is not a positive delay", () => {
	for (const text of ["", "0s", "0m", "5x", "5s5", "s5", "m", "1.5m", "-2s", "3 m", "5S", "1w"]) {
		assert.equal(parseDelay(text), undefined, text);
	}
});

test("renders a remaining delay the way it is written", () => {
	assert.equal(formatDelay(0), "0s");
	assert.equal(formatDelay(1), "1s");
	assert.equal(formatDelay(20_000), "20s");
	assert.equal(formatDelay(90_000), "1m 30s");
	assert.equal(formatDelay(3_600_000), "1h");
	assert.equal(formatDelay(3_725_000), "1h 2m 5s");
	assert.equal(formatDelay(90_061_000), "1d 1h 1m 1s");
});

test("sends a delayed message once its delay elapses", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness();
	const command = harness.commands.get("sch")!;

	await command("5m check the deployment", harness.ctx);
	assert.deepEqual(harness.sent, []);
	assert.equal(harness.notifications.at(-1)?.message, "Scheduled message in 5m. 1 scheduled message waiting.");

	t.mock.timers.tick(4 * 60_000);
	assert.deepEqual(harness.sent, []);

	t.mock.timers.tick(60_000);
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["check the deployment"],
	);
});

test("a delayed message that comes due while the agent is busy waits for the next settlement", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness({ idle: false });
	const command = harness.commands.get("sch")!;

	await command("2s rerun the tests", harness.ctx);
	t.mock.timers.tick(2_000);
	assert.deepEqual(harness.sent, []);

	harness.emitSettled();
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["rerun the tests"],
	);
});

test("a delayed message keeps its place ahead of later undelayed ones", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness({ idle: false });
	const command = harness.commands.get("sch")!;

	await command("10m water the plants", harness.ctx);
	await command("ship the release", harness.ctx);
	t.mock.timers.tick(10 * 60_000);
	harness.emitSettled();
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["water the plants"],
	);

	harness.emitSettled();
	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["water the plants", "ship the release"],
	);
});

test("reports the remaining delay of the next scheduled message", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness({ idle: false });

	await harness.commands.get("sch")!("90s status", harness.ctx);
	t.mock.timers.tick(30_000);
	await harness.commands.get("sch")!("  ", harness.ctx);

	assert.equal(harness.notifications.at(-1)?.message, "1 scheduled message waiting, next in 1m.");
});

test("rejects a malformed or message-less delay without changing the queue", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness();
	const command = harness.commands.get("sch")!;

	await command("5x check the deployment", harness.ctx);
	assert.equal(harness.notifications.at(-1)?.type, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /"5x" is not a delay/u);

	await command("5m", harness.ctx);
	assert.equal(harness.notifications.at(-1)?.message, "Add the message to send after the delay.");

	harness.setIdle(false);
	await command("status", harness.ctx);
	assert.equal(harness.notifications.at(-1)?.message, "Scheduled message. 1 scheduled message waiting.");
	assert.deepEqual(harness.sent, []);
});

test("treats a message that starts with -- as verbatim and undelayed", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness({ idle: false });

	await harness.commands.get("sch")!("-- 5m means five minutes", harness.ctx);
	t.mock.timers.tick(60_000);
	harness.emitSettled();

	assert.deepEqual(
		harness.sent.map(({ message }) => message),
		["5m means five minutes"],
	);
});

test("a session start drops a pending delay instead of firing it later", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = createHarness({ idle: false });
	const command = harness.commands.get("sch")!;

	await command("2s rerun the tests", harness.ctx);
	harness.emit("session_start");
	t.mock.timers.tick(2_000);
	harness.emitSettled();

	assert.deepEqual(harness.sent, []);
});
