import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import type { AgentSummary } from "../agent-types.ts";
import {
	AnswerAgentParamsSchema,
	createSpawnAgentSchema,
	SendAgentParamsSchema,
	WaitAgentParamsSchema,
} from "../schemas.ts";
import { createAnswerAgentTool } from "../tools/answer-agent.ts";
import { createListAgentsTool } from "../tools/list-agents.ts";
import { spawnGuidelines } from "../tools/spawn-agent.ts";
import { executeWaitAgent } from "../tools/wait-agent.ts";

const summary: AgentSummary = {
	agent_id: "scout-1",
	agent: "scout",
	task_name: "inspect",
	profile: "fast",
	model: "provider/model",
	effective_thinking: "low",
	generation: 1,
	retained: false,
	status: "idle",
	started_at: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

test("semantic message, handoff, and answer fields have no arbitrary character cap", () => {
	const spawn = createSpawnAgentSchema({ agents: ["scout"], profiles: ["fast"] });
	const large = "界".repeat(200_000);
	assert.equal(Check(spawn, { message: large, handoff: large, agent: "scout" }), true);
	assert.equal(Check(SendAgentParamsSchema, { agent_id: "scout-1", message: large }), true);
	assert.equal(
		Check(AnswerAgentParamsSchema, {
			agent_id: "scout-1",
			question_id: "question-1",
			answer: large,
		}),
		true,
	);
});

test("spawn schema rejects removed nested budgets and exposes explicit retention", () => {
	const schema = createSpawnAgentSchema({ agents: ["scout"], profiles: ["fast"] });
	assert.equal(Object.hasOwn(schema.properties, "child_spawn_budget"), false);
	assert.equal(Object.hasOwn(schema.properties, "retain"), true);
	assert.equal(Check(schema, { message: "work", agent: "scout", child_spawn_budget: 0 }), false);
});

test("wait schema exposes a bounded caller-selected timeout", () => {
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["scout-1"], timeout_ms: 1 }), true);
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["scout-1"], timeout_ms: 30 * 60 * 1_000 }), true);
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["scout-1"], timeout_ms: 30 * 60 * 1_000 + 1 }), false);
});

test("spawn guidance defers management tool names until spawn activates them", () => {
	assert.doesNotMatch(
		spawnGuidelines([], [], 1, 1).join("\n"),
		/\b(?:answer_agent|send_agent|followup_agent|wait_agent|list_agents|read_agent_result|interrupt_agent|close_agent)\b/,
	);
});

test("wait_agent trims a wave, forwards its timeout, and consumes matching delivery once", async () => {
	const waits: Array<{ id: string; timeout?: number }> = [];
	const consumed: AgentSummary[][] = [];
	const runtime = {
		registry: {
			summary: () => summary,
			wait: async (id: string, timeout?: number) => {
				waits.push({ id, ...(timeout === undefined ? {} : { timeout }) });
				return {
					agent: "scout",
					taskName: "inspect",
					profile: "fast",
					model: "provider/model",
					effectiveThinking: "low",
					exitCode: 0,
					finalText: "done",
					stderr: "",
					startTime: 0,
					toolCount: 0,
					mutationToolCalls: 0,
					recentTools: [],
					lastMessage: "",
					tokens: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					resultId: "a".repeat(64),
					omittedTelemetryRecords: 0,
					aborted: false,
				};
			},
		},
		consumeSettledCompletions: (summaries: readonly AgentSummary[]) => {
			consumed.push([...summaries]);
		},
	};
	await executeWaitAgent({ agent_ids: [" scout-1 ", "scout-1"], timeout_ms: 321 }, runtime, undefined, () => 0);
	assert.deepEqual(waits, [{ id: "scout-1", timeout: 321 }]);
	assert.deepEqual(consumed, [[summary]]);
});

test("answer_agent preserves the exact nonblank answer for direct UI delivery", async () => {
	let delivered = "";
	const tool = createAnswerAgentTool({
		registry: {
			getLive: () => ({
				answerQuestion: async (_questionId: string, answer: string) => {
					delivered = answer;
				},
				summary: () => summary,
			}),
		},
	} as never);
	await tool.execute(
		"call-1",
		{ agent_id: "scout-1", question_id: "question-1", answer: "  exact answer  " },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(delivered, "  exact answer  ");
});

test("list_agents exposes compact root and deep live capacity", async () => {
	const tool = createListAgentsTool({
		registry: { list: () => [summary] },
		admission: {
			capacity: () => ({
				root: { live: 2, limit: 4 },
				deep: { live: 1, limit: 1 },
			}),
		},
	} as never);
	const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"root"[\s\S]*"live": 2/);
	assert.deepEqual(result.details?.capacity, {
		root: { live: 2, limit: 4 },
		deep: { live: 1, limit: 1 },
	});
});
