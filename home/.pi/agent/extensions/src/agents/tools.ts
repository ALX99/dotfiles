import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const nonBlank = { minLength: 1 } as const;
const agentId = Type.String({ ...nonBlank, description: "A stable direct-child agent ID, such as engineer-agent-1." });
const message = Type.String({ ...nonBlank, description: "A normal message recorded in the agent's Pi session." });

export const SpawnAgentParams = Type.Object(
	{
		profile: Type.String({ ...nonBlank, description: "Name of a validated profile from ~/.pi/agent/profiles." }),
		message,
		cwd: Type.Optional(Type.String({ ...nonBlank, description: "Working directory. Defaults to this agent's cwd." })),
		mode: Type.Optional(
			StringEnum(["async", "wait"] as const, {
				description: "async returns after starting; wait blocks for the first lifecycle or parent-request event.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type SpawnAgentParams = Static<typeof SpawnAgentParams>;

export function createSpawnAgentParams(allowedProfiles?: readonly string[]) {
	if (allowedProfiles !== undefined && allowedProfiles.length === 0) {
		throw new Error("A spawn profile schema requires at least one allowed profile.");
	}
	return Type.Object(
		{
			profile:
				allowedProfiles === undefined
					? Type.String({
							...nonBlank,
							description: "Name of a validated profile from ~/.pi/agent/profiles.",
						})
					: StringEnum(allowedProfiles, {
							description: "Name of a validated profile permitted by this agent's spawn policy.",
						}),
			message,
			cwd: Type.Optional(Type.String({ ...nonBlank, description: "Working directory. Defaults to this agent's cwd." })),
			mode: Type.Optional(
				StringEnum(["async", "wait"] as const, {
					description: "async returns after starting; wait blocks for the first lifecycle or parent-request event.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}

export const WaitAgentParams = Type.Object(
	{
		agents: Type.Array(agentId, {
			minItems: 1,
			uniqueItems: true,
			description: "One or more direct-child agent IDs to wait for.",
		}),
	},
	{ additionalProperties: false },
);
export type WaitAgentParams = Static<typeof WaitAgentParams>;

export const SendAgentParams = Type.Object(
	{
		agent: agentId,
		message: Type.String({
			...nonBlank,
			description: "A message for a settled agent, or an instruction for its active invocation.",
		}),
		mode: Type.Optional(
			StringEnum(["steer", "interrupt"] as const, {
				description:
					"How to handle a running agent. Defaults to steer, which delivers the instruction at a safe opportunity; interrupt stops the run and continues the same session with the instruction. Settled agents always start a new invocation.",
			}),
		),
		wait: Type.Optional(
			Type.Boolean({
				description:
					"Wait for the invocation started or steered by this message to settle before returning. Defaults to false.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type SendAgentParams = Static<typeof SendAgentParams>;

export const AskParentParams = Type.Object(
	{
		message: Type.String({ ...nonBlank, description: "The question or information needed from the direct parent." }),
		options: Type.Optional(
			Type.Array(Type.String(nonBlank), {
				minItems: 1,
				description: "Optional suggestions for the parent; they may answer freely instead.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type AskParentParams = Static<typeof AskParentParams>;

export const AnswerAgentParams = Type.Object(
	{
		agent: agentId,
		answer: Type.String({ ...nonBlank, description: "Free-form answer to the agent's pending parent request." }),
	},
	{ additionalProperties: false },
);
export type AnswerAgentParams = Static<typeof AnswerAgentParams>;

export const CancelAgentParams = Type.Object({ agent: agentId }, { additionalProperties: false });
export type CancelAgentParams = Static<typeof CancelAgentParams>;

export const ListAgentsParams = Type.Object({}, { additionalProperties: false });
export type ListAgentsParams = Static<typeof ListAgentsParams>;

export const InspectAgentParams = Type.Object({ agent: agentId }, { additionalProperties: false });
export type InspectAgentParams = Static<typeof InspectAgentParams>;

export interface AgentToolHandlers {
	readonly spawn: (
		toolCallId: string,
		params: SpawnAgentParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly wait: (
		toolCallId: string,
		params: WaitAgentParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly send: (
		toolCallId: string,
		params: SendAgentParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly askParent?: (
		toolCallId: string,
		params: AskParentParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly answer: (
		toolCallId: string,
		params: AnswerAgentParams,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly cancel: (
		toolCallId: string,
		params: CancelAgentParams,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly list: (
		toolCallId: string,
		params: ListAgentsParams,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly inspect: (
		toolCallId: string,
		params: InspectAgentParams,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

export function registerSpawnAgentTool(
	pi: ExtensionAPI,
	handler: AgentToolHandlers["spawn"],
	allowedProfiles?: readonly string[],
): void {
	if (allowedProfiles !== undefined && allowedProfiles.length === 0) return;
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Create a persistent subagent from a named profile and send its first normal session message. It gets a stable ID and its own Pi JSONL session. async returns immediately; wait blocks for the next lifecycle or parent-request event. No task completion is inferred.",
		promptSnippet: "Spawn a persistent profile-based subagent",
		parameters: createSpawnAgentParams(allowedProfiles),
		executionMode: "sequential",
		execute(toolCallId, params, signal, _onUpdate, ctx) {
			return handler(toolCallId, params, signal, ctx);
		},
	});
}

/** Register the model-facing protocol; only child runtimes receive the ask_parent capability. */
export function registerAgentTools(
	pi: ExtensionAPI,
	handlers: AgentToolHandlers,
	allowedSpawnProfiles?: readonly string[],
): void {
	const capturedAllowedProfiles =
		allowedSpawnProfiles === undefined ? undefined : Object.freeze([...allowedSpawnProfiles]);
	registerSpawnAgentTool(pi, handlers.spawn, capturedAllowedProfiles);
	// Re-register the snapshot-specific schema after session binding. The workflow still enforces
	// this policy independently; the enum is discoverability and argument validation, not authority.
	pi.on("session_start", () => registerSpawnAgentTool(pi, handlers.spawn, capturedAllowedProfiles));

	pi.registerTool({
		name: "wait_agent",
		label: "Wait for Agents",
		description:
			"Wait for one or more direct children to produce a lifecycle event or ask_parent request. Returns the event data; it does not interpret task completion or progress.",
		promptSnippet: "Wait for child-agent events",
		parameters: WaitAgentParams,
		executionMode: "sequential",
		execute(toolCallId, params, signal, _onUpdate, ctx) {
			return handlers.wait(toolCallId, params, signal, ctx);
		},
	});

	pi.registerTool({
		name: "send_agent",
		label: "Send Agent",
		description:
			"Send a message to a direct child. A settled child starts a new invocation using its existing session. For a running child, mode defaults to steer and delivers the instruction at a safe opportunity; mode interrupt stops the run, then continues the same session with the instruction. Set wait to true to wait for that invocation to settle before returning; a parent request does not count as settlement. If the child is waiting for you, use answer_agent.",
		promptSnippet: "Message or steer a direct child using its existing session",
		parameters: SendAgentParams,
		executionMode: "sequential",
		execute(toolCallId, params, signal, _onUpdate, ctx) {
			return handlers.send(toolCallId, params, signal, ctx);
		},
	});

	if (handlers.askParent !== undefined) {
		pi.registerTool({
			name: "ask_parent",
			label: "Ask Parent",
			description:
				"Ask your direct parent a question and suspend this invocation until it answers. Suggested options are not restrictive; the parent may answer freely.",
			promptSnippet: "Ask the direct parent and suspend until answered",
			parameters: AskParentParams,
			executionMode: "sequential",
			execute(toolCallId, params, signal, _onUpdate, ctx) {
				return handlers.askParent!(toolCallId, params, signal, ctx);
			},
		});
	}

	pi.registerTool({
		name: "answer_agent",
		label: "Answer Agent",
		description:
			"Answer a direct child that is suspended in ask_parent. The answer may be any free-form text, whether or not it matches the child's suggested options.",
		promptSnippet: "Answer a child's pending parent request",
		parameters: AnswerAgentParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.answer(toolCallId, params, ctx);
		},
	});

	pi.registerTool({
		name: "cancel_agent",
		label: "Cancel Agent",
		description:
			"Cancel a direct child's current invocation without deleting its stable agent identity or Pi session. The child can later continue with send_agent.",
		promptSnippet: "Cancel a child invocation without deleting its session",
		parameters: CancelAgentParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.cancel(toolCallId, params, ctx);
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List your direct child agents and their runtime statuses.",
		promptSnippet: "List direct child agents",
		parameters: ListAgentsParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.list(toolCallId, params, ctx);
		},
	});

	pi.registerTool({
		name: "inspect_agent",
		label: "Inspect Agent",
		description:
			"Inspect a direct child agent's profile, runtime status, working directory, and latest five observable session events. Does not infer task, progress, or private reasoning.",
		promptSnippet: "Inspect a child agent's latest observable activity",
		parameters: InspectAgentParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.inspect(toolCallId, params, ctx);
		},
	});
}
