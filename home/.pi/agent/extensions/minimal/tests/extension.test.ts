import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import minimalExtension from "../index.ts";

type Entry = Record<string, unknown>;
type Handler = (event: unknown, ctx: unknown) => unknown;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "spawn_agent"];
const MINIMAL_TOOLS = ["bash", "read", "edit"];

function createHarness(options: { initialBranch?: Entry[]; available?: string[]; active?: string[] } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string>();
	const branch: Entry[] = [...(options.initialBranch ?? [])];
	let activeTools = [...(options.active ?? DEFAULT_TOOLS)];
	const available = [...(options.available ?? DEFAULT_TOOLS)];

	const pi = {
		registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) {
			commands.set(name, command);
		},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		getAllTools: () => available.map((name) => ({ name })),
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: "/workspace/project",
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push(type === undefined ? { message } : { message, type }),
			setStatus(key: string, text: string | undefined) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	};

	minimalExtension(pi);

	return {
		commands,
		entries,
		notifications,
		statuses,
		ctx,
		activeTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		pushEntry: (entry: Entry) => branch.push(entry),
		clearBranch: () => {
			branch.length = 0;
		},
		async runCommand(args: string) {
			const command = commands.get("minimal");
			assert.ok(command, "the minimal command is registered");
			await command.handler(args, ctx);
		},
		async runBeforeAgentStart() {
			const handler = handlers.get("before_agent_start");
			assert.ok(handler, "before_agent_start is handled");
			return handler({ type: "before_agent_start" }, ctx);
		},
		async runSessionEvent(name: "session_start" | "session_tree") {
			const handler = handlers.get(name);
			assert.ok(handler, `${name} is handled`);
			await handler({ type: name }, ctx);
		},
	};
}

test("enabling minimal mode restricts tools, records state, and reports status", async () => {
	const harness = createHarness();

	await harness.runCommand("on");

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, edit");
	assert.deepEqual(harness.entries, [
		{ customType: "minimal-mode-state", data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS } },
	]);
});

test("disabling minimal mode restores the recorded selection and clears status", async () => {
	const harness = createHarness();

	await harness.runCommand("on");
	await harness.runCommand("off");

	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
	assert.equal(harness.statuses.has("minimal"), false);
	// The off entry keeps the baseline, so enabling again restores the same selection.
	assert.deepEqual(harness.entries.at(-1)?.data, {
		version: 1,
		enabled: false,
		previousTools: DEFAULT_TOOLS,
	});
});

test("the bare command toggles in both directions", async () => {
	const harness = createHarness();

	await harness.runCommand("");
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);

	await harness.runCommand("");
	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("a branch that turned the mode off re-enables with the same baseline", async () => {
	const harness = createHarness();

	await harness.runCommand("on");
	await harness.runCommand("off");
	await harness.runCommand("on");

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	await harness.runCommand("off");
	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("the turn hook enforces tools without replacing the system prompt", async () => {
	const harness = createHarness();

	assert.equal(await harness.runBeforeAgentStart(), undefined);

	await harness.runCommand("on");
	assert.equal(await harness.runBeforeAgentStart(), undefined);
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
});

test("a restored branch re-applies the tool restriction without losing its snapshot", async () => {
	const harness = createHarness({
		initialBranch: [
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS },
			},
		],
	});

	await harness.runSessionEvent("session_start");

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, edit");

	// The restored snapshot must survive for the eventual exit.
	await harness.runCommand("off");
	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("a turn re-asserts the restriction after the host re-initializes tools", async () => {
	const harness = createHarness({
		initialBranch: [
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS },
			},
		],
	});

	await harness.runSessionEvent("session_start");
	// Pi applies its own selection after session_start; the mode must still win at turn time.
	harness.setActiveTools(DEFAULT_TOOLS);
	const result = await harness.runBeforeAgentStart();

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.equal(result, undefined, "the hook leaves the system prompt alone");
});

test("a fresh session starts in minimal mode and the baseline still restores", async () => {
	const harness = createHarness();

	await harness.runSessionEvent("session_start");

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, edit");
	assert.deepEqual(harness.entries, [
		{ customType: "minimal-mode-state", data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS } },
	]);

	await harness.runCommand("off");
	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("a session that recorded the mode off stays unrestricted", async () => {
	const harness = createHarness({
		initialBranch: [
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: false, previousTools: [] },
			},
		],
	});

	await harness.runSessionEvent("session_start");

	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
	assert.equal(harness.statuses.has("minimal"), false);
	assert.deepEqual(harness.entries, [], "a recorded choice is not written again");
});

test("a branch with no recorded state adopts the default and records it", async () => {
	const harness = createHarness({ initialBranch: [{ type: "custom", customType: "other", data: {} }] });

	await harness.runSessionEvent("session_tree");

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, edit");
	assert.deepEqual(harness.entries, [
		{ customType: "minimal-mode-state", data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS } },
	]);
});

test("malformed recorded state falls back to the default rather than being trusted", async () => {
	const malformed = [
		{ version: 1, enabled: true },
		{ version: 2, enabled: true, previousTools: [] },
		{ version: 1, enabled: "yes", previousTools: [] },
		{ version: 1, enabled: true, previousTools: [1] },
		null,
	];

	for (const data of malformed) {
		const harness = createHarness({
			initialBranch: [{ type: "custom", customType: "minimal-mode-state", data }],
		});

		await harness.runSessionEvent("session_start");

		assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS, JSON.stringify(data));
		assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, edit", JSON.stringify(data));
		assert.deepEqual(harness.entries, [
			{ customType: "minimal-mode-state", data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS } },
		]);
	}
});

test("a branch reached while restricted does not record the restriction as its baseline", async () => {
	const harness = createHarness();

	await harness.runSessionEvent("session_start");
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);

	// Navigating to an ancestor can land on a branch whose recorded state does not exist, while the
	// mode's own restriction is still the live selection.
	harness.clearBranch();
	await harness.runSessionEvent("session_tree");

	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.deepEqual(harness.entries.at(-1)?.data, {
		version: 1,
		enabled: true,
		previousTools: DEFAULT_TOOLS,
	});
	await harness.runCommand("off");
	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("an off branch without a recorded baseline does not adopt the restriction as its baseline", async () => {
	const harness = createHarness();

	await harness.runSessionEvent("session_start");
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);

	// Navigate to an older branch that recorded the mode off before a baseline was ever kept.
	harness.clearBranch();
	harness.pushEntry({
		type: "custom",
		customType: "minimal-mode-state",
		data: { version: 1, enabled: false, previousTools: [] },
	});
	await harness.runSessionEvent("session_tree");
	assert.equal(harness.statuses.has("minimal"), false);

	await harness.runCommand("on");
	await harness.runCommand("off");
	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("the default baseline is whatever the session was running before minimal mode", async () => {
	const custom = ["read", "bash", "apply_patch", "spawn_agent"];
	const harness = createHarness({ available: [...DEFAULT_TOOLS, "apply_patch"], active: custom });

	await harness.runSessionEvent("session_start");

	assert.deepEqual(harness.activeTools(), ["bash", "read", "apply_patch"]);
	await harness.runCommand("off");
	assert.deepEqual(harness.activeTools(), custom);
});

test("a session using apply_patch keeps it instead of edit", async () => {
	const harness = createHarness({
		available: [...DEFAULT_TOOLS, "apply_patch"],
		active: ["read", "bash", "apply_patch", "spawn_agent"],
	});

	await harness.runCommand("on");

	assert.deepEqual(harness.activeTools(), ["bash", "read", "apply_patch"]);
	assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, apply_patch");
});

test("a model switch that swaps the editing tool is followed at the next turn", async () => {
	const harness = createHarness();

	await harness.runCommand("on");
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);

	// codex-apply-patch activates apply_patch and drops edit when the model becomes a GPT model.
	harness.setActiveTools(["bash", "read", "apply_patch"]);
	await harness.runBeforeAgentStart();

	assert.deepEqual(harness.activeTools(), ["bash", "read", "apply_patch"]);
	assert.equal(harness.statuses.get("minimal"), "minimal: bash, read, apply_patch");
});

test("enabling fails cleanly when a core tool is unavailable", async () => {
	const harness = createHarness({ available: ["bash", "edit"], active: ["bash", "edit"] });

	await harness.runCommand("on");

	assert.deepEqual(harness.activeTools(), ["bash", "edit"]);
	assert.equal(harness.entries.length, 0);
	assert.equal(harness.notifications.at(-1)?.type, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /read is unavailable/);
});

test("a session without a core tool keeps the default mode off", async () => {
	const harness = createHarness({ available: ["bash", "edit"], active: ["bash", "edit"] });

	await harness.runSessionEvent("session_start");

	assert.deepEqual(harness.activeTools(), ["bash", "edit"]);
	assert.equal(harness.statuses.has("minimal"), false);
	assert.deepEqual(harness.entries, [], "a mode that cannot run records no choice");
	assert.equal(harness.notifications.at(-1)?.type, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /read is unavailable/);
});

test("enabling twice does not overwrite the restore snapshot", async () => {
	const harness = createHarness();

	await harness.runCommand("on");
	await harness.runCommand("on");
	await harness.runCommand("off");

	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
});

test("turning off without a recorded baseline keeps the toolset and points at a new session", async () => {
	const harness = createHarness({
		initialBranch: [
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: true, previousTools: [] },
			},
		],
	});

	await harness.runSessionEvent("session_start");
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);

	await harness.runCommand("off");

	// The host rebuilds a session's selection from its configured defaults, and /reload carries the
	// current one forward, so only a new session is a truthful recovery step here.
	assert.deepEqual(harness.activeTools(), MINIMAL_TOOLS);
	assert.equal(harness.statuses.has("minimal"), false);
	const warning = harness.notifications.at(-1);
	assert.equal(warning?.type, "warning");
	assert.match(warning?.message ?? "", /no earlier tool selection was recorded/);
	assert.match(warning?.message ?? "", /new session \(\/new\)/);
	assert.doesNotMatch(warning?.message ?? "", /\/reload/);
	assert.deepEqual(harness.entries.at(-1)?.data, { version: 1, enabled: false, previousTools: [] });
});

test("status reports the active toolset", async () => {
	const harness = createHarness();

	await harness.runCommand("status");
	assert.equal(harness.notifications.at(-1)?.message, "Minimal mode off.");

	await harness.runCommand("on");
	await harness.runCommand("status");
	assert.equal(harness.notifications.at(-1)?.message, "Minimal mode on. Tools: bash, read, edit.");
});

test("unknown arguments are rejected without changing state", async () => {
	const harness = createHarness();

	await harness.runCommand("maybe");

	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/minimal/);
});

test("the newest recorded state wins when the branch has several", async () => {
	const harness = createHarness({
		initialBranch: [
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: true, previousTools: DEFAULT_TOOLS },
			},
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: false, previousTools: [] },
			},
		],
	});

	await harness.runSessionEvent("session_start");

	assert.deepEqual(harness.activeTools(), DEFAULT_TOOLS);
	assert.equal(harness.statuses.has("minimal"), false);
});
