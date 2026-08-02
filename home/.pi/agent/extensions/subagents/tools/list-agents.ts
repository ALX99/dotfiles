import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { ListAgentsParamsSchema } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createListAgentsTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof ListAgentsParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "list_agents",
		label: "List Agents",
		description: "List subagents owned by this session and their current status.",
		parameters: ListAgentsParamsSchema,
		registry: runtime.registry,
		resultTitle: "list_agents",
		async execute() {
			const summaries = runtime.registry.list();
			const capacity = runtime.admission.capacity();
			return jsonResult({ capacity, agents: summaries }, agentSummaryDetails(summaries, capacity));
		},
	});
}
