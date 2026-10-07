import { Result, Schema } from "effect";

import { ProfileSnapshotSchema, type ProfileSnapshot } from "./profile.ts";

const nonBlankText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.makeFilter((value) => (value.trim().length > 0 ? undefined : "must not be blank")),
);
const positiveInteger = Schema.Int.check(Schema.makeFilter((value) => (value > 0 ? undefined : "must be positive")));

export const AGENT_STATUSES = ["running", "waiting_parent", "settled", "interrupted", "cancelled", "error"] as const;
export const LIFECYCLE_EVENT_TYPES = ["settled", "interrupted", "cancelled", "error"] as const;
export const MAILBOX_EVENT_TYPES = [...LIFECYCLE_EVENT_TYPES, "parent_request"] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];
export type MailboxEventType = (typeof MAILBOX_EVENT_TYPES)[number];

const AgentStatusSchema = Schema.Literals(AGENT_STATUSES);
const MailboxEventTypeSchema = Schema.Literals(MAILBOX_EVENT_TYPES);

export interface ParentRequest {
	readonly requestId: string;
	readonly eventId: string;
	readonly invocationId: string;
	readonly message: string;
	readonly options?: readonly string[];
	readonly answer?: string;
}

export interface AgentRecord {
	readonly id: string;
	readonly profile: ProfileSnapshot;
	readonly sessionId: string;
	readonly parentSessionId: string;
	readonly parentAgentId?: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly invocationId: string;
	readonly status: AgentStatus;
	readonly parentRequest?: ParentRequest;
}

export interface MailboxEvent {
	readonly id: string;
	readonly sequence: number;
	readonly dedupeKey: string;
	readonly agentId: string;
	readonly invocationId: string;
	readonly type: MailboxEventType;
	readonly occurredAt: number;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly error?: string;
	/** Set while an event batch is being surfaced; cleared after delivery or cancellation. */
	readonly claimId?: string;
	/** Events remain in the log after acknowledgment so retries cannot resurrect them. */
	readonly acknowledgedAt?: number;
}

export interface ProfileSequence {
	readonly profile: string;
	/** The next number to allocate for this profile in this parent's namespace. */
	readonly next: number;
}

export interface AgentStoreState {
	readonly version: 1;
	readonly ownerSessionId: string;
	readonly ownerAgentId?: string;
	readonly profileSequences: readonly ProfileSequence[];
	readonly nextEventSequence: number;
	readonly agents: readonly AgentRecord[];
	readonly mailbox: readonly MailboxEvent[];
}

const ParentRequestSchema = Schema.Struct({
	requestId: nonBlankText,
	eventId: nonBlankText,
	invocationId: nonBlankText,
	message: nonBlankText,
	options: Schema.optionalKey(Schema.Array(nonBlankText)),
	answer: Schema.optionalKey(nonBlankText),
});

const AgentRecordSchema = Schema.Struct({
	id: nonBlankText,
	profile: ProfileSnapshotSchema,
	sessionId: nonBlankText,
	parentSessionId: nonBlankText,
	parentAgentId: Schema.optionalKey(nonBlankText),
	cwd: nonBlankText,
	createdAt: Schema.Finite,
	invocationId: nonBlankText,
	status: AgentStatusSchema,
	parentRequest: Schema.optionalKey(ParentRequestSchema),
});

const MailboxEventSchema = Schema.Struct({
	id: nonBlankText,
	sequence: positiveInteger,
	dedupeKey: nonBlankText,
	agentId: nonBlankText,
	invocationId: nonBlankText,
	type: MailboxEventTypeSchema,
	occurredAt: Schema.Finite,
	message: Schema.optionalKey(nonBlankText),
	options: Schema.optionalKey(Schema.Array(nonBlankText)),
	error: Schema.optionalKey(nonBlankText),
	claimId: Schema.optionalKey(nonBlankText),
	acknowledgedAt: Schema.optionalKey(Schema.Finite),
});

const ProfileSequenceSchema = Schema.Struct({
	profile: nonBlankText,
	next: positiveInteger,
});

const uniqueBy = <A>(values: readonly A[], key: (value: A) => string): boolean => {
	const keys = values.map(key);
	return new Set(keys).size === keys.length;
};

export const AgentStoreStateSchema = Schema.Struct({
	version: Schema.Literal(1),
	ownerSessionId: nonBlankText,
	ownerAgentId: Schema.optionalKey(nonBlankText),
	profileSequences: Schema.Array(ProfileSequenceSchema).check(
		Schema.makeFilter((values) => (uniqueBy(values, (value) => value.profile) ? undefined : "must be unique")),
	),
	nextEventSequence: positiveInteger,
	agents: Schema.Array(AgentRecordSchema).check(
		Schema.makeFilter((values) => {
			if (!uniqueBy(values, (value) => value.id)) return "agent IDs must be unique";
			if (!uniqueBy(values, (value) => value.sessionId)) return "agent sessions must be unique";
			return values.every((agent) => isValidParentRequestState(agent))
				? undefined
				: "parent request must agree with the agent status";
		}),
	),
	mailbox: Schema.Array(MailboxEventSchema).check(
		Schema.makeFilter((values) => {
			if (!uniqueBy(values, (value) => value.id)) return "event IDs must be unique";
			if (!uniqueBy(values, (value) => value.dedupeKey)) return "event deduplication keys must be unique";
			if (!uniqueBy(values, (value) => String(value.sequence))) return "event sequences must be unique";
			if (!values.every((event) => event.id === `event-${event.sequence}`)) {
				return "event IDs must match their sequence";
			}
			if (!values.every(isValidMailboxEvent)) {
				return "event payload must agree with its type";
			}
			return undefined;
		}),
	),
}).check(
	Schema.makeFilter((state) => {
		if (state.mailbox.some((event) => event.sequence >= state.nextEventSequence)) {
			return "next event sequence must be greater than all persisted events";
		}
		const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
		const nextByProfile = new Map(state.profileSequences.map((entry) => [entry.profile, entry.next]));
		for (const agent of state.agents) {
			if (agent.parentSessionId !== state.ownerSessionId || agent.parentAgentId !== state.ownerAgentId) {
				return "agent parent identity must match the registry owner";
			}
			const match = new RegExp(`^${agent.profile.name}-agent-([1-9]\\d*)$`, "u").exec(agent.id);
			const next = nextByProfile.get(agent.profile.name);
			if (match === null || next === undefined || next <= Number(match[1])) {
				return "agent IDs and profile allocation sequences must agree";
			}
			if (agent.parentRequest !== undefined) {
				const requestEvent = state.mailbox.find((event) => event.id === agent.parentRequest?.eventId);
				if (
					agent.parentRequest.invocationId !== agent.invocationId ||
					requestEvent?.type !== "parent_request" ||
					requestEvent.agentId !== agent.id ||
					requestEvent.invocationId !== agent.invocationId
				) {
					return "parent request must reference its persisted mailbox event";
				}
			}
		}
		if (state.mailbox.some((event) => !agentsById.has(event.agentId))) {
			return "mailbox events must reference registered agents";
		}
		return undefined;
	}),
);

export class AgentStateError extends Schema.TaggedError<AgentStateError>()("AgentStateError", {
	message: Schema.String,
}) {}

export interface CreateAgentInput {
	readonly profile: ProfileSnapshot;
	readonly sessionId: string;
	readonly cwd: string;
	readonly invocationId: string;
	readonly createdAt: number;
}

export interface ParentRequestInput {
	readonly agentId: string;
	readonly invocationId: string;
	readonly requestId: string;
	readonly message: string;
	readonly options?: readonly string[];
	readonly occurredAt: number;
}

export interface FinishInvocationInput {
	readonly agentId: string;
	readonly invocationId: string;
	readonly status: LifecycleEventType;
	readonly occurredAt: number;
	readonly error?: string;
}

export interface Transition<A> {
	readonly state: AgentStoreState;
	readonly value: A;
}

export function emptyAgentStore(ownerSessionId: string, ownerAgentId?: string): AgentStoreState {
	return freezeState({
		version: 1,
		ownerSessionId,
		...(ownerAgentId === undefined ? {} : { ownerAgentId }),
		profileSequences: [],
		nextEventSequence: 1,
		agents: [],
		mailbox: [],
	});
}

/** Allocate stable profile-scoped IDs and register the first invocation atomically. */
export function createAgent(
	state: AgentStoreState,
	input: CreateAgentInput,
): Result.Result<Transition<AgentRecord>, AgentStateError> {
	if (
		input.sessionId.trim().length === 0 ||
		input.cwd.trim().length === 0 ||
		input.invocationId.trim().length === 0 ||
		!Number.isFinite(input.createdAt)
	) {
		return stateFailure("Agent session, working directory, invocation ID, and creation time must be valid.");
	}
	if (state.agents.some((agent) => agent.sessionId === input.sessionId)) {
		return stateFailure(`Session ${input.sessionId} is already registered to an agent.`);
	}

	const sequence = state.profileSequences.find((entry) => entry.profile === input.profile.name)?.next ?? 1;
	let nextSequence = sequence;
	let id = `${input.profile.name}-agent-${nextSequence}`;
	while (state.agents.some((agent) => agent.id === id)) {
		nextSequence += 1;
		id = `${input.profile.name}-agent-${nextSequence}`;
	}

	const record: AgentRecord = Object.freeze({
		id,
		profile: freezeProfile(input.profile),
		sessionId: input.sessionId,
		parentSessionId: state.ownerSessionId,
		...(state.ownerAgentId === undefined ? {} : { parentAgentId: state.ownerAgentId }),
		cwd: input.cwd,
		createdAt: input.createdAt,
		invocationId: input.invocationId,
		status: "running",
	});
	const profileSequences = [
		...state.profileSequences.filter((entry) => entry.profile !== input.profile.name),
		{ profile: input.profile.name, next: nextSequence + 1 },
	].toSorted((left, right) => left.profile.localeCompare(right.profile));
	const next = freezeState({ ...state, profileSequences, agents: [...state.agents, record] });
	return Result.succeed({ state: next, value: record });
}

/** Begin a fresh invocation on a terminal agent without changing its identity or session. */
export function startAgentInvocation(
	state: AgentStoreState,
	agentId: string,
	invocationId: string,
): Result.Result<AgentStoreState, AgentStateError> {
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	if (agent === undefined) return stateFailure(`Unknown agent "${agentId}".`);
	if (agent.status === "running" || agent.status === "waiting_parent") {
		return stateFailure(`Agent "${agentId}" already has an active invocation.`);
	}
	if (invocationId.trim().length === 0 || invocationId === agent.invocationId) {
		return stateFailure("A new invocation requires a distinct, non-empty invocation ID.");
	}
	return Result.succeed(
		withAgent(state, agentId, {
			invocationId,
			status: "running",
			parentRequest: undefined,
		}),
	);
}

/** Suspend a running child and atomically append its direct parent-request event. */
export function askParent(
	state: AgentStoreState,
	input: ParentRequestInput,
): Result.Result<Transition<{ readonly request: ParentRequest; readonly event: MailboxEvent }>, AgentStateError> {
	const agent = state.agents.find((candidate) => candidate.id === input.agentId);
	if (agent === undefined) return stateFailure(`Unknown agent "${input.agentId}".`);
	if (agent.invocationId !== input.invocationId)
		return stateFailure("The parent request belongs to a stale invocation.");
	if (agent.parentRequest !== undefined) {
		if (
			agent.status === "waiting_parent" &&
			agent.parentRequest.requestId === input.requestId &&
			agent.parentRequest.message === input.message &&
			sameStrings(agent.parentRequest.options, input.options)
		) {
			const event = state.mailbox.find((item) => item.id === agent.parentRequest?.eventId);
			if (event !== undefined) return Result.succeed({ state, value: { request: agent.parentRequest, event } });
		}
		return stateFailure(`Agent "${input.agentId}" already has a pending parent request.`);
	}
	if (agent.status !== "running") return stateFailure(`Agent "${input.agentId}" is not running.`);
	if (input.message.trim().length === 0 || input.requestId.trim().length === 0 || !Number.isFinite(input.occurredAt)) {
		return stateFailure("Parent request ID, message, and timestamp must be valid.");
	}
	if (input.options?.some((option) => option.trim().length === 0)) {
		return stateFailure("Suggested parent-request options must not be blank.");
	}
	const dedupeKey = `parent-request:${input.agentId}:${input.invocationId}:${input.requestId}`;
	if (state.mailbox.some((event) => event.dedupeKey === dedupeKey)) {
		return stateFailure("A parent request ID cannot be reused within an invocation.");
	}

	const appended = appendMailboxEvent(state, {
		dedupeKey,
		agentId: input.agentId,
		invocationId: input.invocationId,
		type: "parent_request",
		occurredAt: input.occurredAt,
		message: input.message,
		...(input.options === undefined ? {} : { options: input.options }),
	});
	const request: ParentRequest = Object.freeze({
		requestId: input.requestId,
		eventId: appended.event.id,
		invocationId: input.invocationId,
		message: input.message,
		...(input.options === undefined ? {} : { options: Object.freeze([...input.options]) }),
	});
	const next = withAgent(appended.state, input.agentId, {
		status: "waiting_parent",
		parentRequest: request,
	});
	return Result.succeed({ state: next, value: { request, event: appended.event } });
}

/** Persist the parent's answer before the suspended invocation is resumed. */
export function answerParentRequest(
	state: AgentStoreState,
	agentId: string,
	answer: string,
): Result.Result<Transition<ParentRequest>, AgentStateError> {
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	if (agent === undefined) return stateFailure(`Unknown agent "${agentId}".`);
	if (
		agent.status !== "waiting_parent" ||
		agent.parentRequest === undefined ||
		agent.parentRequest.answer !== undefined
	) {
		return stateFailure(`Agent "${agentId}" has no pending parent request.`);
	}
	if (answer.trim().length === 0) return stateFailure("A parent answer must not be blank.");
	const request = Object.freeze({ ...agent.parentRequest, answer });
	const next = withAgent(state, agentId, { status: "running", parentRequest: request });
	return Result.succeed({ state: next, value: request });
}

/** Consume the durable answer after resuming the same ask_parent invocation. */
export function consumeParentAnswer(
	state: AgentStoreState,
	agentId: string,
	invocationId: string,
): Result.Result<Transition<string>, AgentStateError> {
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	if (agent === undefined) return stateFailure(`Unknown agent "${agentId}".`);
	const request = agent.parentRequest;
	if (
		agent.status !== "running" ||
		agent.invocationId !== invocationId ||
		request === undefined ||
		request.invocationId !== invocationId ||
		request.answer === undefined
	) {
		return stateFailure(`Agent "${agentId}" has no answer to consume for this invocation.`);
	}
	return Result.succeed({
		state: withAgent(state, agentId, { parentRequest: undefined }),
		value: request.answer,
	});
}

/** End one invocation and enqueue its lifecycle event without deleting its agent. */
export function finishAgentInvocation(
	state: AgentStoreState,
	input: FinishInvocationInput,
): Result.Result<Transition<MailboxEvent>, AgentStateError> {
	const agent = state.agents.find((candidate) => candidate.id === input.agentId);
	if (agent === undefined) return stateFailure(`Unknown agent "${input.agentId}".`);
	if (agent.invocationId !== input.invocationId)
		return stateFailure("The lifecycle event belongs to a stale invocation.");
	if (input.status === "error" && (input.error === undefined || input.error.trim().length === 0)) {
		return stateFailure("An error lifecycle event requires an error message.");
	}
	if (!Number.isFinite(input.occurredAt)) return stateFailure("Lifecycle event timestamp must be finite.");

	const dedupeKey = `lifecycle:${input.agentId}:${input.invocationId}`;
	const existing = state.mailbox.find((event) => event.dedupeKey === dedupeKey);
	if (existing !== undefined) {
		if (agent.status === input.status) return Result.succeed({ state, value: existing });
		return stateFailure(`Agent "${input.agentId}" already has a different terminal outcome.`);
	}
	if (agent.status !== "running" && agent.status !== "waiting_parent") {
		return stateFailure(`Agent "${input.agentId}" has no active invocation.`);
	}

	const appended = appendMailboxEvent(state, {
		dedupeKey,
		agentId: input.agentId,
		invocationId: input.invocationId,
		type: input.status,
		occurredAt: input.occurredAt,
		...(input.status === "error" && input.error !== undefined ? { error: input.error } : {}),
	});
	const next = withAgent(appended.state, input.agentId, {
		status: input.status,
		parentRequest: undefined,
	});
	return Result.succeed({ state: next, value: appended.event });
}

/** Claim matching unacknowledged events. A claim is released on cancellation or process restart. */
export function claimMailboxEvents(
	state: AgentStoreState,
	claimId: string,
	agentIds?: readonly string[],
): Result.Result<Transition<readonly MailboxEvent[]>, AgentStateError> {
	if (claimId.trim().length === 0) return stateFailure("Mailbox claim ID must not be blank.");
	const selectedAgents = agentIds === undefined ? undefined : new Set(agentIds);
	const alreadyClaimed = state.mailbox.filter(
		(event) => event.claimId === claimId && event.acknowledgedAt === undefined,
	);
	if (alreadyClaimed.length > 0) return Result.succeed({ state, value: alreadyClaimed });
	const claimed = state.mailbox.filter(
		(event) =>
			event.acknowledgedAt === undefined &&
			event.claimId === undefined &&
			(selectedAgents === undefined || selectedAgents.has(event.agentId)),
	);
	if (claimed.length === 0) return Result.succeed({ state, value: [] });
	const eventIds = new Set(claimed.map((event) => event.id));
	const mailbox = state.mailbox.map((event) => (eventIds.has(event.id) ? Object.freeze({ ...event, claimId }) : event));
	const next = freezeState({ ...state, mailbox });
	return Result.succeed({
		state: next,
		value: next.mailbox.filter((event) => eventIds.has(event.id)),
	});
}

/** Acknowledge only events held by this claim, after the parent has surfaced them. */
export function acknowledgeMailboxEvents(
	state: AgentStoreState,
	claimId: string,
	eventIds: readonly string[],
	acknowledgedAt: number,
): Result.Result<AgentStoreState, AgentStateError> {
	if (claimId.trim().length === 0 || !Number.isFinite(acknowledgedAt)) {
		return stateFailure("Mailbox acknowledgment requires a claim ID and finite timestamp.");
	}
	const ids = [...new Set(eventIds)];
	const claimed = new Set(
		state.mailbox
			.filter((event) => event.claimId === claimId && event.acknowledgedAt === undefined)
			.map((event) => event.id),
	);
	if (ids.some((id) => !claimed.has(id))) {
		return stateFailure("Mailbox acknowledgment included an event not held by this claim.");
	}
	const acknowledged = new Set(ids);
	return Result.succeed(
		freezeState({
			...state,
			mailbox: state.mailbox.map((event) =>
				acknowledged.has(event.id) ? Object.freeze({ ...withoutClaim(event), acknowledgedAt }) : event,
			),
		}),
	);
}

export function releaseMailboxClaim(state: AgentStoreState, claimId: string): AgentStoreState {
	return freezeState({
		...state,
		mailbox: state.mailbox.map((event) =>
			event.claimId === claimId && event.acknowledgedAt === undefined ? withoutClaim(event) : event,
		),
	});
}

/** Claims are process-local coordination; unacknowledged events are redelivered after restart. */
export function releaseAllMailboxClaims(state: AgentStoreState): AgentStoreState {
	return freezeState({
		...state,
		mailbox: state.mailbox.map((event) =>
			event.claimId !== undefined && event.acknowledgedAt === undefined ? withoutClaim(event) : event,
		),
	});
}

export function findAgent(state: AgentStoreState, agentId: string): AgentRecord | undefined {
	return state.agents.find((agent) => agent.id === agentId);
}

export function pendingMailboxEvents(state: AgentStoreState, agentIds?: readonly string[]): readonly MailboxEvent[] {
	const selectedAgents = agentIds === undefined ? undefined : new Set(agentIds);
	return state.mailbox.filter(
		(event) =>
			event.acknowledgedAt === undefined && (selectedAgents === undefined || selectedAgents.has(event.agentId)),
	);
}

export function freezeAgentStoreState(state: AgentStoreState): AgentStoreState {
	return freezeState(state);
}

function appendMailboxEvent(
	state: AgentStoreState,
	input: Omit<MailboxEvent, "id" | "sequence" | "claimId" | "acknowledgedAt">,
): { readonly state: AgentStoreState; readonly event: MailboxEvent } {
	const existing = state.mailbox.find((event) => event.dedupeKey === input.dedupeKey);
	if (existing !== undefined) return { state, event: existing };
	const event: MailboxEvent = Object.freeze({
		...input,
		id: `event-${state.nextEventSequence}`,
		sequence: state.nextEventSequence,
		...(input.options === undefined ? {} : { options: Object.freeze([...input.options]) }),
	});
	return {
		state: freezeState({
			...state,
			nextEventSequence: state.nextEventSequence + 1,
			mailbox: [...state.mailbox, event],
		}),
		event,
	};
}

function withAgent(
	state: AgentStoreState,
	agentId: string,
	patch: {
		readonly invocationId?: string;
		readonly status?: AgentStatus;
		readonly parentRequest?: ParentRequest | undefined;
	},
): AgentStoreState {
	const agents = state.agents.map((agent) => {
		if (agent.id !== agentId) return agent;
		const { parentRequest: _oldRequest, ...withoutOldRequest } = agent;
		const next: AgentRecord = {
			...withoutOldRequest,
			...(patch.invocationId === undefined ? {} : { invocationId: patch.invocationId }),
			...(patch.status === undefined ? {} : { status: patch.status }),
			...(patch.parentRequest === undefined ? {} : { parentRequest: patch.parentRequest }),
		};
		return Object.freeze(next);
	});
	return freezeState({ ...state, agents });
}

function withoutClaim(event: MailboxEvent): MailboxEvent {
	const { claimId: _claimId, ...unclaimed } = event;
	return Object.freeze(unclaimed);
}

function freezeState(state: AgentStoreState): AgentStoreState {
	return Object.freeze({
		...state,
		profileSequences: Object.freeze(state.profileSequences.map((entry) => Object.freeze({ ...entry }))),
		agents: Object.freeze(
			state.agents.map((agent) =>
				Object.freeze({
					...agent,
					profile: freezeProfile(agent.profile),
					...(agent.parentRequest === undefined ? {} : { parentRequest: freezeParentRequest(agent.parentRequest) }),
				}),
			),
		),
		mailbox: Object.freeze(state.mailbox.map(freezeMailboxEvent)),
	});
}

function freezeProfile(profile: ProfileSnapshot): ProfileSnapshot {
	return Object.freeze({
		...profile,
		model: Object.freeze({ ...profile.model }),
		...(profile.tools === undefined ? {} : { tools: Object.freeze([...profile.tools]) }),
		...(profile.skills === undefined ? {} : { skills: Object.freeze([...profile.skills]) }),
		...(profile.spawnProfiles === undefined ? {} : { spawnProfiles: Object.freeze([...profile.spawnProfiles]) }),
	});
}

function freezeParentRequest(request: ParentRequest): ParentRequest {
	return Object.freeze({
		...request,
		...(request.options === undefined ? {} : { options: Object.freeze([...request.options]) }),
	});
}

function freezeMailboxEvent(event: MailboxEvent): MailboxEvent {
	return Object.freeze({
		...event,
		...(event.options === undefined ? {} : { options: Object.freeze([...event.options]) }),
	});
}

function isValidParentRequestState(agent: {
	readonly status: AgentStatus;
	readonly parentRequest?: ParentRequest;
}): boolean {
	if (agent.status === "waiting_parent") {
		return agent.parentRequest !== undefined && agent.parentRequest.answer === undefined;
	}
	if (agent.parentRequest === undefined) return true;
	return agent.status === "running" && agent.parentRequest.answer !== undefined;
}

function isValidMailboxEvent(event: MailboxEvent): boolean {
	if (event.acknowledgedAt !== undefined && event.claimId !== undefined) return false;
	if (event.type === "parent_request") return event.message !== undefined && event.error === undefined;
	if (event.type === "error") {
		return event.error !== undefined && event.message === undefined && event.options === undefined;
	}
	return event.message === undefined && event.options === undefined && event.error === undefined;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	return left === undefined
		? right === undefined
		: right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

function stateFailure(message: string): Result.Result<never, AgentStateError> {
	return Result.fail(new AgentStateError({ message }));
}
