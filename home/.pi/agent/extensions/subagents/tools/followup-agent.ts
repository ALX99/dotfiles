import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LiveAgentTarget } from "../agent-registry.ts";
import type { AgentSummary } from "../agent-types.ts";
import { renderManagementCall } from "../render.ts";
import type { ReadonlyRunDetails, RunUsage } from "../run-state.ts";
import { FollowupAgentParamsSchema, preserveRequired, type FollowupAgentParams } from "../schemas.ts";
import { finishRunResult } from "../tool-results.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";
import type { SubagentToolActivator } from "../tool-activation.ts";

interface FollowupAgentDependencies {
	readonly registry: {
		readonly liveTarget: (target: string) => LiveAgentTarget;
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
		label: "Followup Agent",
		description:
			"Start another task on a retained settled child. Address it by task_name or agent_id. The address never changes across generations.",
		parameters: FollowupAgentParamsSchema,
		async execute(_id, params: FollowupAgentParams, signal, onUpdate) {
			const message = preserveRequired(params.message, "message");
			const background = params.background === true;
			const agent = dependencies.registry.liveTarget(params.target).agent;
			const unsubscribe = onUpdate
				? agent.subscribe((details) => {
						onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
					})
				: undefined;
			let details: ReadonlyRunDetails;
			try {
				details = await agent.followUp(message, background, background ? undefined : signal);
			} finally {
				unsubscribe?.();
			}
			return finishRunResult({
				toolActivation,
				claimUsage: dependencies.claimUsage,
				summary: agent.summary(),
				details,
				background,
			});
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"followup_agent",
				args.target,
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
