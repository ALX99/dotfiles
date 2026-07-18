import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderManagementCall } from "../render.ts";
import { AgentIdParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

export function createCloseAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof AgentIdParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof AgentIdParamsSchema, AgentSummaryDetails>({
		name: "close_agent",
		label: "Close Agent",
		description: "Terminate a subagent process. Closed agents cannot be resumed.",
		parameters: AgentIdParamsSchema,
		async execute(_id, params) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			await runtime.registry.close(agentId);
			const summary = runtime.registry.get(agentId).summary();
			return jsonResult(summary, agentSummaryDetails([summary]));
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"close_agent",
				args.agent_id,
				undefined,
				context.expanded,
				runtime.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("close_agent", result, options, theme);
		},
	});
}
