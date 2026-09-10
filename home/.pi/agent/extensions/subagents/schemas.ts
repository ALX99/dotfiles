import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MAX_TASK_NAME_CHARS = 200;
export const MAX_AGENT_ID_CHARS = 128;
export const MAX_WAIT_AGENTS = 32;

const nonBlank = { minLength: 1, pattern: "\\S" } as const;
const target = Type.String({
	...nonBlank,
	maxLength: MAX_TASK_NAME_CHARS,
	description: "Agent address: task_name or agent_id. Task names are unique per session.",
});
const generation = Type.Integer({
	minimum: 1,
	description: "One-based generation number; required where staleness is dangerous (steer, answer).",
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
					"Self-contained objective, scope, constraints, output, and validation; workers include file/module/responsibility ownership.",
			}),
			handoff: Type.Optional(
				Type.String({
					...nonBlank,
					description:
						"Factual delta for dependent/retry/review/replacement work: decisions, findings, paths/symbols, constraints, validation. Do not repeat the assignment or paste the parent transcript.",
				}),
			),
			task_name: Type.Optional(
				Type.String({
					...nonBlank,
					maxLength: MAX_TASK_NAME_CHARS,
					description:
						"Human address for this agent; must be unique in this session. Derived from message when omitted.",
				}),
			),
			agent: Type.Optional(
				StringEnum(options.agents, {
					description: `Allowed subagent role for this execution. Defaults to '${options.agents[0]}' when omitted.`,
				}),
			),
			profile: Type.Optional(
				StringEnum(options.profiles, {
					description: "Allowed execution-profile override.",
				}),
			),
			thinking: Type.Optional(
				StringEnum(options.thinkingLevels, {
					description:
						"Thinking request within the selected candidate's configured default-to-cap range; omit for its default.",
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
						"Keep session after settlement for follow-up input; default false, so one-shot agents auto-close.",
				}),
			),
		},
		{ additionalProperties: false },
	);
	return schema;
}

export const AgentTargetSchema = Type.Object(
	{
		target,
		generation: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "One-based generation; defaults to the latest generation.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type AgentTarget = Static<typeof AgentTargetSchema>;

export const WaitAgentsParamsSchema = Type.Object(
	{
		targets: Type.Array(AgentTargetSchema, {
			minItems: 1,
			maxItems: MAX_WAIT_AGENTS,
			description:
				"Explicit agent targets for one barrier until each settles or requests input. Generations default to latest; already-settled generations return immediately. Waiting creates no work and observes completion repeatably.",
		}),
	},
	{ additionalProperties: false },
);
export type WaitAgentsParams = Static<typeof WaitAgentsParamsSchema>;

export const FollowupAgentParamsSchema = Type.Object(
	{
		target,
		message,
		background: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type FollowupAgentParams = Static<typeof FollowupAgentParamsSchema>;

export const SteerAgentParamsSchema = Type.Object(
	{
		target,
		generation,
		message,
	},
	{ additionalProperties: false },
);
export type SteerAgentParams = Static<typeof SteerAgentParamsSchema>;

export const AnswerAgentParamsSchema = Type.Object(
	{
		target,
		generation,
		question_id: questionId,
		answer: Type.String({
			...nonBlank,
			description: "A listed option or a custom answer.",
		}),
	},
	{ additionalProperties: false },
);
export type AnswerAgentParams = Static<typeof AnswerAgentParamsSchema>;

export const CloseAgentParamsSchema = Type.Object(
	{
		target,
		generation: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"One-based generation to close; defaults to the latest. A running generation is aborted, then disposed, in one step.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type CloseAgentParams = Static<typeof CloseAgentParamsSchema>;

export const AgentsStatusParamsSchema = Type.Object(
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
export type AgentsStatusParams = Static<typeof AgentsStatusParamsSchema>;

export const ReadAgentResultParamsSchema = Type.Object(
	{
		target,
		generation: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "One-based generation; defaults to the latest generation.",
			}),
		),
		cursor: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				description: "Opaque next_cursor returned by a previous read_agent_result call. Unset when paging by offset.",
			}),
		),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"UTF-16 string offset. Prefer next_cursor for sequential reconstruction. Unset when paging by cursor.",
			}),
		),
		max_bytes: Type.Optional(
			Type.Integer({
				minimum: 4,
				maximum: 6144,
				description: "Per-call UTF-8 transport chunk bound. Default 6144; this never truncates the stored result.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ReadAgentResultParams = Static<typeof ReadAgentResultParamsSchema>;

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

export function uniqueAgentTargets(values: readonly AgentTarget[]): AgentTarget[] {
	const seen = new Set<string>();
	const unique: AgentTarget[] = [];
	for (const value of values) {
		const address = trimRequired(value.target, "target");
		const key = `${address}:${value.generation ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(
			value.generation === undefined ? { target: address } : { target: address, generation: value.generation },
		);
	}
	return unique;
}
