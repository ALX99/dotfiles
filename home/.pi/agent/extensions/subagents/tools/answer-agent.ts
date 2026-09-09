import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LiveAgentTarget } from "../agent-registry.ts";
import type { AgentSummary } from "../agent-types.ts";
import { renderManagementCall } from "../render.ts";
import { AnswerAgentParamsSchema, preserveRequired, trimRequired, type AnswerAgentParams } from "../schemas.ts";
import { agentSummaryDetails, textResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

interface AnswerAgentDependencies {
	readonly registry: {
		readonly liveTarget: (target: string, generation?: number) => LiveAgentTarget;
		readonly list: () => AgentSummary[];
	};
}

export function createAnswerAgentTool(
	dependencies: AnswerAgentDependencies,
): ToolDefinition<typeof AnswerAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof AnswerAgentParamsSchema, AgentSummaryDetails>({
		name: "answer_agent",
		label: "Answer Agent",
		description:
			"Resolve a child's pending question. Generation is required and must be current; further questions or completion are delivered automatically.",
		parameters: AnswerAgentParamsSchema,
		async execute(_id, params: AnswerAgentParams) {
			const questionId = trimRequired(params.question_id, "question_id");
			const answer = preserveRequired(params.answer, "answer");
			const resolved = dependencies.registry.liveTarget(params.target, params.generation);
			await resolved.agent.answerQuestion(questionId, answer);
			const next = resolved.agent.summary();
			return textResult(
				`Answer delivered to '${next.task_name}'. Further questions or completion will be delivered automatically.`,
				agentSummaryDetails([next]),
			);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"answer_agent",
				args.target,
				args.answer,
				context.expanded,
				dependencies.registry.list(),
				theme,
				"blocking",
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("answer_agent", result, options, theme);
		},
	});
}
