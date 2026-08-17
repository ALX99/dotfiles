import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agent-registry.ts";
import type { SpawnAdmissionController } from "../spawn-admission.ts";
import {
	AgentIdParamsSchema,
	AnswerAgentParamsSchema,
	ListAgentsParamsSchema,
	preserveRequired,
	SendAgentParamsSchema,
	trimRequired,
} from "../schemas.ts";
import { agentSummaryDetails, jsonResult, textResult, type AgentSummaryDetails } from "../tool-results.ts";
import { renderManagementCall } from "../render.ts";
import { renderSummaryToolResult } from "../ui/result-renderers.ts";

const DEFAULT_CLOSED_AGENT_LIMIT = 10;

type ManagementRegistry = Pick<AgentRegistry, "list">;
type ManagementToolArgs<TParams extends ToolDefinition["parameters"]> = Parameters<
	NonNullable<ToolDefinition<TParams>["renderCall"]>
>[0];

interface ManagementToolOptions<TParams extends ToolDefinition["parameters"]> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TParams;
	readonly registry: ManagementRegistry;
	readonly resultTitle: string;
	readonly getAgentId?: (args: ManagementToolArgs<TParams>) => string | undefined;
	readonly getMessage?: (args: ManagementToolArgs<TParams>) => string | undefined;
	readonly execute: ToolDefinition<TParams, AgentSummaryDetails>["execute"];
}

export function createManagementTools({
	registry,
	admission,
}: {
	readonly registry: Pick<AgentRegistry, "close" | "getLive" | "list" | "summary">;
	readonly admission: Pick<SpawnAdmissionController, "capacity">;
}) {
	return {
		answer_agent: defineManagementTool({
			name: "answer_agent",
			label: "Answer Agent",
			description:
				"Answer a pending multiple-choice question from a direct child. Use the reported question_id and provide either a listed option or a custom answer; it is unavailable once that question is resolved.",
			parameters: AnswerAgentParamsSchema,
			registry,
			resultTitle: "answer_agent · answer delivered",
			getAgentId: (args) => args.agent_id,
			getMessage: (args) => args.answer,
			async execute(_id, params) {
				const agentId = trimRequired(params.agent_id, "agent_id");
				const questionId = trimRequired(params.question_id, "question_id");
				const answer = preserveRequired(params.answer, "answer");
				const agent = registry.getLive(agentId);
				await agent.answerQuestion(questionId, answer);
				return textResult(
					`Answer delivered to ${agentId}. Further questions or completion will be delivered automatically.`,
					agentSummaryDetails([agent.summary()]),
				);
			},
		}),
		send_agent: defineManagementTool({
			name: "send_agent",
			label: "Send Agent",
			description:
				"Steer a running subagent at its next message boundary. A child waiting for an answer must receive answer_agent instead.",
			parameters: SendAgentParamsSchema,
			registry,
			resultTitle: "send_agent · steering accepted",
			getAgentId: (args) => args.agent_id,
			getMessage: (args) => args.message,
			async execute(_id, params) {
				const agentId = trimRequired(params.agent_id, "agent_id");
				const message = preserveRequired(params.message, "message");
				const agent = registry.getLive(agentId);
				await agent.steer(message);
				return textResult(`Steering message accepted by ${agentId}.`, agentSummaryDetails([agent.summary()]));
			},
		}),
		list_agents: defineManagementTool({
			name: "list_agents",
			label: "List Agents",
			description:
				"List subagents owned by this session and their current status. Capacity distinguishes running children from admission slots occupied by retained idle sessions. Includes the 10 most-recent archived agents by default; set closed_limit to request more or none.",
			parameters: ListAgentsParamsSchema,
			registry,
			resultTitle: "list_agents",
			async execute(_id, params) {
				const limit = params.closed_limit ?? DEFAULT_CLOSED_AGENT_LIMIT;
				const summaries = registry.list();
				const live = summaries.filter((summary) => summary.status !== "closed");
				const closed = limit === 0 ? [] : summaries.filter((summary) => summary.status === "closed").slice(-limit);
				const capacity = admission.capacity();
				return jsonResult(
					{ capacity, agents: [...live, ...closed] },
					agentSummaryDetails([...live, ...closed], capacity),
				);
			},
		}),
		interrupt_agent: defineManagementTool({
			name: "interrupt_agent",
			label: "Interrupt Agent",
			description:
				"Abort a running subagent or cancel its pending question. Only agents spawned with retain:true remain eligible for follow-up work.",
			parameters: AgentIdParamsSchema,
			registry,
			resultTitle: "interrupt_agent",
			getAgentId: (args) => args.agent_id,
			async execute(_id, params) {
				const agent = registry.getLive(trimRequired(params.agent_id, "agent_id"));
				await agent.interrupt();
				const summary = agent.summary();
				return jsonResult(summary, agentSummaryDetails([summary]));
			},
		}),
		close_agent: defineManagementTool({
			name: "close_agent",
			label: "Close Agent",
			description:
				"Dispose a retained subagent session. The call is idempotent for archived agents; persisted result/session references remain readable.",
			parameters: AgentIdParamsSchema,
			registry,
			resultTitle: "close_agent",
			getAgentId: (args) => args.agent_id,
			async execute(_id, params) {
				const agentId = trimRequired(params.agent_id, "agent_id");
				await registry.close(agentId);
				const summary = registry.summary(agentId);
				return jsonResult(summary, agentSummaryDetails([summary]));
			},
		}),
	};
}

function defineManagementTool<TParams extends ToolDefinition["parameters"]>(
	options: ManagementToolOptions<TParams>,
): ToolDefinition<TParams, AgentSummaryDetails> {
	return defineTool<TParams, AgentSummaryDetails>({
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
