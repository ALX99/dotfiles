import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LiveAgentTarget } from "../agent-registry.ts";
import { isAgentActive, type AgentSummary } from "../agent-types.ts";
import { renderManagementCall } from "../render.ts";
import { SteerAgentParamsSchema, preserveRequired, type SteerAgentParams } from "../schemas.ts";
import { agentSummaryDetails, textResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

interface SteerAgentDependencies {
	readonly registry: {
		readonly liveTarget: (target: string, generation?: number) => LiveAgentTarget;
		readonly list: () => AgentSummary[];
	};
}

export function createSteerAgentTool(
	dependencies: SteerAgentDependencies,
): ToolDefinition<typeof SteerAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof SteerAgentParamsSchema, AgentSummaryDetails>({
		name: "steer_agent",
		label: "Steer Agent",
		description:
			"Guide a running generation at its next message boundary. Generation is required and must be current; staleness fails without affecting the child.",
		parameters: SteerAgentParamsSchema,
		async execute(_id, params: SteerAgentParams) {
			const message = preserveRequired(params.message, "message");
			const resolved = dependencies.registry.liveTarget(params.target, params.generation);
			const summary = resolved.summary;
			if (!isAgentActive(summary.status))
				throw new Error(`Agent '${summary.task_name}' is not running (status: ${summary.status}).`);
			if (summary.pending_question)
				throw new Error(
					`Agent '${summary.task_name}' is waiting for '${summary.pending_question.question_id}'; use answer_agent.`,
				);
			await resolved.agent.steer(message);
			const next = resolved.agent.summary();
			return textResult(
				`Steering message accepted by '${next.task_name}' generation ${next.generation}.`,
				agentSummaryDetails([next]),
			);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"steer_agent",
				args.target,
				args.message,
				context.expanded,
				dependencies.registry.list(),
				theme,
				"blocking",
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("steer_agent", result, options, theme);
		},
	});
}
