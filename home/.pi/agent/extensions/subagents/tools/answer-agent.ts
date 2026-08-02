import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { AnswerAgentParamsSchema, preserveRequired, trimRequired } from "../schemas.ts";
import { agentSummaryDetails, textResult, type AgentSummaryDetails } from "../tool-results.ts";
import { createManagementTool } from "./create-management-tool.ts";

export function createAnswerAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof AnswerAgentParamsSchema, AgentSummaryDetails> {
	return createManagementTool({
		name: "answer_agent",
		label: "Answer Agent",
		description:
			"Answer a pending multiple-choice question from a direct child. Use the reported question_id and provide either a listed option or a custom answer.",
		parameters: AnswerAgentParamsSchema,
		registry: runtime.registry,
		resultTitle: "answer_agent · answer delivered",
		getAgentId: (args) => args.agent_id,
		getMessage: (args) => args.answer,
		async execute(_id, params) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			const questionId = trimRequired(params.question_id, "question_id");
			const answer = preserveRequired(params.answer, "answer");
			const agent = runtime.registry.getLive(agentId);
			await agent.answerQuestion(questionId, answer);
			return textResult(
				`Answer delivered to ${agentId}. Further questions or completion will be delivered automatically.`,
				agentSummaryDetails([agent.summary()]),
			);
		},
	});
}
