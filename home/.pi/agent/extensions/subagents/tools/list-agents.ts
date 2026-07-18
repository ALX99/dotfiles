import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderManagementCall } from "../render.ts";
import { ListAgentsParamsSchema } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

export function createListAgentsTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof ListAgentsParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof ListAgentsParamsSchema, AgentSummaryDetails>({
		name: "list_agents",
		label: "List Agents",
		description: "List subagents owned by this session and their current status.",
		parameters: ListAgentsParamsSchema,
		async execute() {
			const summaries = runtime.registry.list();
			return jsonResult(summaries, agentSummaryDetails(summaries));
		},
		renderCall(_args, theme, context) {
			return renderManagementCall(
				"list_agents",
				undefined,
				undefined,
				context.expanded,
				runtime.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("list_agents", result, options, theme);
		},
	});
}
