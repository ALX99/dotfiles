import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { preserveRequired, SendAgentParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, textResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createSendAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof SendAgentParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "send_agent",
		label: "Send Agent",
		description: "Steer a currently running subagent at the next message boundary.",
		parameters: SendAgentParamsSchema,
		registry: runtime.registry,
		resultTitle: "send_agent · steering accepted",
		getAgentId: (args) => args.agent_id,
		getMessage: (args) => args.message,
		async execute(_id, params) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			const message = preserveRequired(params.message, "message");
			const agent = runtime.registry.getLive(agentId);
			await agent.steer(message);
			return textResult(`Steering message accepted by ${agentId}.`, agentSummaryDetails([agent.summary()]));
		},
	});
}
