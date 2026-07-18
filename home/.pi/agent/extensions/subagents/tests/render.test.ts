import * as assert from "node:assert/strict";
import { test } from "node:test";

import { Container } from "@earendil-works/pi-tui";
import {
	renderAgentSummaries,
	renderCallHeader,
	renderManagementCall,
	renderResultBlock,
	renderWaitCall,
	renderWaitResult,
} from "../render.ts";
import type { RunDetails } from "../run-state.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};
// These render helpers use only fg() and bold(); the focused fixture deliberately
// omits unrelated Theme methods.
const renderTheme = theme as never;

function details(): RunDetails {
	return {
		agent: "worker",
		taskName: "implement parser fix",
		profile: "balanced",
		model: "opencode-go/glm-5.2",
		effectiveThinking: "medium",
		sessionFile: "/tmp/subagent.jsonl",
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
				nestedRuns: [
					{
						toolCallId: "grandchild",
						agent: "scout",
						taskName: "find fixture",
						depth: 3,
						status: "completed",
						toolCount: 1,
						recentTools: [{ name: "read", argsPreview: "testdata/fixture.json" }],
						lastMessage: "",
						nestedRuns: [],
					},
				],
			},
		],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

test("spawn call header always identifies async or blocking execution", () => {
	const blocking = new Container();
	renderCallHeader(blocking, { agent: "worker", message: "fix parser" }, false, renderTheme);
	const asyncCall = new Container();
	renderCallHeader(asyncCall, { agent: "scout", message: "inspect parser", background: true }, false, renderTheme);

	assert.match(blocking.render(120).join("\n"), /spawn_agent worker .*· blocking/);
	assert.doesNotMatch(blocking.render(120).join("\n"), /· async/);
	assert.match(asyncCall.render(120).join("\n"), /spawn_agent scout .*· async/);
	assert.doesNotMatch(asyncCall.render(120).join("\n"), /· blocking/);
});

test("renderResultBlock shows concurrent nested subagents and their child", () => {
	const rendered = renderResultBlock(details(), { expanded: true, isPartial: true }, renderTheme)
		.render(120)
		.join("\n");

	assert.match(rendered, /locate parser/);
	assert.match(rendered, /locate tests/);
	assert.match(rendered, /find fixture/);
	assert.match(rendered, /testdata\/fixture\.json/);
});

test("renderResultBlock keeps collapsed rows compact and expanded rows complete", () => {
	const run = details();
	run.status = "idle";
	run.finalText = "one\ntwo\nthree\nfour";
	run.recentTools = [{ name: "read", argsPreview: "src/parser.ts" }];
	const collapsed = renderResultBlock(run, { expanded: false, isPartial: false }, renderTheme).render(120).join("\n");
	const expanded = renderResultBlock(run, { expanded: true, isPartial: false }, renderTheme).render(120).join("\n");

	assert.match(collapsed, /implement parser fix · worker · balanced/);
	assert.match(collapsed, /one/);
	assert.match(collapsed, /two/);
	assert.match(collapsed, /three/);
	assert.doesNotMatch(collapsed, /four/);
	assert.doesNotMatch(collapsed, /src\/parser\.ts/);
	assert.match(expanded, /opencode-go\/glm-5\.2/);
	assert.match(expanded, /src\/parser\.ts/);
	assert.match(expanded, /four/);
});

test("management renderers identify targets and replace raw summary JSON", () => {
	const summaries = [
		{
			agent_id: "agent-12345678",
			agent: "scout",
			task_name: "inspect parser",
			profile: "fast",
			model: "opencode-go/deepseek-v4-flash",
			effective_thinking: "low",
			session_file: "/tmp/scout.jsonl",
			depth: 1,
			generation: 1,
			status: "running" as const,
		},
	];
	const agentId = summaries.at(0)?.agent_id;
	assert.ok(agentId);
	const call = renderManagementCall("send_agent", agentId, "check errors", false, summaries, renderTheme)
		.render(120)
		.join("\n");
	const asyncFollowUp = renderManagementCall(
		"followup_agent",
		agentId,
		"continue",
		false,
		summaries,
		renderTheme,
		"async",
	)
		.render(120)
		.join("\n");
	const blockingFollowUp = renderManagementCall(
		"followup_agent",
		agentId,
		"continue",
		false,
		summaries,
		renderTheme,
		"blocking",
	)
		.render(120)
		.join("\n");
	const result = renderAgentSummaries("list_agents", summaries, false, renderTheme).render(120).join("\n");

	assert.match(call, /send_agent · inspect parser · agent-1/);
	assert.match(call, /check errors/);
	assert.match(asyncFollowUp, /followup_agent · inspect parser · agent-12 · async/);
	assert.match(blockingFollowUp, /followup_agent · inspect parser · agent-12 · blocking/);
	assert.match(result, /list_agents · 1 agent/);
	assert.match(result, /inspect parser · scout · fast · opencode-go\/deepseek-v4-flash · low · agent-12 · running/);
});

test("renderWaitCall names the tasks, count, and timeout", () => {
	const summaries = [
		{
			agent_id: "agent-12345678",
			agent: "scout",
			task_name: "inspect parser",
			profile: "fast",
			model: "opencode-go/deepseek-v4-flash",
			effective_thinking: "low",
			depth: 1,
			generation: 1,
			status: "running" as const,
		},
	];
	const rendered = renderWaitCall(["agent-12345678"], 5_000, summaries, renderTheme).render(120).join("\n");

	assert.match(rendered, /waiting for 1 agent to settle · up to 5\.0s/);
	assert.match(rendered, /inspect parser · agent-1/);
});

test("renderWaitResult distinguishes settled and still-running agents", () => {
	const rendered = renderWaitResult(
		{
			elapsedMs: 1_000,
			timeoutMs: 1_000,
			summaries: [
				{
					agent_id: "done-12345678",
					agent: "scout",
					task_name: "inspect parser",
					profile: "fast",
					model: "opencode-go/deepseek-v4-flash",
					effective_thinking: "low",
					depth: 1,
					generation: 1,
					status: "idle",
					final_text: "Parser finding",
				},
				{
					agent_id: "running-12345678",
					agent: "worker",
					task_name: "fix parser",
					profile: "balanced",
					model: "opencode-go/glm-5.2",
					effective_thinking: "medium",
					depth: 1,
					generation: 1,
					status: "running",
				},
			],
		},
		false,
		renderTheme,
	)
		.render(120)
		.join("\n");

	assert.match(rendered, /1\/2 settled · 1 still running/);
	assert.match(rendered, /inspect parser · scout · fast · done-123/);
	assert.match(rendered, /fix parser · worker · balanced · running-/);
	assert.doesNotMatch(rendered, /Parser finding/);
});
