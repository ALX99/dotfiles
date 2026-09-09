import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
	AgentsStatusParamsSchema,
	AnswerAgentParamsSchema,
	CloseAgentParamsSchema,
	FollowupAgentParamsSchema,
	MAX_WAIT_AGENTS,
	ReadAgentResultParamsSchema,
	SteerAgentParamsSchema,
	WaitAgentsParamsSchema,
	createSpawnAgentSchema,
	uniqueAgentTargets,
} from "../schemas.ts";

test("subagent tool schemas are strict and reject blank or oversized structural input", () => {
	const spawn = createSpawnAgentSchema({
		agents: ["scout", "worker"],
		profiles: ["fast", "balanced"],
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
	});
	assert.equal(Check(spawn, { message: "inspect" }), true);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect" }), true);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect", extra: true }), false);
	assert.equal(Check(spawn, { agent: "unknown", message: "inspect" }), false);
	assert.equal(Check(spawn, { agent: "scout", profile: "unknown", message: "inspect" }), false);
	assert.equal(Check(SteerAgentParamsSchema, { target: "agent-1", generation: 1, message: "focus" }), true);
	assert.equal(
		Check(SteerAgentParamsSchema, { target: "agent-1", generation: 1, message: "focus", extra: true }),
		false,
	);
	assert.equal(
		Check(AnswerAgentParamsSchema, {
			target: "agent-1",
			generation: 2,
			question_id: "q-1",
			answer: "A",
		}),
		true,
	);
	assert.equal(
		Check(AnswerAgentParamsSchema, {
			target: "agent-1",
			generation: 2,
			question_id: " ",
			answer: "A",
		}),
		false,
	);
	assert.equal(Check(FollowupAgentParamsSchema, { target: "agent-1", message: "continue" }), true);
	assert.equal(Check(CloseAgentParamsSchema, { target: "agent-1" }), true);
	assert.equal(Check(CloseAgentParamsSchema, { target: "agent-1", generation: 1 }), true);
	assert.equal(Check(AgentsStatusParamsSchema, {}), true);
	assert.equal(Check(WaitAgentsParamsSchema, { targets: [{ target: "agent-1", generation: 1 }], extra: true }), false);
	assert.equal(Check(spawn, { agent: " ", message: "inspect" }), false);
	assert.equal(Check(spawn, { agent: "scout", message: " " }), false);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect", child_spawn_budget: 0 }), false);
	assert.equal(Check(SteerAgentParamsSchema, { target: "a", generation: 1, message: "x".repeat(100_001) }), true);
});

test("spawn schema exposes configured thinking levels, retention, and no nested delegation fields", () => {
	const spawn = createSpawnAgentSchema({
		agents: ["scout"],
		profiles: ["fast"],
		thinkingLevels: ["low", "high"],
	});
	const schemaJson = JSON.parse(JSON.stringify(spawn)) as {
		properties: { thinking: { enum: string[] } };
	};
	assert.deepEqual(schemaJson.properties.thinking.enum, ["low", "high"]);
	assert.equal(Object.hasOwn(spawn.properties, "child_spawn_budget"), false);
	assert.equal(Object.hasOwn(spawn.properties, "retain"), true);
	assert.equal(Check(spawn, { agent: "scout", profile: "fast", message: "inspect" }), true);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect", child_spawn_budget: 0 }), false);
});

test("spawn defaults the role so the easy call is message-only", () => {
	const spawn = createSpawnAgentSchema({
		agents: ["scout", "worker"],
		profiles: ["fast"],
		thinkingLevels: ["low"],
	});
	assert.equal(Check(spawn, { message: "inspect" }), true);
	const schemaJson = JSON.parse(JSON.stringify(spawn)) as {
		properties: { agent: { description: string } };
	};
	assert.match(schemaJson.properties.agent.description, /Defaults to 'scout'/);
});

test("wait schema bounds input and duplicate normalization is stable after trimming", () => {
	assert.equal(Check(WaitAgentsParamsSchema, { targets: [] }), false);
	assert.equal(
		Check(WaitAgentsParamsSchema, {
			targets: Array.from({ length: MAX_WAIT_AGENTS + 1 }, (_, index) => ({
				target: `agent-${index}`,
				generation: 1,
			})),
		}),
		false,
	);
	assert.equal(Check(WaitAgentsParamsSchema, { targets: [{ target: "agent-1" }] }), true);
	assert.deepEqual(
		uniqueAgentTargets([
			{ target: " agent-2 ", generation: 1 },
			{ target: "agent-1", generation: 2 },
			{ target: "agent-2", generation: 1 },
			{ target: "agent-1" },
		]),
		[{ target: "agent-2", generation: 1 }, { target: "agent-1", generation: 2 }, { target: "agent-1" }],
	);
});

test("steer and answer require a generation while other verbs default to latest", () => {
	assert.equal(Check(SteerAgentParamsSchema, { target: "a-1", message: "go" }), false);
	assert.equal(Check(AnswerAgentParamsSchema, { target: "a-1", generation: 1, answer: "yes" }), false);
	assert.equal(
		Check(AnswerAgentParamsSchema, {
			target: "a-1",
			generation: 1,
			question_id: "q-1",
			answer: "yes",
			message: "extra",
		}),
		false,
	);
	assert.equal(Check(FollowupAgentParamsSchema, { target: "a-1", generation: 1, message: "go" }), false);
	assert.equal(Check(CloseAgentParamsSchema, { target: "a-1", message: "go" }), false);
});

test("read defaults to the latest generation and keeps cursor and offset mutually exclusive", () => {
	assert.equal(Check(ReadAgentResultParamsSchema, { target: "a-1" }), true);
	assert.equal(Check(ReadAgentResultParamsSchema, { target: "a-1", generation: 1 }), true);
	assert.equal(Check(ReadAgentResultParamsSchema, { target: "a-1", generation: 1, offset: 0 }), true);
	assert.equal(Check(ReadAgentResultParamsSchema, { target: "a-1", generation: 1, cursor: "v1.a.0" }), true);
	assert.equal(Check(ReadAgentResultParamsSchema, { target: "a-1", generation: 0 }), false);
	assert.equal(
		Check(ReadAgentResultParamsSchema, { target: "a-1", generation: 1, cursor: "v1.a.0", offset: 0 }),
		false,
	);
});
