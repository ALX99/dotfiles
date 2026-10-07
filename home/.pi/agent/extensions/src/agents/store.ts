import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect, Result, Schema, SynchronizedRef } from "effect";
import { join } from "node:path";

import { readFileStringIfExists, writeFileStringAtomically } from "../support/fs.ts";
import { AgentStateError } from "./state.ts";
import {
	AgentStoreStateSchema,
	acknowledgeMailboxEvents,
	askParent,
	claimMailboxEvents,
	createAgent,
	emptyAgentStore,
	findAgent,
	finishAgentInvocation,
	freezeAgentStoreState,
	pendingMailboxEvents,
	releaseAllMailboxClaims,
	releaseMailboxClaim,
	startAgentInvocation,
	answerParentRequest,
	consumeParentAnswer,
	type AgentRecord,
	type AgentStoreState,
	type CreateAgentInput,
	type FinishInvocationInput,
	type MailboxEvent,
	type ParentRequest,
	type ParentRequestInput,
	type Transition,
} from "./state.ts";
import { FsError } from "../support/errors.ts";

export class AgentStoreError extends Schema.TaggedError<AgentStoreError>()("AgentStoreError", {
	path: Schema.String,
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export interface OpenAgentStoreOptions {
	readonly ownerSessionId: string;
	/** Present when this registry belongs to a subagent rather than a root Pi session. */
	readonly ownerAgentId?: string;
	/** Directory for agent registry files; defaults to ~/.pi/agent/agents. */
	readonly directory?: string;
}

export interface AgentStore {
	readonly ownerSessionId: string;
	readonly path: string;
	readonly subscribeAgentChanges: (listener: () => void) => () => void;
	readonly snapshot: () => Effect.Effect<AgentStoreState>;
	readonly listAgents: () => Effect.Effect<readonly AgentRecord[]>;
	readonly getAgent: (agentId: string) => Effect.Effect<AgentRecord | undefined>;
	readonly pendingEvents: (agentIds?: readonly string[]) => Effect.Effect<readonly MailboxEvent[]>;
	readonly createAgent: (input: CreateAgentInput) => Effect.Effect<AgentRecord, AgentStateError | FsError>;
	readonly startInvocation: (agentId: string, invocationId: string) => Effect.Effect<void, AgentStateError | FsError>;
	readonly requestParent: (
		input: ParentRequestInput,
	) => Effect.Effect<
		{ readonly request: ParentRequest; readonly event: MailboxEvent },
		AgentStateError | AgentStoreError | FsError
	>;
	readonly answerParent: (
		agentId: string,
		answer: string,
	) => Effect.Effect<ParentRequest, AgentStateError | AgentStoreError | FsError>;
	readonly consumeParentAnswer: (
		agentId: string,
		invocationId: string,
	) => Effect.Effect<string, AgentStateError | AgentStoreError | FsError>;
	readonly finishInvocation: (
		input: FinishInvocationInput,
	) => Effect.Effect<MailboxEvent, AgentStateError | AgentStoreError | FsError>;
	readonly claimEvents: (
		claimId: string,
		agentIds?: readonly string[],
		eventIds?: readonly string[],
	) => Effect.Effect<readonly MailboxEvent[], AgentStateError | AgentStoreError | FsError>;
	readonly acknowledgeEvents: (
		claimId: string,
		eventIds: readonly string[],
		acknowledgedAt: number,
	) => Effect.Effect<void, AgentStateError | FsError>;
	readonly releaseClaim: (claimId: string) => Effect.Effect<void, AgentStateError | FsError>;
}

/** Stable owner-scoped file path without trusting a Pi session ID as a filename. */
export function agentStorePath(ownerSessionId: string, directory = join(getAgentDir(), "agents")): string {
	const key = createHash("sha256").update(ownerSessionId).digest("hex");
	return join(directory, `${key}.json`);
}

/** Open the single serialized registry/mailbox owner for one parent session. */
export const openAgentStore = Effect.fn("openAgentStore")(function* (
	options: OpenAgentStoreOptions,
): Effect.fn.Return<AgentStore, AgentStoreError | FsError> {
	if (options.ownerSessionId.trim().length === 0) {
		return yield* new AgentStoreError({
			path: options.directory ?? join(getAgentDir(), "agents"),
			message: "An agent registry requires a non-empty owner session ID.",
			cause: new Error("Invalid owner session ID."),
		});
	}

	const path = agentStorePath(options.ownerSessionId, options.directory);
	const contents = yield* readFileStringIfExists(path);
	let state: AgentStoreState;
	if (contents === undefined) {
		state = emptyAgentStore(options.ownerSessionId, options.ownerAgentId);
	} else {
		let persisted: unknown;
		try {
			persisted = JSON.parse(contents);
		} catch (cause) {
			return yield* new AgentStoreError({
				path,
				message: "Could not parse the persisted agent registry.",
				cause,
			});
		}
		const decoded = Schema.decodeUnknownResult(AgentStoreStateSchema)(persisted);
		if (Result.isFailure(decoded)) {
			return yield* new AgentStoreError({
				path,
				message: `Persisted agent registry has an invalid shape: ${String(decoded.failure)}`,
				cause: decoded.failure,
			});
		}
		if (
			decoded.success.ownerSessionId !== options.ownerSessionId ||
			decoded.success.ownerAgentId !== options.ownerAgentId
		) {
			return yield* new AgentStoreError({
				path,
				message: "Persisted agent registry belongs to a different parent session.",
				cause: new Error("Registry owner mismatch."),
			});
		}
		state = freezeAgentStoreState(decoded.success);
	}

	const recovered = releaseAllMailboxClaims(state);
	if (recovered.mailbox.some((event, index) => event.claimId !== state.mailbox[index]?.claimId)) {
		yield* Effect.uninterruptible(
			writeFileStringAtomically(path, serialize(recovered), { recursive: true, mode: 0o600 }),
		);
	}
	const stateRef = yield* SynchronizedRef.make(recovered);
	const agentListeners = new Set<() => void>();
	const notifyAgentListeners = (): void => {
		for (const listener of Array.from(agentListeners)) {
			try {
				listener();
			} catch (cause) {
				console.error(`Agent store change listener failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		}
	};

	const transact = <A>(
		transition: (current: AgentStoreState) => Result.Result<Transition<A>, AgentStateError>,
	): Effect.Effect<A, AgentStateError | FsError> => {
		let agentsChanged = false;
		return SynchronizedRef.modifyEffect(
			stateRef,
			(current): Effect.Effect<readonly [A, AgentStoreState], AgentStateError | FsError> => {
				const decoded = transition(current);
				if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);
				if (decoded.success.state === current) return Effect.succeed([decoded.success.value, current] as const);
				const next = freezeAgentStoreState(decoded.success.state);
				agentsChanged = !sameAgentFooterRecords(current.agents, next.agents);
				return Effect.uninterruptible(
					writeFileStringAtomically(path, serialize(next), { recursive: true, mode: 0o600 }).pipe(
						Effect.as([decoded.success.value, next] as const),
					),
				);
			},
		).pipe(Effect.tap(() => (agentsChanged ? Effect.sync(notifyAgentListeners) : Effect.void)));
	};

	return {
		ownerSessionId: options.ownerSessionId,
		path,
		subscribeAgentChanges(listener) {
			agentListeners.add(listener);
			return () => agentListeners.delete(listener);
		},
		snapshot: () => SynchronizedRef.get(stateRef),
		listAgents: () => SynchronizedRef.get(stateRef).pipe(Effect.map((current) => current.agents)),
		getAgent: (agentId) => SynchronizedRef.get(stateRef).pipe(Effect.map((current) => findAgent(current, agentId))),
		pendingEvents: (agentIds) =>
			SynchronizedRef.get(stateRef).pipe(Effect.map((current) => pendingMailboxEvents(current, agentIds))),
		createAgent: (input) => transact((current) => createAgent(current, input)),
		startInvocation: (agentId, invocationId) =>
			transact((current) => {
				const next = startAgentInvocation(current, agentId, invocationId);
				return Result.isFailure(next)
					? Result.fail(next.failure)
					: Result.succeed({ state: next.success, value: undefined });
			}),
		requestParent: (input) => transact((current) => askParent(current, input)),
		answerParent: (agentId, answer) => transact((current) => answerParentRequest(current, agentId, answer)),
		consumeParentAnswer: (agentId, invocationId) =>
			transact((current) => consumeParentAnswer(current, agentId, invocationId)),
		finishInvocation: (input) => transact((current) => finishAgentInvocation(current, input)),
		claimEvents: (claimId, agentIds, eventIds) =>
			transact((current) => claimMailboxEvents(current, claimId, agentIds, eventIds)),
		acknowledgeEvents: (claimId, eventIds, acknowledgedAt) =>
			transact((current) => {
				const next = acknowledgeMailboxEvents(current, claimId, eventIds, acknowledgedAt);
				return Result.isFailure(next)
					? Result.fail(next.failure)
					: Result.succeed({ state: next.success, value: undefined });
			}),
		releaseClaim: (claimId) =>
			transact((current) =>
				Result.succeed({
					state: releaseMailboxClaim(current, claimId),
					value: undefined,
				}),
			),
	};
});

function serialize(state: AgentStoreState): string {
	return `${JSON.stringify(state, null, 2)}\n`;
}

function sameAgentFooterRecords(previous: readonly AgentRecord[], next: readonly AgentRecord[]): boolean {
	return (
		previous.length === next.length &&
		previous.every((agent, index) => {
			const candidate = next[index];
			return (
				candidate !== undefined &&
				agent.id === candidate.id &&
				agent.profile.name === candidate.profile.name &&
				agent.profile.model.provider === candidate.profile.model.provider &&
				agent.profile.model.id === candidate.profile.model.id &&
				agent.status === candidate.status
			);
		})
	);
}
