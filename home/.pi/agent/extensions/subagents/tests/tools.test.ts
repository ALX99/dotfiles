import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import { initRunState, snapshotRunState } from "../run-state.ts";
import { DEFAULT_WAIT_MS, executeWaitAgent } from "../tools/wait-agent.ts";

function summary(id: string): AgentSummary {
	return {
		agent_id: id,
		agent: "scout",
		task_name: "inspect",
		profile: "fast",
		model: "provider/model",
		effective_thinking: "low",
		depth: 1,
		generation: 1,
		status: "idle",
	};
}

test("wait_agent trims and deduplicates IDs before lookup, waiting, and completion consumption", async () => {
	const lookups: string[] = [];
	const waits: Array<{ id: string; timeout: number | undefined }> = [];
	let consumed: readonly AgentSummary[] = [];
	const details = snapshotRunState(
		initRunState({
			agent: { name: "scout", description: "Scout", systemPrompt: "Scout", filePath: "scout.md" },
			taskName: "inspect",
			profile: "fast",
			model: "provider/model",
			effectiveThinking: "low",
			parentDepth: 0,
		}),
		"idle",
	);
	const runtime = {
		registry: {
			get(id: string) {
				lookups.push(id);
				return {
					async wait(timeout: number | undefined) {
						waits.push({ id, timeout });
						return details;
					},
					summary: () => summary(id),
				};
			},
		},
		consumeSettledCompletions(summaries: readonly AgentSummary[]) {
			consumed = summaries;
		},
	};
	const times = [100, 145];
	const result = await executeWaitAgent(
		{ agent_ids: [" agent-1 ", "agent-1", "agent-2"] },
		runtime,
		undefined,
		() => times.shift() ?? 145,
	);

	assert.deepEqual(lookups, ["agent-1", "agent-2"]);
	assert.deepEqual(waits, [
		{ id: "agent-1", timeout: DEFAULT_WAIT_MS },
		{ id: "agent-2", timeout: DEFAULT_WAIT_MS },
	]);
	assert.deepEqual(
		consumed.map((item) => item.agent_id),
		["agent-1", "agent-2"],
	);
	assert.equal(result.details?.elapsedMs, 45);
});
