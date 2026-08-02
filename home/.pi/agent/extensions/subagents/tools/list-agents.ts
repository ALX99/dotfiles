import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agent-registry.ts";
import type { SpawnAdmissionController } from "../spawn-admission.ts";
import { ListAgentsParamsSchema } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createListAgentsTool({
	registry,
	admission,
}: {
	readonly registry: Pick<AgentRegistry, "list">;
	readonly admission: Pick<SpawnAdmissionController, "capacity">;
}): ToolDefinition<typeof ListAgentsParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "list_agents",
		label: "List Agents",
		description: "List subagents owned by this session and their current status.",
		parameters: ListAgentsParamsSchema,
		registry,
		resultTitle: "list_agents",
		async execute() {
			const summaries = registry.list();
			const capacity = admission.capacity();
			return jsonResult({ capacity, agents: summaries }, agentSummaryDetails(summaries, capacity));
		},
	});
}
