import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
	AnswerAgentParamsSchema,
	MAX_WAIT_AGENTS,
	SendAgentParamsSchema,
	WaitAgentParamsSchema,
	createSpawnAgentSchema,
	uniqueAgentIds,
} from "../schemas.ts";

test("subagent tool schemas are strict and reject blank or oversized structural input", () => {
	const spawn = createSpawnAgentSchema({
		agents: ["scout", "worker"],
		profiles: ["fast", "balanced"],
	});
	assert.equal(Check(spawn, { agent: "scout", message: "inspect" }), true);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect", extra: true }), false);
	assert.equal(Check(spawn, { agent: "unknown", message: "inspect" }), false);
	assert.equal(Check(spawn, { agent: "scout", profile: "unknown", message: "inspect" }), false);
	assert.equal(Check(SendAgentParamsSchema, { agent_id: "agent-1", message: "inspect", extra: true }), false);
	assert.equal(Check(AnswerAgentParamsSchema, { agent_id: "agent-1", question_id: "question-1", answer: "A" }), true);
	assert.equal(Check(AnswerAgentParamsSchema, { agent_id: "agent-1", question_id: " ", answer: "A" }), false);
	assert.equal(
		Check(AnswerAgentParamsSchema, {
			agent_id: "agent-1",
			question_id: "question-1",
			answer: "A",
			extra: true,
		}),
		false,
	);
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: ["agent-1"], extra: true }), false);
	assert.equal(Check(spawn, { agent: " ", message: "inspect" }), false);
	assert.equal(Check(spawn, { agent: "scout", message: " " }), false);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect", child_spawn_budget: 0 }), false);
	assert.equal(Check(SendAgentParamsSchema, { agent_id: "a", message: "x".repeat(100_001) }), true);
});

test("spawn schema exposes one-shot retention and no nested delegation fields", () => {
	const spawn = createSpawnAgentSchema({ agents: ["scout"], profiles: ["fast"] });
	assert.equal(Object.hasOwn(spawn.properties, "child_spawn_budget"), false);
	assert.equal(Object.hasOwn(spawn.properties, "retain"), true);
	assert.equal(Check(spawn, { agent: "scout", profile: "fast", message: "inspect" }), true);
	assert.equal(Check(spawn, { agent: "scout", message: "inspect", child_spawn_budget: 0 }), false);
});

test("wait schema bounds input and duplicate normalization is stable after trimming", () => {
	assert.equal(Check(WaitAgentParamsSchema, { agent_ids: [] }), false);
	assert.equal(
		Check(WaitAgentParamsSchema, {
			agent_ids: Array.from({ length: MAX_WAIT_AGENTS + 1 }, (_, index) => `agent-${index}`),
		}),
		false,
	);
	assert.deepEqual(uniqueAgentIds([" agent-2 ", "agent-1", "agent-2", " agent-1 "]), ["agent-2", "agent-1"]);
});
