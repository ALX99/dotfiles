import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import {
	activateForSubagentState,
	activateSubagentTools,
	deactivateSubagentTools,
	missingSubagentTools,
	resetSubagentTools,
	requiresExactResultRead,
	SUBAGENT_TOOL_NAMES,
	SubagentToolController,
} from "../tool-activation.ts";
import { resultPreview } from "../result-store.ts";

function summary(overrides: Partial<AgentSummary> = {}): AgentSummary {
	return {
		agent_id: "agent-1",
		agent: "worker",
		task_name: "test",
		profile: "balanced",
		model: "provider/model",
		effective_thinking: "medium",
		generation: 1,
		retained: false,
		status: "idle",
		started_at: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		...overrides,
	};
}

function toolApi(initial: readonly string[]) {
	let active = [...initial];
	const writes: string[][] = [];
	return {
		getActiveTools: () => [...active],
		setActiveTools: (next: string[]) => {
			active = [...next];
			writes.push([...next]);
		},
		active: () => active,
		writes,
	};
}

test("session initialization retains non-subagent tools and leaves only spawn_agent active", () => {
	const api = toolApi(["read", "bash", "other_extension", "wait_agents", "steer_agent"]);
	resetSubagentTools(api as never);
	assert.deepEqual(api.active(), ["read", "bash", "other_extension", "spawn_agent"]);
	assert.equal(
		api.active().some((name) => SUBAGENT_TOOL_NAMES.includes(name as never) && name !== "spawn_agent"),
		false,
	);
});

test("subagent tool controller defaults on and gates activation while disabled", () => {
	const api = toolApi(["read", "spawn_agent", "wait_agents", "other_extension"]);
	const controller = new SubagentToolController(api);
	assert.equal(controller.enabled, true);

	assert.equal(controller.toggle(), false);
	assert.deepEqual(api.active(), ["read", "other_extension"]);
	assert.deepEqual(controller.activate(["read_agent_result"]), []);
	assert.deepEqual(controller.activateForState(summary({ status: "running" })), []);
	assert.deepEqual(api.active(), ["read", "other_extension"]);

	assert.equal(controller.toggle(), true);
	assert.deepEqual(api.active(), ["read", "other_extension", "spawn_agent"]);
	controller.activate(["read_agent_result"]);
	assert.deepEqual(api.active(), ["read", "other_extension", "spawn_agent", "read_agent_result"]);
});

test("deactivation is scoped to subagent tools and avoids an unchanged rewrite", () => {
	const api = toolApi(["read", "wait_agents", "other_extension"]);
	deactivateSubagentTools(api);
	assert.deepEqual(api.active(), ["read", "other_extension"]);
	deactivateSubagentTools(api);
	assert.equal(api.writes.length, 1);
});

test("deferred tool diagnostics detect host allowlist filtering", () => {
	const complete = {
		getAllTools: () => SUBAGENT_TOOL_NAMES.map((name) => ({ name })),
	};
	assert.deepEqual(missingSubagentTools(complete as never), []);
	assert.deepEqual(
		missingSubagentTools({ getAllTools: () => [{ name: "spawn_agent" }, { name: "read_agent_result" }] } as never),
		["followup_agent", "steer_agent", "answer_agent", "wait_agents", "agents_status", "close_agent"],
	);
});

test("activation is additive, ignores non-subagent names, and does not rewrite an unchanged active set", () => {
	const api = toolApi(["read", "spawn_agent", "other_extension"]);
	assert.deepEqual(activateSubagentTools(api as never, ["read", "wait_agents", "read_agent_result"]), [
		"wait_agents",
		"read_agent_result",
	]);
	assert.deepEqual(api.active(), ["read", "spawn_agent", "other_extension", "wait_agents", "read_agent_result"]);
	assert.deepEqual(activateSubagentTools(api as never, ["read", "wait_agents"]), []);
	assert.equal(api.writes.length, 1);
});

test("spawn state activates only controls valid for each lifecycle state", () => {
	const simple = toolApi(["read", "spawn_agent"]);
	assert.deepEqual(activateForSubagentState(simple as never, summary()), []);
	assert.deepEqual(simple.active(), ["read", "spawn_agent"]);

	const running = toolApi(["spawn_agent"]);
	activateForSubagentState(running as never, summary({ status: "running" }));
	assert.deepEqual(running.active(), [
		"spawn_agent",
		"wait_agents",
		"steer_agent",
		"answer_agent",
		"close_agent",
		"agents_status",
	]);

	const retained = toolApi(["spawn_agent"]);
	activateForSubagentState(retained as never, summary({ retained: true }));
	assert.deepEqual(retained.active(), ["spawn_agent", "followup_agent", "close_agent", "agents_status"]);

	const retainedRunning = toolApi(["spawn_agent"]);
	activateForSubagentState(retainedRunning as never, summary({ retained: true, status: "running" }));
	assert.deepEqual(retainedRunning.active(), [
		"spawn_agent",
		"wait_agents",
		"steer_agent",
		"answer_agent",
		"close_agent",
		"agents_status",
	]);
});

test("routed questions omit invalid steering and oversized results activate exact reading", () => {
	const question = toolApi(["spawn_agent"]);
	activateForSubagentState(
		question as never,
		summary({ pending_question: { question_id: "q-1", question: "Choose", options: ["A", "B"] } }),
	);
	assert.deepEqual(question.active(), [
		"spawn_agent",
		"wait_agents",
		"steer_agent",
		"answer_agent",
		"close_agent",
		"agents_status",
	]);

	const oversizedText = "x".repeat(50 * 1024);
	const oversized = summary({
		final_text: resultPreview(oversizedText),
		result: {
			generation: 1,
			result_id: "a".repeat(64),
			complete: true,
			total_bytes: Buffer.byteLength(oversizedText, "utf8"),
		},
	});
	assert.equal(requiresExactResultRead(oversized), true);
	const result = toolApi(["spawn_agent"]);
	activateForSubagentState(result as never, oversized);
	assert.deepEqual(result.active(), ["spawn_agent", "read_agent_result"]);
});

test("complete small results do not activate exact reading", () => {
	const result = toolApi(["spawn_agent"]);
	activateForSubagentState(
		result as never,
		summary({
			final_text: "small preview",
			result: {
				generation: 1,
				result_id: "a".repeat(64),
				complete: true,
				total_bytes: 13,
			},
		}),
	);
	assert.equal(
		requiresExactResultRead(
			summary({
				final_text: "small result",
				result: {
					generation: 1,
					result_id: "a".repeat(64),
					complete: true,
					total_bytes: 12,
				},
			}),
		),
		false,
	);
	assert.deepEqual(result.active(), ["spawn_agent"]);
});
