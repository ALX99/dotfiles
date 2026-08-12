import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { clipTextAtWord } from "../../_shared/terminal-text.ts";
import type { AgentSummary } from "../agent-types.ts";
import type { ManagedAgent } from "../managed-agent.ts";
import { renderManagementCall } from "../render.ts";
import type { ReadonlyRunDetails, RunUsage } from "../run-state.ts";
import { FollowupAgentParamsSchema, preserveRequired, trimOptional, trimRequired } from "../schemas.ts";
import { completedRunResult, formatPendingQuestion } from "../tool-results.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";
import type { SubagentToolActivator } from "../tool-activation.ts";

interface FollowupAgentDependencies {
	readonly registry: {
		readonly getLive: (id: string) => ManagedAgent;
		readonly list: () => AgentSummary[];
	};
	readonly ticks: Map<string, NodeJS.Timeout>;
	readonly claimUsage: (summary: AgentSummary) => Readonly<RunUsage> | undefined;
}

export function createFollowupAgentTool(
	toolActivation: SubagentToolActivator,
	dependencies: FollowupAgentDependencies,
): ToolDefinition<typeof FollowupAgentParamsSchema, ReadonlyRunDetails> {
	return defineTool<typeof FollowupAgentParamsSchema, ReadonlyRunDetails>({
		name: "followup_agent",
		label: "Follow Up Agent",
		description:
			"Give a retained live subagent another task using its retained context. One-shot or archived agents cannot be followed up. Foreground by default.",
		parameters: FollowupAgentParamsSchema,
		async execute(_id, params, signal, onUpdate) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			const message = preserveRequired(params.message, "message");
			const agent = dependencies.registry.getLive(agentId);
			const background = params.background === true;
			const unsubscribe = onUpdate
				? agent.subscribe((details) => {
						onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
					})
				: undefined;
			let details: ReadonlyRunDetails;
			try {
				details = await agent.followUp(
					message,
					trimOptional(params.task_name) ?? clipTextAtWord(message, 60),
					background,
					background ? undefined : signal,
				);
			} finally {
				unsubscribe?.();
			}
			const summary = agent.summary();
			toolActivation.activateForState(summary, background);
			const text = background
				? `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\nCompletion will be delivered automatically. Use send_agent, followup_agent, wait_agent, interrupt_agent, or close_agent with this agent_id.`
				: (formatPendingQuestion(summary) ??
					`agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\n${summary.final_text || summary.error || "(no output)"}`);
			return completedRunResult(text, details, background ? undefined : dependencies.claimUsage(summary));
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"followup_agent",
				args.agent_id,
				args.message,
				context.expanded,
				dependencies.registry.list(),
				theme,
				args.background === true ? "async" : "blocking",
			);
		},
		renderResult(result, options, theme, context) {
			return renderRunToolResult(result, options, theme, dependencies.ticks, context.toolCallId, () =>
				context.invalidate(),
			);
		},
	});
}
