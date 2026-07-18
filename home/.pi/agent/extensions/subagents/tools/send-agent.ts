import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderManagementCall } from "../render.ts";
import { SendAgentParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, textResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

export function createSendAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof SendAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof SendAgentParamsSchema, AgentSummaryDetails>({
		name: "send_agent",
		label: "Send Agent",
		description: "Steer a currently running subagent at the next message boundary.",
		parameters: SendAgentParamsSchema,
		async execute(_id, params) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			const message = trimRequired(params.message, "message");
			const agent = runtime.registry.getLive(agentId);
			await agent.steer(message);
			return textResult(`Steering message accepted by ${agentId}.`, agentSummaryDetails([agent.summary()]));
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"send_agent",
				args.agent_id,
				args.message,
				context.expanded,
				runtime.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("send_agent · steering accepted", result, options, theme);
		},
	});
}
