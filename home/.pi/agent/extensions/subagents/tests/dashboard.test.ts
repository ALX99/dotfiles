import * as assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import { allowedDashboardActions } from "../dashboard/actions.ts";
import {
	DashboardController,
	type DashboardAgentReader,
	type DashboardClock,
	type DashboardDataSource,
} from "../dashboard/controller.ts";
import { fitDashboardHeight, fitDockedPanel, type DashboardTheme } from "../dashboard/render.ts";
import { clampScroll, createDashboardState, reduceDashboardState, visibleAgentViews } from "../dashboard/state.ts";
import { formatTranscript } from "../dashboard/transcript.ts";
import { buildDashboardViewModel, formatAgentCounts } from "../dashboard/view-model.ts";
import { renderDashboard } from "../dashboard/render.ts";
import type { AgentView } from "../host.ts";

function view(
	status: AgentView["summary"]["status"],
	id: string = status,
	generation = 1,
	sessionFile?: string,
): AgentView {
	return {
		summary: {
			agent_id: id,
			agent: "scout",
			task_name: "test",
			profile: "fast",
			model: "opencode-go/deepseek-v4-flash",
			effective_thinking: "low",
			depth: 1,
			generation,
			status,
			...(sessionFile === undefined ? {} : { session_file: sessionFile }),
		},
		details: {
			agent: "scout",
			taskName: "test",
			profile: "fast",
			model: "opencode-go/deepseek-v4-flash",
			effectiveThinking: "low",
			depth: 1,
			exitCode: 0,
			finalText: "",
			stderr: "",
			aborted: false,
			startTime: 0,
			toolCount: 0,
			recentTools: [],
			lastMessage: "",
			nestedRuns: [],
			tokens: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		},
	};
}

class FakeAgent implements DashboardAgentReader {
	messages: unknown[] = [];
	output = "";
	messageReads = 0;
	outputReads = 0;
	messageError: Error | undefined;
	outputError: Error | undefined;

	async getMessages(): Promise<unknown[]> {
		this.messageReads++;
		if (this.messageError) throw this.messageError;
		return this.messages;
	}

	async loadFullOutput(): Promise<string> {
		this.outputReads++;
		if (this.outputError) throw this.outputError;
		return this.output;
	}
}

class FakeDataSource implements DashboardDataSource {
	currentViews: AgentView[];
	readonly agents = new Map<string, FakeAgent>();
	readonly listeners = new Set<() => void>();
	subscriptions = 0;
	unsubscriptions = 0;

	constructor(views: AgentView[]) {
		this.currentViews = views;
		for (const item of views) this.agents.set(item.summary.agent_id, new FakeAgent());
	}

	views(): AgentView[] {
		return this.currentViews;
	}

	get(id: string): FakeAgent {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Missing fake agent ${id}.`);
		return agent;
	}

	subscribe(listener: () => void): () => void {
		this.subscriptions++;
		this.listeners.add(listener);
		return () => {
			if (this.listeners.delete(listener)) this.unsubscriptions++;
		};
	}

	update(views: AgentView[]): void {
		this.currentViews = views;
		for (const listener of this.listeners) listener();
	}
}

function fakeClock(): DashboardClock & { intervals: number; clears: number } {
	const clock: DashboardClock & { intervals: number; clears: number } = {
		intervals: 0,
		clears: 0,
		now: () => 5_000,
		setInterval() {
			this.intervals++;
			return {
				cancel: () => {
					clock.clears++;
				},
			};
		},
	};
	return clock;
}

const minimalTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bg(_color: string, text: string): string {
		return text;
	},
};
const theme = minimalTheme satisfies DashboardTheme;

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("formatAgentCounts groups starting and running agents", () => {
	assert.equal(
		formatAgentCounts([view("starting"), view("running"), view("idle"), view("failed")]),
		"2 running · 1 ready · 1 failed",
	);
	assert.equal(formatAgentCounts([]), "0 running");
});

test("fitDashboardHeight preserves the frame and controls on short terminals", () => {
	const lines = ["top", "one", "two", "three", "four", "help", "bottom"];
	assert.deepEqual(fitDashboardHeight(lines, 5), ["top", "one", "two", "help", "bottom"]);
	assert.equal(fitDashboardHeight(lines, 5).length, 5);
	assert.deepEqual(fitDashboardHeight(lines, 2), ["help", "bottom"]);
	assert.deepEqual(fitDashboardHeight(lines, 0), []);
	assert.equal(fitDashboardHeight(lines, 10), lines);
});

test("fitDockedPanel keeps every inspector screen at a stable height", () => {
	const lines = ["title", "body", "help", "divider"];
	assert.deepEqual(fitDockedPanel(lines, 6, 8), ["title", "body", "        ", "        ", "help", "divider"]);
	assert.equal(fitDockedPanel([...lines, "extra", "more"], 4, 8).length, 4);
});

test("sanitizeTerminalText removes terminal controls and flattens rows", () => {
	assert.equal(
		sanitizeTerminalText("safe\u001b[2J\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\nnext\u0000"),
		"safelink next",
	);
});

test("formatTranscript produces a bounded compact activity log", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Inspect\nthis\u001b[2J" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect it." },
				{ type: "toolCall", name: "read", arguments: { path: "host.ts" } },
			],
		},
		{ role: "toolResult", content: [{ type: "text", text: "done" }] },
	];

	assert.deepEqual(formatTranscript(messages), [
		"user: Inspect this",
		"assistant: I will inspect it. · → read",
		"toolResult: done",
	]);

	const many = Array.from({ length: 25 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `line ${index}` }],
	}));
	const bounded = formatTranscript(many);
	assert.equal(bounded.length, 20);
	assert.equal(bounded[0], "assistant: line 5");
});

test("dashboard navigation changes selection and returns through screens", () => {
	const source = new FakeDataSource([view("idle", "one"), view("idle", "two")]);
	const controller = new DashboardController(source, { onOperation() {} });

	assert.equal(controller.getState().selectedId, "one");
	controller.handleInput("\u001b[B");
	assert.equal(controller.getState().selectedId, "two");
	controller.handleInput("\r");
	assert.equal(controller.getState().screen, "detail");
	controller.handleInput("i");
	assert.equal(controller.getState().screen, "diagnostics");
	controller.handleInput("\u001b");
	assert.equal(controller.getState().screen, "detail");
	controller.handleInput("\u001b");
	assert.equal(controller.getState().screen, "list");
});

test("pure selection reconciliation chooses an active replacement after deletion", () => {
	let state = reduceDashboardState(createDashboardState("deleted"), {
		type: "syncViews",
		views: [view("idle", "idle"), view("running", "active")],
	});
	assert.equal(state.selectedId, "active");
	state = reduceDashboardState(state, { type: "syncViews", views: [view("idle", "idle")] });
	assert.equal(state.selectedId, "idle");
});

test("closed agents are filtered and can be toggled into the list", () => {
	const views = [view("idle", "open"), view("closed", "closed")];
	let state = createDashboardState();
	assert.deepEqual(
		visibleAgentViews(state, views).map((item) => item.summary.agent_id),
		["open"],
	);
	state = reduceDashboardState(state, { type: "toggleClosed", views });
	assert.deepEqual(
		visibleAgentViews(state, views).map((item) => item.summary.agent_id),
		["open", "closed"],
	);
});

test("dashboard actions are enabled only for their lifecycle states", () => {
	assert.deepEqual(allowedDashboardActions(view("starting").summary), {
		steer: true,
		followUp: false,
		interrupt: true,
		close: true,
		jump: false,
	});
	assert.deepEqual(allowedDashboardActions(view("running").summary), {
		steer: true,
		followUp: false,
		interrupt: true,
		close: true,
		jump: false,
	});
	for (const status of ["idle", "failed", "aborted"] as const) {
		assert.deepEqual(allowedDashboardActions(view(status, status, 1, "/session").summary), {
			steer: false,
			followUp: true,
			interrupt: false,
			close: true,
			jump: true,
		});
	}
	assert.deepEqual(allowedDashboardActions(view("closed", "closed", 1, "/session").summary), {
		steer: false,
		followUp: false,
		interrupt: false,
		close: false,
		jump: true,
	});
});

test("scroll offsets clamp at both bounds", () => {
	assert.equal(clampScroll(-10, 4), 0);
	assert.equal(clampScroll(2, 4), 2);
	assert.equal(clampScroll(10, 4), 4);
	assert.equal(clampScroll(2, -1), 0);
});

test("pure renderer respects narrow terminal widths", () => {
	const views = [view("running", "one")];
	const state = reduceDashboardState(createDashboardState(), { type: "syncViews", views });
	for (const width of [0, 1, 3, 4, 8, 20]) {
		const lines = renderDashboard(buildDashboardViewModel({ state, views, maxRows: 8, now: 1_000 }), theme, width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
	}
});

test("full output loads asynchronously, sanitizes content, and records failures", async () => {
	const source = new FakeDataSource([view("idle", "one")]);
	const agent = source.get("one");
	agent.output = "safe\u001b[2J\nsecond";
	const controller = new DashboardController(source, { onOperation() {} });
	controller.handleInput("\r");
	controller.handleInput("o");
	assert.equal(controller.getState().outputs.get("one")?.status, "loading");
	await settle();
	const loaded = controller.getState().outputs.get("one");
	assert.equal(loaded?.status, "ready");
	if (loaded?.status === "ready") assert.deepEqual(loaded.lines, ["safe", "second"]);

	controller.handleInput("\u001b");
	agent.outputError = new Error("read\u001b[2J failed");
	controller.handleInput("o");
	await settle();
	const failed = controller.getState().outputs.get("one");
	assert.equal(failed?.status, "error");
	if (failed?.status === "error") assert.equal(failed.message, "read failed");
	assert.equal(agent.outputReads, 2);
});

test("transcript cache refreshes when the selected agent generation changes", async () => {
	const source = new FakeDataSource([view("running", "one", 1)]);
	const agent = source.get("one");
	agent.messages = [{ role: "assistant", content: [{ type: "text", text: "first" }] }];
	const clock = fakeClock();
	const controller = new DashboardController(source, { clock, onOperation() {} });
	controller.attach(
		() => {},
		() => 10,
	);
	controller.handleInput("\r");
	controller.handleInput("t");
	await settle();
	assert.equal(agent.messageReads, 1);
	let cached = controller.getState().transcripts.get("one");
	assert.equal(cached?.generation, 1);

	agent.messages = [{ role: "assistant", content: [{ type: "text", text: "second" }] }];
	source.update([view("running", "one", 2)]);
	await settle();
	assert.equal(agent.messageReads, 2);
	cached = controller.getState().transcripts.get("one");
	assert.equal(cached?.generation, 2);
	if (cached?.status === "ready") assert.deepEqual(cached.lines, ["assistant: second"]);
	controller.dispose();
});

test("controller disposes its timer and registry subscription exactly once", () => {
	const source = new FakeDataSource([view("idle", "one")]);
	const clock = fakeClock();
	const controller = new DashboardController(source, { clock, onOperation() {} });
	controller.attach(
		() => {},
		() => 10,
	);
	assert.equal(source.subscriptions, 1);
	assert.equal(clock.intervals, 1);
	controller.dispose();
	controller.dispose();
	assert.equal(source.unsubscriptions, 1);
	assert.equal(clock.clears, 1);
	assert.equal(source.listeners.size, 0);
});
