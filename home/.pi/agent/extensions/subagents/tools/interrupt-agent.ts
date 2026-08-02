import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agent-registry.ts";
import { AgentIdParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createInterruptAgentTool({
	registry,
}: {
	readonly registry: Pick<AgentRegistry, "list" | "getLive">;
}): ToolDefinition<typeof AgentIdParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description:
			"Abort a subagent's current run. Only agents spawned with retain:true remain eligible for follow-up work.",
		parameters: AgentIdParamsSchema,
		registry,
		resultTitle: "interrupt_agent",
		getAgentId: (args) => args.agent_id,
		async execute(_id, params) {
			const agent = registry.getLive(trimRequired(params.agent_id, "agent_id"));
			await agent.interrupt();
			const summary = agent.summary();
			return jsonResult(summary, agentSummaryDetails([summary]));
		},
	});
}
