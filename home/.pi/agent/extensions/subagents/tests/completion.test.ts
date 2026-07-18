import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import { isCompletionSuperseded } from "../index.ts";

function summary(generation: number, status: AgentSummary["status"] = "idle"): AgentSummary {
	return {
		agent_id: "agent-1",
		agent: "scout",
		task_name: "test",
		profile: "fast",
		model: "opencode-go/deepseek-v4-flash",
		effective_thinking: "low",
		depth: 1,
		generation,
		status,
	};
}

test("new generations and closed agents supersede queued completions", () => {
	assert.equal(isCompletionSuperseded(summary(1), summary(2, "running")), true);
	assert.equal(isCompletionSuperseded(summary(1), summary(1, "closed")), true);
	assert.equal(isCompletionSuperseded(summary(2), summary(2, "idle")), false);
	assert.equal(isCompletionSuperseded(summary(1), { ...summary(2), agent_id: "agent-2" }), false);
});
