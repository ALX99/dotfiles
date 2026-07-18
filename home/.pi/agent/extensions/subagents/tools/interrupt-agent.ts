import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderManagementCall } from "../render.ts";
import { AgentIdParamsSchema, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

export function createInterruptAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof AgentIdParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof AgentIdParamsSchema, AgentSummaryDetails>({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description: "Abort a subagent's current run while retaining it for follow-up work.",
		parameters: AgentIdParamsSchema,
		async execute(_id, params) {
			const agent = runtime.registry.getLive(trimRequired(params.agent_id, "agent_id"));
			await agent.interrupt();
			const summary = agent.summary();
			return jsonResult(summary, agentSummaryDetails([summary]));
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"interrupt_agent",
				args.agent_id,
				undefined,
				context.expanded,
				runtime.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("interrupt_agent", result, options, theme);
		},
	});
}
