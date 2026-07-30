import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import {
	activateForSubagentState,
	activateSubagentTools,
	resetSubagentTools,
	requiresExactResultRead,
	SUBAGENT_TOOL_NAMES,
} from "../tool-activation.ts";

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
	const api = toolApi(["read", "bash", "other_extension", "wait_agent", "answer_agent"]);
	resetSubagentTools(api as never);
	assert.deepEqual(api.active(), ["read", "bash", "other_extension", "spawn_agent"]);
	assert.equal(
		api.active().some((name) => SUBAGENT_TOOL_NAMES.includes(name as never) && name !== "spawn_agent"),
		false,
	);
});

test("activation is additive and does not rewrite an unchanged active set", () => {
	const api = toolApi(["read", "spawn_agent", "other_extension"]);
	assert.deepEqual(activateSubagentTools(api as never, ["wait_agent", "read_agent_result"]), [
		"wait_agent",
		"read_agent_result",
	]);
	assert.deepEqual(api.active(), ["read", "spawn_agent", "other_extension", "wait_agent", "read_agent_result"]);
	assert.deepEqual(activateSubagentTools(api as never, ["wait_agent"]), []);
	assert.equal(api.writes.length, 1);
});

test("spawn state activates only controls made useful by background and retained children", () => {
	const simple = toolApi(["read", "spawn_agent"]);
	assert.deepEqual(activateForSubagentState(simple as never, summary(), false), []);
	assert.deepEqual(simple.active(), ["read", "spawn_agent"]);

	const background = toolApi(["spawn_agent"]);
	activateForSubagentState(background as never, summary({ status: "running" }), true);
	assert.deepEqual(background.active(), [
		"spawn_agent",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
		"send_agent",
	]);

	const retained = toolApi(["spawn_agent"]);
	activateForSubagentState(retained as never, summary({ retained: true }), false);
	assert.deepEqual(retained.active(), [
		"spawn_agent",
		"followup_agent",
		"send_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
	]);

	const retainedBackground = toolApi(["spawn_agent"]);
	activateForSubagentState(retainedBackground as never, summary({ retained: true, status: "running" }), true);
	assert.deepEqual(retainedBackground.active(), [
		"spawn_agent",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
		"send_agent",
		"followup_agent",
	]);
});

test("routed questions and clipped results activate their matching tool", () => {
	const question = toolApi(["spawn_agent"]);
	activateForSubagentState(
		question as never,
		summary({ pending_question: { question_id: "q-1", question: "Choose", options: ["A", "B"] } }),
		false,
	);
	assert.deepEqual(question.active(), [
		"spawn_agent",
		"answer_agent",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
		"send_agent",
	]);

	const clipped = summary({
		final_text:
			"partial\n\n[Result preview; canonical 9000 byte result is persisted. Use read_agent_result with agent_id and generation 1 to page it exactly.]",
		result: {
			generation: 1,
			result_id: "a".repeat(64),
			pages: 1,
			complete: true,
			total_bytes: 9_000,
			sha256: "a".repeat(64),
			source: "pages",
		},
	});
	assert.equal(requiresExactResultRead(clipped), true);
	const result = toolApi(["spawn_agent"]);
	activateForSubagentState(result as never, clipped, false);
	assert.deepEqual(result.active(), ["spawn_agent", "read_agent_result"]);
});
