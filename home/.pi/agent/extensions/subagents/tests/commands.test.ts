import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import { registerSubagentsCommand } from "../index.ts";
import { SubagentToolController } from "../tool-activation.ts";

function summary(overrides: Partial<AgentSummary> = {}): AgentSummary {
	return {
		agent_id: "worker-1",
		agent: "worker",
		task_name: "test",
		profile: "balanced",
		model: "provider/model",
		effective_thinking: "medium",
		generation: 1,
		retained: false,
		status: "running",
		started_at: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		...overrides,
	};
}

test("/subagents toggles every subagent tool and restores catalog-backed tools when re-enabled", async () => {
	let activeTools = ["read", "spawn_agent", "wait_agent"];
	let command:
		| {
				description?: string;
				handler(args: string, ctx: unknown): Promise<void>;
		  }
		| undefined;
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
		registerCommand: (name: string, registered: NonNullable<typeof command>) => {
			assert.equal(name, "subagents");
			command = registered;
		},
	};
	const tools = new SubagentToolController(pi);
	registerSubagentsCommand(pi as never, tools, {
		registry: {
			hasStoredResults: () => true,
			list: () => [summary(), summary({ agent_id: "worker-2", status: "closed" })],
		},
	});
	assert.match(command?.description ?? "", /enabled by default/u);

	const notifications: string[] = [];
	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
		},
	};
	await command!.handler("", ctx);
	assert.equal(tools.enabled, false);
	assert.deepEqual(activeTools, ["read"]);

	tools.activate(["read_agent_result"]);
	tools.activateForState(summary(), true);
	assert.deepEqual(activeTools, ["read"], "deferred events must not bypass the disabled state");

	await command!.handler("", ctx);
	assert.equal(tools.enabled, true);
	assert.deepEqual(activeTools, [
		"read",
		"spawn_agent",
		"read_agent_result",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
		"send_agent",
	]);
	assert.match(notifications[0] ?? "", /disabled/u);
	assert.match(notifications[1] ?? "", /enabled/u);
});
