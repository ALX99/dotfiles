import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { SubagentRuntime } from "../bootstrap.ts";
import {
	RESULT_READ_DEFAULT_BYTES,
	RESULT_READ_MAX_BYTES,
	RESULT_READ_MIN_BYTES,
	type ResultPage,
} from "../result-store.ts";
import { textResult } from "../tool-results.ts";
import { renderManagementCall } from "../render.ts";
import { trimRequired } from "../schemas.ts";

export const ReadAgentResultParamsSchema = Type.Object(
	{
		agent_id: Type.String({ minLength: 1, pattern: "\\S" }),
		generation: Type.Optional(Type.Integer({ minimum: 1 })),
		cursor: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				description: "Opaque next_cursor returned by a previous read_agent_result call.",
			}),
		),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "UTF-16 string offset. Prefer next_cursor for sequential reconstruction.",
			}),
		),
		max_bytes: Type.Optional(
			Type.Integer({
				minimum: RESULT_READ_MIN_BYTES,
				maximum: RESULT_READ_MAX_BYTES,
				description: `Per-call UTF-8 transport chunk bound. Default ${RESULT_READ_DEFAULT_BYTES}; this never truncates the stored result.`,
			}),
		),
	},
	{ additionalProperties: false },
);

type ReadAgentResultParams = Static<typeof ReadAgentResultParamsSchema>;

export function createReadAgentResultTool(
	runtime: SubagentRuntime,
): ToolDefinition<typeof ReadAgentResultParamsSchema, ResultPage> {
	return defineTool({
		name: "read_agent_result",
		label: "Read Agent Result",
		description:
			"Read an exact subagent result by agent_id, with opaque-cursor or offset pagination. Settled results are persisted and exact; while running, this returns the current bounded preview (complete:false), so prefer wait_agent before reconstructing the terminal result. No filesystem path is accepted.",
		parameters: ReadAgentResultParamsSchema,
		async execute(_id, params: ReadAgentResultParams) {
			const agentId = trimRequired(params.agent_id, "agent_id");
			const page = await runtime.registry.readResult(agentId, {
				...(params.generation === undefined ? {} : { generation: params.generation }),
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
				...(params.offset === undefined ? {} : { offset: params.offset }),
				...(params.max_bytes === undefined ? {} : { maxBytes: params.max_bytes }),
			});
			return textResult(JSON.stringify(page), page);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"read_agent_result",
				args.agent_id,
				undefined,
				context.expanded,
				runtime.registry.list(),
				theme,
			);
		},
	});
}
