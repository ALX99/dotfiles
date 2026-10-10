import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Check } from "typebox/value";

import type { ApplicationEffects } from "../../application.ts";
import type { AgentInspection } from "../inspection.ts";
import { registerAgentWorkflowTools } from "../register.ts";
import { registerAgentTools, SendAgentParams, SpawnAgentParams } from "../tools.ts";
import type { AgentToolHandlers } from "../tools.ts";
import type { AgentEventResult, AgentWorkflows } from "../workflows.ts";

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

function workflowTools(
	events: readonly AgentEventResult[],
	inspections: readonly AgentInspection[],
	inspectedAgents: string[],
): Map<string, ToolDefinition> {
	const byAgent = new Map(inspections.map((inspection) => [inspection.agent, inspection]));
	const workflows = {
		waitAgent: () => Effect.succeed(events),
		waitAgentInspections: () =>
			Effect.sync(() =>
				[...new Set(events.map((event) => event.agent))].map((agent) => {
					inspectedAgents.push(agent);
					const inspection = byAgent.get(agent);
					assert.ok(inspection, `an inspection exists for ${agent}`);
					return inspection;
				}),
			),
		inspectAgent: (agent: string) => {
			inspectedAgents.push(agent);
			const inspection = byAgent.get(agent);
			assert.ok(inspection, `an inspection exists for ${agent}`);
			return Effect.succeed(inspection);
		},
	} as unknown as AgentWorkflows;
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on() {
			return () => undefined;
		},
		registerTool(definition: ToolDefinition) {
			tools.set(definition.name, definition);
		},
	} as unknown as ExtensionAPI;
	const applicationEffects: ApplicationEffects = {
		run: (effect, options) => Effect.runPromise(effect, options),
		initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
	};

	registerAgentWorkflowTools(pi, () => workflows, applicationEffects);
	return tools;
}

function agentInspection(agent: string): AgentInspection {
	return {
		agent,
		profile: "engineer",
		status: "settled",
		cwd: `/workspace/${agent}`,
		latest_events: [{ age: "1s ago", type: "output", content: `Summary: Finished ${agent}.` }],
	};
}

async function executeWaitTool(
	tools: ReadonlyMap<string, ToolDefinition>,
	agents: readonly string[],
): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
	const wait = tools.get("wait_agent");
	assert.ok(wait);
	return wait.execute("wait-call", { agents }, undefined, undefined, {} as ExtensionToolContext);
}

test("registers only the existing orchestration tools and exposes ask_parent only to child runtimes", () => {
	const parent = registeredTools(false);
	assert.deepEqual(
		[...parent.keys()],
		["spawn_agent", "wait_agent", "send_agent", "answer_agent", "cancel_agent", "list_agents", "inspect_agent"],
	);
	assert.equal(parent.has("ask_parent"), false);
	assert.match(parent.get("wait_agent")?.description ?? "", /already terminal/u);

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

test("wait_agent returns the single child's inspection snapshot directly", async () => {
	const worker = agentInspection("engineer-agent-1");
	const inspectedAgents: string[] = [];
	const tools = workflowTools([{ agent: worker.agent, event: "settled" }], [worker], inspectedAgents);
	const waited = await executeWaitTool(tools, [worker.agent]);
	const inspected = await tools
		.get("inspect_agent")!
		.execute("inspect-call", { agent: worker.agent }, undefined, undefined, {} as ExtensionToolContext);

	assert.deepEqual(waited.details, [inspected.details]);
	assert.deepEqual(waited.details, [worker]);
	assert.deepEqual(inspectedAgents, [worker.agent, worker.agent]);
});

test("wait_agent returns unique waiting-parent and settled snapshots", async () => {
	const waiting = {
		...agentInspection("engineer-agent-1"),
		status: "waiting_parent",
		latest_events: [{ age: "1s ago", type: "ask_parent", message: "Need a decision." }],
	} satisfies AgentInspection;
	const settled = agentInspection("researcher-agent-1");
	const inspectedAgents: string[] = [];
	const tools = workflowTools(
		[
			{ agent: waiting.agent, event: "parent_request", message: "Earlier question." },
			{ agent: waiting.agent, event: "parent_request", message: "Need a decision." },
			{ agent: settled.agent, event: "settled" },
		],
		[waiting, settled],
		inspectedAgents,
	);

	const waited = await executeWaitTool(tools, [waiting.agent, settled.agent]);

	assert.deepEqual(waited.details, [waiting, settled]);
	assert.deepEqual(inspectedAgents, [waiting.agent, settled.agent]);
	assert.equal(Array.isArray(waited.details), true);
	assert.equal("events" in (waited.details as object), false);
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
