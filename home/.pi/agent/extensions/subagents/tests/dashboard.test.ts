import * as assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import {
	allowedDashboardActions,
	clampScroll,
	fitDashboardHeight,
	fitDockedPanel,
	formatAgentCounts,
	renderDashboard,
	visibleAgentViews,
	type DashboardRenderState,
	type DashboardTheme,
} from "../dashboard-render.ts";
import { Dashboard, type DashboardAgentReader, type DashboardClock, type DashboardDataSource } from "../dashboard.ts";
import type { AgentView } from "../agent-types.ts";
import { formatTranscript } from "../transcript.ts";

function view(
	status: AgentView["summary"]["status"],
	id: string = status,
	generation = 1,
	sessionFile?: string,
	finalText = "",
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
			finalText,
			stderr: "",
			aborted: status === "aborted",
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

	getLive(id: string): FakeAgent {
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

const listState: DashboardRenderState = {
	screen: "list",
	listOffset: 0,
	transcriptOffset: 0,
	outputOffset: 0,
	showClosed: false,
};

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

test("dashboard height helpers preserve the frame and stable dock height", () => {
	const lines = ["top", "one", "two", "three", "four", "help", "bottom"];
	assert.deepEqual(fitDashboardHeight(lines, 5), ["top", "one", "two", "help", "bottom"]);
	assert.deepEqual(fitDashboardHeight(lines, 2), ["help", "bottom"]);
	assert.deepEqual(fitDashboardHeight(lines, 0), []);
	assert.deepEqual(fitDockedPanel(["title", "body", "help", "divider"], 6, 8), [
		"title",
		"body",
		"        ",
		"        ",
		"help",
		"divider",
	]);
});

test("sanitizeTerminalText removes terminal controls and formatTranscript stays bounded", () => {
	assert.equal(
		sanitizeTerminalText("safe\u001b[2J\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\nnext\u0000"),
		"safelink next",
	);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Inspect\nthis\u001b[2J" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect it." },
				{ type: "toolCall", name: "read", arguments: { path: "agent-registry.ts" } },
			],
		},
	];
	assert.deepEqual(formatTranscript(messages), ["user: Inspect this", "assistant: I will inspect it. · → read"]);
	const many = Array.from({ length: 25 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `line ${index}` }],
	}));
	assert.deepEqual(formatTranscript(many).slice(0, 1), ["assistant: line 5"]);
});

test("Dashboard navigation reconciles selection and toggles archived rows", () => {
	const source = new FakeDataSource([view("idle", "one"), view("idle", "two"), view("closed", "closed")]);
	const dashboard = new Dashboard(source, { onOperation() {} });
	assert.equal(dashboard.getState().selectedId, "one");
	dashboard.handleInput("\u001b[B");
	assert.equal(dashboard.getState().selectedId, "two");
	dashboard.handleInput("\r");
	assert.equal(dashboard.getState().screen, "detail");
	dashboard.handleInput("i");
	assert.equal(dashboard.getState().screen, "diagnostics");
	dashboard.handleInput("\u001b");
	dashboard.handleInput("\u001b");
	assert.equal(dashboard.getState().screen, "list");
	assert.deepEqual(
		visibleAgentViews(false, source.views()).map((item) => item.summary.agent_id),
		["one", "two"],
	);
	dashboard.handleInput("a");
	assert.equal(dashboard.getState().showClosed, true);
});

test("dashboard actions are enabled only for their lifecycle states", () => {
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
	assert.equal(clampScroll(-10, 4), 0);
	assert.equal(clampScroll(10, 4), 4);
});

test("pure renderer respects narrow terminal widths", () => {
	for (const width of [0, 1, 3, 4, 8, 20]) {
		const lines = renderDashboard(
			{ state: listState, views: [view("running", "one")], maxRows: 8, now: 1_000 },
			theme,
			width,
		);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${line}`);
	}
});

test("active output returns to the current preview after an explicit full-output refresh", async () => {
	const source = new FakeDataSource([view("running", "one", 1, undefined, "first preview")]);
	const agent = source.getLive("one");
	agent.output = "full output snapshot";
	const dashboard = new Dashboard(source, { onOperation() {} });
	dashboard.attach(
		() => {},
		() => 10,
	);
	dashboard.handleInput("\r");
	dashboard.handleInput("o");
	assert.equal(agent.outputReads, 0);
	assert.match(dashboard.render(theme as never, 80).join("\n"), /first preview/);

	dashboard.handleInput("r");
	await settle();
	assert.equal(agent.outputReads, 1);
	assert.match(dashboard.render(theme as never, 80).join("\n"), /full output snapshot/);

	source.update([view("running", "one", 1, undefined, "new output in same generation")]);
	assert.equal(agent.outputReads, 1);
	assert.match(dashboard.render(theme as never, 80).join("\n"), /new output in same generation/);
	assert.doesNotMatch(dashboard.render(theme as never, 80).join("\n"), /full output snapshot/);
	dashboard.dispose();
});

test("settled output loads the full spool and explicit refresh records read failures", async () => {
	const source = new FakeDataSource([view("idle", "one", 1, undefined, "preview")]);
	const agent = source.getLive("one");
	agent.output = "safe\u001b[2J\nsecond";
	const dashboard = new Dashboard(source, { onOperation() {} });
	dashboard.handleInput("\r");
	dashboard.handleInput("o");
	assert.equal(dashboard.getState().output?.status, "loading");
	await settle();
	const loaded = dashboard.getState().output;
	assert.equal(loaded?.status, "ready");
	if (loaded?.status === "ready") assert.deepEqual(loaded.lines, ["safe", "second"]);

	agent.outputError = new Error("read\u001b[2J failed");
	dashboard.handleInput("r");
	await settle();
	const failed = dashboard.getState().output;
	assert.equal(failed?.status, "error");
	if (failed?.status === "error") assert.equal(failed.message, "read failed");
	assert.equal(agent.outputReads, 2);
});

test("transcript is an explicit snapshot that refreshes on r and once when the run settles", async () => {
	const source = new FakeDataSource([view("running", "one", 1)]);
	const agent = source.getLive("one");
	agent.messages = [{ role: "assistant", content: [{ type: "text", text: "first" }] }];
	const dashboard = new Dashboard(source, { onOperation() {} });
	dashboard.attach(
		() => {},
		() => 10,
	);
	dashboard.handleInput("\r");
	dashboard.handleInput("t");
	await settle();
	assert.equal(agent.messageReads, 1);

	agent.messages = [{ role: "assistant", content: [{ type: "text", text: "second" }] }];
	source.update([view("running", "one", 1)]);
	await settle();
	assert.equal(agent.messageReads, 1, "same-generation activity must not pretend a transcript snapshot is live");
	dashboard.handleInput("r");
	await settle();
	assert.equal(agent.messageReads, 2);

	agent.messages = [{ role: "assistant", content: [{ type: "text", text: "settled" }] }];
	source.update([view("idle", "one", 1)]);
	await settle();
	assert.equal(agent.messageReads, 3);
	const snapshot = dashboard.getState().transcript;
	if (snapshot?.status === "ready") assert.deepEqual(snapshot.lines, ["assistant: settled"]);
	dashboard.dispose();
});

test("Dashboard disposes its timer and registry subscription exactly once", () => {
	const source = new FakeDataSource([view("idle", "one")]);
	const clock = fakeClock();
	const dashboard = new Dashboard(source, { clock, onOperation() {} });
	dashboard.attach(
		() => {},
		() => 10,
	);
	assert.equal(source.subscriptions, 1);
	assert.equal(clock.intervals, 1);
	dashboard.dispose();
	dashboard.dispose();
	assert.equal(source.unsubscriptions, 1);
	assert.equal(clock.clears, 1);
	assert.equal(source.listeners.size, 0);
});
