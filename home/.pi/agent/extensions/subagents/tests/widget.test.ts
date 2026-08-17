import * as assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentView } from "../agent-types.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { bindRegistryUi, formatActivityAge, renderRunningAgentLines } from "../ui/widget.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
};

function view(overrides: {
	readonly agentId?: string;
	readonly status?: AgentView["summary"]["status"];
	readonly taskName?: string;
	readonly lastActivityTime?: number;
	readonly recentTools?: ReadonlyRunDetails["recentTools"];
	readonly contextUsage?: ReadonlyRunDetails["contextUsage"];
	readonly waiting?: boolean;
}): AgentView {
	const agentId = overrides.agentId ?? "worker-1";
	const status = overrides.status ?? "running";
	const taskName = overrides.taskName ?? "Fix parser";
	const details = {
		agent: "worker",
		taskName,
		profile: "balanced",
		model: "provider/model",
		effectiveThinking: "medium",
		finalText: "",
		startTime: 0,
		toolCount: overrides.recentTools?.length ?? 0,
		recentTools: overrides.recentTools ?? [],
		lastMessage: "",
		lastActivityTime: overrides.lastActivityTime ?? 0,
		contextUsage: overrides.contextUsage ?? { tokens: null, contextWindow: 10_000, percent: null },
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		resultId: "a".repeat(64),
		aborted: false,
	} satisfies ReadonlyRunDetails;
	return {
		summary: {
			agent_id: agentId,
			agent: "worker",
			task_name: taskName,
			profile: "balanced",
			model: "provider/model",
			effective_thinking: "medium",
			generation: 1,
			retained: false,
			status,
			started_at: 0,
			usage: details.usage,
			...(overrides.waiting
				? { pending_question: { question_id: "question-1", question: "Choose?", options: ["A", "B"] } }
				: {}),
		},
		details,
	};
}

test("running-agent widget summarizes current tools and activity age", () => {
	const lines = renderRunningAgentLines(
		[
			view({
				lastActivityTime: 117_000,
				recentTools: [{ name: "bash", argsPreview: "pnpm test" }],
				contextUsage: { tokens: 1_200, contextWindow: 10_000, percent: 12 },
			}),
			view({ agentId: "scout-2", taskName: "Inspect API", lastActivityTime: 60_000, waiting: true }),
			view({ agentId: "worker-3", status: "idle" }),
		],
		120_000,
		120,
		theme as never,
	);

	assert.deepEqual(lines, [
		"● 1 subagent running · 1 awaiting input",
		"  worker-1 · Fix parser · bash pnpm test · context 12% · 3s ago",
		"  scout-2 · Inspect API · waiting for input · 1m ago",
	]);
});

test("activity ages use compact units", () => {
	assert.equal(formatActivityAge(0), "1s ago");
	assert.equal(formatActivityAge(59_000), "59s ago");
	assert.equal(formatActivityAge(60_000), "1m ago");
	assert.equal(formatActivityAge(3_600_000), "1h ago");
	assert.equal(formatActivityAge(86_400_000), "1d ago");
});

test("running-agent widget shows only known native context and respects its width", () => {
	const unknownContext = renderRunningAgentLines([view({})], 120_000, 120, theme as never);
	assert.doesNotMatch(unknownContext.join("\n"), /context/);

	for (const width of [1, 10, 40]) {
		const lines = renderRunningAgentLines(
			[view({ contextUsage: { tokens: 1_200, contextWindow: 10_000, percent: 12 }, lastActivityTime: 117_000 })],
			120_000,
			width,
			theme as never,
		);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});

test("registry binding shows active work and clears it after settlement", () => {
	let views = [view({})];
	let listener: (() => void) | undefined;
	let renderRequests = 0;
	const statuses: Array<string | undefined> = [];
	const widgets: Array<unknown> = [];
	const binding = bindRegistryUi(
		{
			ui: {
				setStatus: (_id: string, status: string | undefined) => statuses.push(status),
				setWidget: (_id: string, widget: unknown) => widgets.push(widget),
			},
		} as never,
		{
			list: () => views.map(({ summary }) => summary),
			views: () => views,
			subscribe: (next: () => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
		} as never,
	);

	binding.refresh();
	assert.equal(statuses.at(-1), "agents 1 running");
	const widgetFactory = widgets.at(-1);
	assert.equal(typeof widgetFactory, "function");
	(widgetFactory as (tui: { requestRender(): void }, theme: never) => unknown)(
		{ requestRender: () => renderRequests++ },
		theme as never,
	);

	listener?.();
	assert.equal(renderRequests, 1, "registry changes redraw the localized widget instance");

	views = [view({ status: "idle" })];
	listener?.();
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);

	binding.close();
	assert.equal(listener, undefined);
});
