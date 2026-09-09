import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSummary } from "../agent-types.ts";
import { renderManagementCall } from "../render.ts";
import { AgentsStatusParamsSchema, type AgentsStatusParams } from "../schemas.ts";
import { agentSummaryDetails, jsonResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";
import type { SpawnAdmissionController } from "../spawn-admission.ts";

const DEFAULT_CLOSED_AGENT_LIMIT = 10;

interface AgentsStatusDependencies {
	readonly registry: {
		readonly list: () => AgentSummary[];
	};
	readonly admission: Pick<SpawnAdmissionController, "capacity">;
}

export function createAgentsStatusTool(
	dependencies: AgentsStatusDependencies,
): ToolDefinition<typeof AgentsStatusParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof AgentsStatusParamsSchema, AgentSummaryDetails>({
		name: "agents_status",
		label: "Agents Status",
		description:
			"Inspect live agents, spawn capacity, and the most-recent archived agents with their terminal outcomes.",
		parameters: AgentsStatusParamsSchema,
		async execute(_id, params: AgentsStatusParams) {
			const limit = params.closed_limit ?? DEFAULT_CLOSED_AGENT_LIMIT;
			const summaries = dependencies.registry.list();
			const live = summaries.filter((summary) => summary.status !== "closed");
			const closed = limit === 0 ? [] : summaries.filter((summary) => summary.status === "closed").slice(-limit);
			const capacity = dependencies.admission.capacity();
			return jsonResult(
				{ capacity, agents: [...live, ...closed] },
				agentSummaryDetails([...live, ...closed], capacity),
			);
		},
		renderCall(_args, theme, context) {
			return renderManagementCall(
				"agents_status",
				undefined,
				undefined,
				context.expanded,
				dependencies.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("agents_status", result, options, theme);
		},
	});
}
