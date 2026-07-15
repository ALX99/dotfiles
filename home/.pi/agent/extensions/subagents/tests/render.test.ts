import * as assert from "node:assert/strict";
import { test } from "node:test";

import { renderAgentSummaries, renderManagementCall, renderResultBlock, renderWaitCall, renderWaitResult } from "../render.ts";
import type { RunDetails } from "../process.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

function details(): RunDetails {
	return {
		agent: "worker",
		taskName: "implement parser fix",
		depth: 1,
		exitCode: 0,
		finalText: "",
		stderr: "",
		aborted: false,
		startTime: 0,
		toolCount: 1,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [
			{
				toolCallId: "child-a",
				agent: "scout",
				taskName: "locate parser",
				depth: 2,
				status: "running",
				toolCount: 1,
				recentTools: [{ name: "read", argsPreview: "src/parser.ts" }],
				lastMessage: "",
				nestedRuns: [],
			},
			{
				toolCallId: "child-b",
				agent: "scout",
				taskName: "locate tests",
				depth: 2,
				status: "running",
				toolCount: 1,
				recentTools: [{ name: "grep", argsPreview: "parser" }],
				lastMessage: "",
				nestedRuns: [{
					toolCallId: "grandchild",
					agent: "scout",
					taskName: "find fixture",
					depth: 3,
					status: "completed",
					toolCount: 1,
					recentTools: [{ name: "read", argsPreview: "testdata/fixture.json" }],
					lastMessage: "",
					nestedRuns: [],
				}],
			},
		],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

test("renderResultBlock shows concurrent nested subagents and their child", () => {
	const rendered = renderResultBlock(details(), { expanded: true, isPartial: true }, theme as never).render(120).join("\n");

	assert.match(rendered, /locate parser/);
	assert.match(rendered, /locate tests/);
	assert.match(rendered, /find fixture/);
	assert.match(rendered, /testdata\/fixture\.json/);
});

test("management renderers identify targets and replace raw summary JSON", () => {
	const summaries = [{
		agent_id: "agent-12345678",
		agent_type: "scout",
		task_name: "inspect parser",
		depth: 1,
		generation: 1,
		status: "running" as const,
	}];
	const call = renderManagementCall("send_agent", summaries[0].agent_id, "check errors", false, summaries, theme as never).render(120).join("\n");
	const result = renderAgentSummaries("list_agents", summaries, false, theme as never).render(120).join("\n");

	assert.match(call, /send_agent · inspect parser · agent-1/);
	assert.match(call, /check errors/);
	assert.match(result, /list_agents · 1 agent/);
	assert.match(result, /inspect parser · scout · agent-12 · running/);
});

test("renderWaitCall names the tasks, count, and timeout", () => {
	const summaries = [{
		agent_id: "agent-12345678",
		agent_type: "scout",
		task_name: "inspect parser",
		depth: 1,
		generation: 1,
		status: "running" as const,
	}];
	const rendered = renderWaitCall(["agent-12345678"], 5_000, summaries, theme as never).render(120).join("\n");

	assert.match(rendered, /waiting for 1 agent to settle · up to 5\.0s/);
	assert.match(rendered, /inspect parser · agent-1/);
});

test("renderWaitResult distinguishes settled and still-running agents", () => {
	const rendered = renderWaitResult({
		elapsedMs: 1_000,
		timeoutMs: 1_000,
		summaries: [
			{
				agent_id: "done-12345678",
				agent_type: "scout",
				task_name: "inspect parser",
				depth: 1,
				generation: 1,
				status: "idle",
				final_text: "Parser finding",
			},
			{
				agent_id: "running-12345678",
				agent_type: "worker",
				task_name: "fix parser",
				depth: 1,
				generation: 1,
				status: "running",
			},
		],
	}, false, theme as never).render(120).join("\n");

	assert.match(rendered, /1\/2 settled · 1 still running/);
	assert.match(rendered, /inspect parser · scout · done-123/);
	assert.match(rendered, /fix parser · worker · running-/);
	assert.doesNotMatch(rendered, /Parser finding/);
});
