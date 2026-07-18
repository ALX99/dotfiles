import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MAX_MESSAGE_CHARS = 100_000;
export const MAX_HANDOFF_CHARS = 8_000;
export const MAX_TASK_NAME_CHARS = 200;
export const MAX_AGENT_ID_CHARS = 128;
export const MAX_WAIT_AGENTS = 32;

const nonBlank = { minLength: 1, pattern: "\\S" } as const;
const agentId = Type.String({
	...nonBlank,
	maxLength: MAX_AGENT_ID_CHARS,
	description: "Stable session-runtime agent ID.",
});
const message = Type.String({
	...nonBlank,
	maxLength: MAX_MESSAGE_CHARS,
	description: "Nonblank message for the child.",
});

export function createSpawnAgentSchema(maxDelegationGrant: number) {
	return Type.Object(
		{
			message: Type.String({
				...nonBlank,
				maxLength: MAX_MESSAGE_CHARS,
				description: "Complete self-contained assignment for the child.",
			}),
			handoff: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: MAX_HANDOFF_CHARS,
					description: "Known paths, decisions, facts, or small excerpts from the parent.",
				}),
			),
			task_name: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: MAX_TASK_NAME_CHARS,
					description: "Short UI label; derived from message when omitted.",
				}),
			),
			agent: Type.String({
				...nonBlank,
				maxLength: 128,
				description: "Discovered subagent name. Membership is validated when the tool runs.",
			}),
			profile: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: 128,
					description: "Execution-profile override. Membership is validated when the tool runs.",
				}),
			),
			thinking: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
					description: "Optional thinking request; must not exceed the selected profile candidate's cap.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: 4_096,
					description: "Working directory; defaults to current cwd.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({ description: "Return after launch and notify on completion. Default false." }),
			),
			delegation_credits: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: maxDelegationGrant,
					description: "Delegation credits granted to an eligible general child. Root only; default 0.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}

export type SpawnAgentParams = Static<ReturnType<typeof createSpawnAgentSchema>>;

export const SendAgentParamsSchema = Type.Object(
	{
		agent_id: agentId,
		message,
	},
	{ additionalProperties: false },
);
export type SendAgentParams = Static<typeof SendAgentParamsSchema>;

export const FollowupAgentParamsSchema = Type.Object(
	{
		agent_id: agentId,
		message,
		task_name: Type.Optional(Type.String({ ...nonBlank, maxLength: MAX_TASK_NAME_CHARS })),
		background: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type FollowupAgentParams = Static<typeof FollowupAgentParamsSchema>;

export const WaitAgentParamsSchema = Type.Object(
	{
		agent_ids: Type.Array(agentId, {
			minItems: 1,
			maxItems: MAX_WAIT_AGENTS,
			description: "Agent IDs to wait for. Duplicates are ignored after trimming.",
		}),
	},
	{ additionalProperties: false },
);
export type WaitAgentParams = Static<typeof WaitAgentParamsSchema>;

export function createWaitAgentSchema(): typeof WaitAgentParamsSchema {
	return WaitAgentParamsSchema;
}

export const ListAgentsParamsSchema = Type.Object({}, { additionalProperties: false });
export type ListAgentsParams = Static<typeof ListAgentsParamsSchema>;

export const AgentIdParamsSchema = Type.Object({ agent_id: agentId }, { additionalProperties: false });
export type AgentIdParams = Static<typeof AgentIdParamsSchema>;

export function trimRequired(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be blank.`);
	return trimmed;
}

export function trimOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function uniqueAgentIds(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => trimRequired(value, "agent_id")))];
}
