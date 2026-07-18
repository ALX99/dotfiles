import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { clipTextAtWord } from "../../_shared/terminal-text.ts";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderManagementCall } from "../render.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { FollowupAgentParamsSchema, trimOptional, trimRequired } from "../schemas.ts";
import { textResult } from "../tool-results.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";

export function createFollowupAgentTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof FollowupAgentParamsSchema, ReadonlyRunDetails> {
	return defineTool<typeof FollowupAgentParamsSchema, ReadonlyRunDetails>({
		name: "followup_agent",
		label: "Follow Up Agent",
		description: "Give an existing subagent another task using its retained context. Foreground by default.",
		parameters: FollowupAgentParamsSchema,
		async execute(_id, params, signal, onUpdate) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			const message = trimRequired(params.message, "message");
			const agent = runtime.registry.getLive(agentId);
			const background = params.background === true;
			const unsubscribe = onUpdate
				? agent.subscribe(() => {
						onUpdate({ content: [{ type: "text", text: "(running…)" }], details: agent.getDetails() });
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
			const text = background
				? `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\nCompletion will be delivered automatically. Use send_agent, followup_agent, wait_agent, interrupt_agent, or close_agent with this agent_id.`
				: `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\n${summary.final_text || summary.error || "(no output)"}`;
			return textResult(text, details);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"followup_agent",
				args.agent_id,
				args.message,
				context.expanded,
				runtime.registry.list(),
				theme,
				args.background === true ? "async" : "blocking",
			);
		},
		renderResult(result, options, theme, context) {
			return renderRunToolResult(result, options, theme, runtime.ticks, context.toolCallId, () => context.invalidate());
		},
	});
}
