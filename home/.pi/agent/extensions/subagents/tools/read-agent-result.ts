import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agent-registry.ts";
import { RESULT_READ_DEFAULT_BYTES, type ResultPage } from "../result-store.ts";
import { textResult } from "../tool-results.ts";
import { renderManagementCall } from "../render.ts";
import { ReadAgentResultParamsSchema, type ReadAgentResultParams } from "../schemas.ts";

export type ReadAgentResultDependencies = Pick<AgentRegistry, "readResultByAddress" | "list">;

export function createReadAgentResultTool(
	dependencies: ReadAgentResultDependencies,
): ToolDefinition<typeof ReadAgentResultParamsSchema, ResultPage> {
	return defineTool({
		name: "read_agent_result",
		label: "Read Agent Result",
		description:
			"Read exact persisted result text for one target generation. Address by task_name or agent_id; generation defaults to latest. Paginate with either an opaque cursor or an offset, never both. Still-running generations fail explicitly instead of returning previews; use wait_agents first. Does not wait, execute, or inspect live progress; available for any stored generation even when the preview fits.",
		parameters: ReadAgentResultParamsSchema,
		async execute(_id, params: ReadAgentResultParams) {
			const page = await dependencies.readResultByAddress(params.target, {
				...(params.generation === undefined ? {} : { generation: params.generation }),
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
				...(params.offset === undefined ? {} : { offset: params.offset }),
				maxBytes: params.max_bytes ?? RESULT_READ_DEFAULT_BYTES,
			});
			return textResult(JSON.stringify(page), page);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"read_agent_result",
				args.target,
				undefined,
				context.expanded,
				dependencies.list(),
				theme,
			);
		},
	});
}
