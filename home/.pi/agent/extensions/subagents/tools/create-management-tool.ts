import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agent-registry.ts";
import { renderManagementCall } from "../render.ts";
import type { AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

type ManagementRegistry = Pick<AgentRegistry, "list">;

type ManagementToolArgs<TParams extends ToolDefinition["parameters"]> = Parameters<
	NonNullable<ToolDefinition<TParams>["renderCall"]>
>[0];

interface ManagementToolOptions<TParams extends ToolDefinition["parameters"], TDetails extends AgentSummaryDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TParams;
	readonly registry: ManagementRegistry;
	readonly resultTitle: string;
	readonly getAgentId?: (args: ManagementToolArgs<TParams>) => string | undefined;
	readonly getMessage?: (args: ManagementToolArgs<TParams>) => string | undefined;
	readonly execute: ToolDefinition<TParams, TDetails>["execute"];
}

export function createManagementTool<
	TParams extends ToolDefinition["parameters"],
	TDetails extends AgentSummaryDetails = AgentSummaryDetails,
>(options: ManagementToolOptions<TParams, TDetails>): ToolDefinition<TParams, TDetails> {
	return defineTool<TParams, TDetails>({
		name: options.name,
		label: options.label,
		description: options.description,
		parameters: options.parameters,
		execute: options.execute,
		renderCall(args, theme, context) {
			return renderManagementCall(
				options.name,
				options.getAgentId?.(args),
				options.getMessage?.(args),
				context.expanded,
				options.registry.list(),
				theme,
			);
		},
		renderResult(result, resultOptions, theme) {
			return renderSummaryToolResult(options.resultTitle, result, resultOptions, theme);
		},
	});
}
