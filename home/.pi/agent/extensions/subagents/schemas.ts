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

export interface SpawnAgentSchemaOptions {
	readonly agents: readonly string[];
	readonly profiles: readonly string[];
	readonly maxSpawnBudgetPerChild?: number;
}

export function createSpawnAgentSchema(options: SpawnAgentSchemaOptions) {
	if (options.agents.length === 0) throw new Error("spawn schema requires at least one allowed agent");
	if (options.profiles.length === 0) throw new Error("spawn schema requires at least one allowed profile");
	const schema = Type.Object(
		{
			message: Type.String({
				...nonBlank,
				maxLength: MAX_MESSAGE_CHARS,
				description:
					"Self-contained assignment with objective, scope, constraints, expected output, and validation. For workers, include explicit file, module, or responsibility ownership.",
			}),
			handoff: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: MAX_HANDOFF_CHARS,
					description:
						"Concise known paths, decisions, facts, or excerpts that save repeated exploration. Do not repeat the assignment.",
				}),
			),
			task_name: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: MAX_TASK_NAME_CHARS,
					description: "Short UI label; derived from message when omitted.",
				}),
			),
			agent: StringEnum(options.agents, {
				description: "Allowed subagent role for this execution.",
			}),
			profile: Type.Optional(
				StringEnum(options.profiles, {
					description: "Allowed execution-profile override.",
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
			child_spawn_budget: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: options.maxSpawnBudgetPerChild ?? 0,
					description: "Delegation credits granted to an eligible child. Default 0.",
				}),
			),
		},
		{ additionalProperties: false },
	);
	if (options.maxSpawnBudgetPerChild === undefined) Reflect.deleteProperty(schema.properties, "child_spawn_budget");
	return schema;
}

export const SendAgentParamsSchema = Type.Object(
	{
		agent_id: agentId,
		message,
	},
	{ additionalProperties: false },
);

export const FollowupAgentParamsSchema = Type.Object(
	{
		agent_id: agentId,
		message,
		task_name: Type.Optional(Type.String({ ...nonBlank, maxLength: MAX_TASK_NAME_CHARS })),
		background: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

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

export const AgentIdParamsSchema = Type.Object({ agent_id: agentId }, { additionalProperties: false });

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
