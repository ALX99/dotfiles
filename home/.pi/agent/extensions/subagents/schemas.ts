import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MAX_TASK_NAME_CHARS = 200;
export const MAX_AGENT_ID_CHARS = 128;
export const MAX_WAIT_AGENTS = 32;
export const MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;

const nonBlank = { minLength: 1, pattern: "\\S" } as const;
const agentId = Type.String({
	...nonBlank,
	maxLength: MAX_AGENT_ID_CHARS,
	description: "Stable session-runtime agent ID.",
});
const questionId = Type.String({
	...nonBlank,
	maxLength: MAX_AGENT_ID_CHARS,
	description: "Pending question ID reported by the child.",
});
const message = Type.String({
	...nonBlank,
	description: "Nonblank message for the child.",
});

export interface SpawnAgentSchemaOptions {
	readonly agents: readonly string[];
	readonly profiles: readonly string[];
	/** Thinking overrides advertised from the configured profile ranges. */
	readonly thinkingLevels: readonly ModelThinkingLevel[];
}

export function createSpawnAgentSchema(options: SpawnAgentSchemaOptions) {
	if (options.agents.length === 0) throw new Error("spawn schema requires at least one allowed agent");
	if (options.profiles.length === 0) throw new Error("spawn schema requires at least one allowed profile");
	if (options.thinkingLevels.length === 0) throw new Error("spawn schema requires at least one allowed thinking level");
	const schema = Type.Object(
		{
			message: Type.String({
				...nonBlank,
				description:
					"Self-contained assignment with objective, scope, constraints, expected output, and validation. For workers, include explicit file, module, or responsibility ownership.",
			}),
			handoff: Type.Optional(
				Type.String({
					...nonBlank,
					description:
						"Compact factual context for dependent, retry, review, or replacement work: decisions, findings, exact paths or symbols, constraints, and validation results. The child has its own context; do not repeat the assignment or paste the parent transcript.",
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
				StringEnum(options.thinkingLevels, {
					description:
						"Optional thinking request. The selected model candidate enforces its configured default-to-cap range; omitted requests use that default.",
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
			retain: Type.Optional(
				Type.Boolean({
					description:
						"Keep the child session alive after settlement for followup_agent. Default false; one-shot agents auto-close.",
				}),
			),
		},
		{ additionalProperties: false },
	);
	return schema;
}

export const SendAgentParamsSchema = Type.Object(
	{
		agent_id: agentId,
		message,
	},
	{ additionalProperties: false },
);

export const AnswerAgentParamsSchema = Type.Object(
	{
		agent_id: agentId,
		question_id: questionId,
		answer: Type.String({
			...nonBlank,
			description: "A listed option or a custom answer.",
		}),
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
		timeout_ms: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_WAIT_TIMEOUT_MS,
				description: `Caller-selected wait timeout in milliseconds, up to ${MAX_WAIT_TIMEOUT_MS}.`,
			}),
		),
	},
	{ additionalProperties: false },
);
export type WaitAgentParams = Static<typeof WaitAgentParamsSchema>;

export const ListAgentsParamsSchema = Type.Object(
	{
		closed_limit: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 32,
				description:
					"Maximum number of most-recent archived closed agents to include. Defaults to 10; use up to 32 to request more.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const AgentIdParamsSchema = Type.Object({ agent_id: agentId }, { additionalProperties: false });

export function trimRequired(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be blank.`);
	return trimmed;
}

export function preserveRequired(value: string, label: string): string {
	if (!value.trim()) throw new Error(`${label} must not be blank.`);
	return value;
}

export function trimOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function preserveOptional(value: string | undefined): string | undefined {
	return value?.trim() ? value : undefined;
}

export function uniqueAgentIds(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => trimRequired(value, "agent_id")))];
}
