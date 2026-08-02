import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { AgentIdParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createCloseAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof AgentIdParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "close_agent",
		label: "Close Agent",
		description:
			"Terminate a retained subagent process. The call is idempotent for archived agents; persisted result/session references remain readable.",
		parameters: AgentIdParamsSchema,
		registry: runtime.registry,
		resultTitle: "close_agent",
		getAgentId: (args) => args.agent_id,
		async execute(_id, params) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			await runtime.registry.close(agentId);
			const summary = runtime.registry.summary(agentId);
			return jsonResult(summary, agentSummaryDetails([summary]));
		},
	});
}
