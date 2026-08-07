import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agent-registry.ts";
import type { SpawnAdmissionController } from "../spawn-admission.ts";
import { ListAgentsParamsSchema } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

const DEFAULT_CLOSED_AGENT_LIMIT = 10;

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
		description:
			"List subagents owned by this session and their current status. Includes the 10 most-recent archived agents by default; set closed_limit to request more or none.",
		parameters: ListAgentsParamsSchema,
		registry,
		resultTitle: "list_agents",
		async execute(_id, params) {
			const limit = params.closed_limit ?? DEFAULT_CLOSED_AGENT_LIMIT;
			const summaries = registry.list();
			const live = summaries.filter((summary) => summary.status !== "closed");
			const closed = limit === 0 ? [] : summaries.filter((summary) => summary.status === "closed").slice(-limit);
			const capacity = admission.capacity();
			return jsonResult(
				{ capacity, agents: [...live, ...closed] },
				agentSummaryDetails([...live, ...closed], capacity),
			);
		},
	});
}
