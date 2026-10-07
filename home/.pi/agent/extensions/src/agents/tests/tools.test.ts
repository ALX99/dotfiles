import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import { registerAgentTools, SendAgentParams, SpawnAgentParams } from "../tools.ts";
import type { AgentToolHandlers } from "../tools.ts";

const success = { content: [{ type: "text" as const, text: "ok" }], details: undefined };
const handler = async () => success;

function registeredTools(
	includeAskParent: boolean,
	allowedSpawnProfiles?: readonly string[],
): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const handlers: AgentToolHandlers = {
		spawn: handler,
		wait: handler,
		send: handler,
		answer: handler,
		cancel: handler,
		list: handler,
		inspect: handler,
		...(includeAskParent ? { askParent: handler } : {}),
	};
	const pi = {
		on() {
			return () => undefined;
		},
		registerTool(definition: ToolDefinition) {
			tools.set(definition.name, definition);
		},
	} as unknown as ExtensionAPI;
	registerAgentTools(pi, handlers, allowedSpawnProfiles);
	return tools;
}

test("registers the orchestration tools and exposes ask_parent only to child runtimes", () => {
	const parent = registeredTools(false);
	assert.deepEqual(
		[...parent.keys()],
		["spawn_agent", "wait_agent", "send_agent", "answer_agent", "cancel_agent", "list_agents", "inspect_agent"],
	);
	assert.equal(parent.has("ask_parent"), false);

	const child = registeredTools(true);
	assert.deepEqual(
		[...child.keys()],
		[
			"spawn_agent",
			"wait_agent",
			"send_agent",
			"ask_parent",
			"answer_agent",
			"cancel_agent",
			"list_agents",
			"inspect_agent",
		],
	);
});

test("tool schemas express spawn and send modes without exposing environment configuration", () => {
	assert.equal(
		Check(SpawnAgentParams, {
			profile: "engineer",
			message: "Implement the handler.",
			cwd: "/repo",
			mode: "wait",
		}),
		true,
	);
	assert.equal(
		Check(SpawnAgentParams, {
			profile: "engineer",
			message: "Implement the handler.",
			env: { TOKEN: "secret" },
		}),
		false,
	);
	assert.equal(Check(SendAgentParams, { agent: "engineer-agent-1", message: "Use the API path." }), true);
	assert.equal(
		Check(SendAgentParams, {
			agent: "engineer-agent-1",
			message: "Use the API path.",
			mode: "interrupt",
		}),
		true,
	);
	assert.equal(Check(SendAgentParams, { agent: "engineer-agent-1", message: "Use the API path.", wait: true }), true);
	assert.equal(Check(SendAgentParams, { agent: "engineer-agent-1", message: "Use the API path.", wait: false }), true);
	assert.equal(
		Check(SendAgentParams, { agent: "engineer-agent-1", message: "Use the API path.", mode: "queue" }),
		false,
	);
	assert.equal(
		Check(SendAgentParams, { agent: "engineer-agent-1", message: "Use the API path.", wait: "true" }),
		false,
	);
});

test("spawn_agent schema exposes only permitted profile names and omits the tool for a deny-all policy", () => {
	const restricted = registeredTools(false, ["engineer", "researcher"]).get("spawn_agent");
	assert.ok(restricted);
	assert.equal(Check(restricted.parameters, { profile: "engineer", message: "Implement the handler." }), true);
	assert.equal(Check(restricted.parameters, { profile: "researcher", message: "Research the API." }), true);
	assert.equal(Check(restricted.parameters, { profile: "designer", message: "Design the screen." }), false);

	assert.equal(registeredTools(false, []).has("spawn_agent"), false);
	assert.equal(Check(SpawnAgentParams, { profile: "designer", message: "Design the screen." }), true);
});
