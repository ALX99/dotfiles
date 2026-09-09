import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedAgentTarget } from "../agent-registry.ts";
import { assertCurrentGeneration, type AgentSummary } from "../agent-types.ts";
import { renderManagementCall } from "../render.ts";
import { CloseAgentParamsSchema, type CloseAgentParams } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

interface CloseAgentDependencies {
	readonly registry: {
		readonly resolveGeneration: (target: string, generation?: number) => ResolvedAgentTarget;
		readonly summary: (id: string) => AgentSummary;
		readonly list: () => AgentSummary[];
		readonly close: (id: string) => Promise<void>;
	};
}

export function createCloseAgentTool(
	dependencies: CloseAgentDependencies,
): ToolDefinition<typeof CloseAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof CloseAgentParamsSchema, AgentSummaryDetails>({
		name: "close_agent",
		label: "Close Agent",
		description:
			"Release a child in one step: a running generation is aborted (acknowledged only after cleanup), then disposed. Generation defaults to latest; persisted results stay readable.",
		parameters: CloseAgentParamsSchema,
		async execute(_id, params: CloseAgentParams) {
			const resolved = dependencies.registry.resolveGeneration(params.target, params.generation);
			if (params.generation !== undefined) assertCurrentGeneration(resolved.summary, params.generation);
			await dependencies.registry.close(resolved.agent_id);
			const closed = dependencies.registry.summary(resolved.agent_id);
			return jsonResult(closed, agentSummaryDetails([closed]));
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"close_agent",
				args.target,
				undefined,
				context.expanded,
				dependencies.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("close_agent", result, options, theme);
		},
	});
}
