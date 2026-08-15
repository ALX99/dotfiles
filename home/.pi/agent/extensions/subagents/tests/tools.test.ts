import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { AgentWaitInterruptedError, AgentWaitTimeoutReason, type AgentSummary } from "../agent-types.ts";
import {
	AnswerAgentParamsSchema,
	createSpawnAgentSchema,
	ListAgentsParamsSchema,
	SendAgentParamsSchema,
	WaitAgentParamsSchema,
} from "../schemas.ts";
import { createManagementTools } from "../tools/management-tools.ts";
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
	const spawn = createSpawnAgentSchema({
		agents: ["scout"],
		profiles: ["fast"],
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
	});
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
	const schema = createSpawnAgentSchema({
		agents: ["scout"],
		profiles: ["fast"],
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
	});
	assert.equal(Object.hasOwn(schema.properties, "child_spawn_budget"), false);
	assert.equal(Object.hasOwn(schema.properties, "retain"), true);
	assert.equal(Check(schema, { message: "work", agent: "scout", child_spawn_budget: 0 }), false);
});

test("wait schema exposes a bounded caller-selected timeout", () => {
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["scout-1"], timeout_ms: 1 }), true);
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["scout-1"], timeout_ms: 30 * 60 * 1_000 }), true);
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["scout-1"], timeout_ms: 30 * 60 * 1_000 + 1 }), false);
});

test("list schema accepts a bounded archived-agent limit", () => {
	assert.equal(Check(ListAgentsParamsSchema, {}), true);
	assert.equal(Check(ListAgentsParamsSchema, { closed_limit: 0 }), true);
	assert.equal(Check(ListAgentsParamsSchema, { closed_limit: 32 }), true);
	assert.equal(Check(ListAgentsParamsSchema, { closed_limit: 33 }), false);
});

test("spawn guidance defers management tool names until spawn activates them", () => {
	assert.doesNotMatch(
		spawnGuidelines([], [], 1).join("\n"),
		/\b(?:answer_agent|send_agent|followup_agent|wait_agent|list_agents|read_agent_result|interrupt_agent|close_agent)\b/,
	);
});

test("spawn guidance explains compact handoffs for dependent work", () => {
	const guidance = spawnGuidelines([], [], 1).join("\n");
	assert.match(guidance, /retry, review\/fix cycle, or replacement/);
	assert.match(guidance, /does not inherit the parent transcript/);
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
					finalText: "done",
					startTime: 0,
					toolCount: 0,
					recentTools: [],
					lastMessage: "",
					lastActivityTime: 0,
					tokens: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					resultId: "a".repeat(64),
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

test("wait_agent applies one deadline to its whole wave without cancelling children", async () => {
	const signals: AbortSignal[] = [];
	const result = await executeWaitAgent(
		{ agent_ids: ["scout-1", "scout-2"], timeout_ms: 10 },
		{
			registry: {
				summary: (id: string) => ({ ...summary, agent_id: id, status: "running" }),
				wait: async (id: string, _timeout: number | undefined, signal: AbortSignal | undefined) => {
					assert.ok(signal);
					signals.push(signal);
					return new Promise((_, reject) => {
						signal.addEventListener(
							"abort",
							() =>
								reject(
									new AgentWaitInterruptedError(
										signal.reason instanceof AgentWaitTimeoutReason ? "timed_out" : "cancelled",
										id,
										signal.reason,
									),
								),
							{ once: true },
						);
					});
				},
			},
			consumeSettledCompletions: () => {},
		},
		undefined,
	);
	assert.equal(signals.length, 2);
	assert.equal(signals[0], signals[1]);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.status),
		["timed_out", "timed_out"],
	);
});

test("answer_agent preserves the exact nonblank answer for direct UI delivery", async () => {
	let delivered = "";
	const tool = createManagementTools({
		registry: {
			getLive: () => ({
				answerQuestion: async (_questionId: string, answer: string) => {
					delivered = answer;
				},
				summary: () => summary,
			}),
		},
		admission: {},
	} as never).answer_agent;
	await tool.execute(
		"call-1",
		{ agent_id: "scout-1", question_id: "question-1", answer: "  exact answer  " },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(delivered, "  exact answer  ");
});

test("list_agents includes a bounded recent closed history", async () => {
	const closed = Array.from({ length: 11 }, (_, index) => ({
		...summary,
		agent_id: `closed-${index + 1}`,
		status: "closed" as const,
	}));
	const tool = createManagementTools({
		registry: { list: () => [summary, ...closed] },
		admission: {
			capacity: () => ({
				root: { live: 2, limit: 4 },
			}),
		},
	} as never).list_agents;
	const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"root"[\s\S]*"live": 2/);
	assert.deepEqual(
		result.details?.summaries.map((agent) => agent.agent_id),
		["scout-1", ...closed.slice(1).map((agent) => agent.agent_id)],
	);
	assert.deepEqual(result.details?.capacity, {
		root: { live: 2, limit: 4 },
	});

	const completeHistory = await tool.execute("call-2", { closed_limit: 32 }, undefined, undefined, {} as never);
	assert.deepEqual(
		completeHistory.details?.summaries.map((agent) => agent.agent_id),
		["scout-1", ...closed.map((agent) => agent.agent_id)],
	);

	const noHistory = await tool.execute("call-3", { closed_limit: 0 }, undefined, undefined, {} as never);
	assert.deepEqual(
		noHistory.details?.summaries.map((agent) => agent.agent_id),
		["scout-1"],
	);
});
