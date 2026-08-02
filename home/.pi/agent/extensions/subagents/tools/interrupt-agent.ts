import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { AgentIdParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createInterruptAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof AgentIdParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description:
			"Abort a subagent's current run. Only agents spawned with retain:true remain eligible for follow-up work.",
		parameters: AgentIdParamsSchema,
		registry: runtime.registry,
		resultTitle: "interrupt_agent",
		getAgentId: (args) => args.agent_id,
		async execute(_id, params) {
			const agent = runtime.registry.getLive(trimRequired(params.agent_id, "agent_id"));
			await agent.interrupt();
			const summary = agent.summary();
			return jsonResult(summary, agentSummaryDetails([summary]));
		},
	});
}
