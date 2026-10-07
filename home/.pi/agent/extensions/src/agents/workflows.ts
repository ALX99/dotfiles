import { randomUUID } from "node:crypto";
import { Deferred, Effect, Exit, FiberSet, PubSub, Ref, Result, Schema, SynchronizedRef } from "effect";

import type { AgentInvocationResult, AgentSessionOwner } from "./session.ts";
import { AgentSessionOwnerError } from "./session.ts";
import type { AgentRecord, LifecycleEventType, MailboxEvent, ParentRequest } from "./state.ts";
import { AgentStateError } from "./state.ts";
import type { AgentStore } from "./store.ts";
import { AgentStoreError } from "./store.ts";
import { loadProfile, type ProfileModelLookup } from "./profile.ts";
import type { ProfileCapabilityPolicy } from "./policy.ts";
import type { FsError } from "../support/errors.ts";
import { toError } from "../support/errors.ts";
import { inspectAgentRecord, listAgentRecords, type AgentInspection, type AgentListing } from "./inspection.ts";

export class AgentWorkflowError extends Schema.TaggedError<AgentWorkflowError>()("AgentWorkflowError", {
	message: Schema.String,
}) {}

export type AgentWorkflowFailure =
	| AgentWorkflowError
	| AgentStateError
	| AgentStoreError
	| AgentSessionOwnerError
	| FsError
	| import("./profile.ts").ProfileError;

export interface AgentEventResult {
	readonly agent: string;
	readonly event: LifecycleEventType | "parent_request";
	readonly message?: string;
	readonly options?: readonly string[];
	readonly error?: string;
}

export interface SpawnAgentInput {
	readonly profile: string;
	readonly message: string;
	readonly cwd?: string;
	readonly mode?: "async" | "wait";
}

export interface AgentWorkflows {
	readonly events: PubSub.PubSub<MailboxEvent>;
	readonly listAgents: () => Effect.Effect<readonly AgentListing[]>;
	readonly inspectAgent: (agentId: string) => Effect.Effect<AgentInspection, AgentWorkflowFailure>;
	readonly spawnAgent: (
		input: SpawnAgentInput,
	) => Effect.Effect<
		| { readonly agent: string; readonly status: "running" }
		| AgentEventResult
		| { readonly events: readonly AgentEventResult[] },
		AgentWorkflowFailure
	>;
	readonly waitAgent: (agentIds: readonly string[]) => Effect.Effect<readonly AgentEventResult[], AgentWorkflowFailure>;
	readonly sendAgent: (
		agentId: string,
		message: string,
	) => Effect.Effect<{ readonly agent: string; readonly status: "running" }, AgentWorkflowFailure>;
	readonly steerAgent: (
		agentId: string,
		instruction: string,
		mode?: "steer" | "interrupt",
	) => Effect.Effect<{ readonly agent: string; readonly status: "running" }, AgentWorkflowFailure>;
	readonly cancelAgent: (
		agentId: string,
	) => Effect.Effect<{ readonly agent: string; readonly status: "cancelled" }, AgentWorkflowFailure>;
	readonly answerAgent: (agentId: string, answer: string) => Effect.Effect<ParentRequest, AgentWorkflowFailure>;
	/** Create the only communication capability a direct child receives for asking its parent. */
	readonly childCommunication: (agentId: string) => AgentChildCommunication;
	readonly dispose: () => Effect.Effect<void, AgentWorkflowFailure>;
}

export interface AgentChildCommunication {
	readonly askParent: (message: string, options?: readonly string[]) => Effect.Effect<string, AgentWorkflowFailure>;
}

export interface AgentWorkflowOptions {
	readonly store: AgentStore;
	readonly sessions: AgentSessionOwner;
	readonly models: ProfileModelLookup;
	readonly profileDirectory?: string;
	/** Absent for a root session, which may spawn any profile. */
	readonly capabilityPolicy?: ProfileCapabilityPolicy;
	/** Called after each durable mailbox event is published, for host-side safe-point delivery. */
	readonly onEvent?: (event: MailboxEvent) => void;
}

interface AgentJob {
	readonly started: Deferred.Deferred<void, AgentWorkflowError>;
	readonly completion: Deferred.Deferred<AgentInvocationResult>;
}

interface ParentWaiter {
	readonly invocationId: string;
	readonly deferred: Deferred.Deferred<string>;
}

const TERMINAL_STATUSES = new Set<AgentRecord["status"]>(["settled", "interrupted", "cancelled", "error"]);

/**
 * Application workflows for one parent's direct children. The caller owns this service's scope;
 * background invocations live there rather than under the spawn tool's cancellable fiber.
 */
export const createAgentWorkflows = Effect.fn("createAgentWorkflows")(function* (options: AgentWorkflowOptions) {
	const fibers = yield* FiberSet.make<AgentInvocationResult>();
	const fork = yield* FiberSet.runtime(fibers)();
	const jobs = yield* Ref.make(new Map<string, AgentJob>());
	const parentWaiters = yield* SynchronizedRef.make(new Map<string, ParentWaiter>());
	const events = yield* PubSub.unbounded<MailboxEvent>();
	let closed = false;

	const publish = (event: MailboxEvent) =>
		PubSub.publish(events, event).pipe(
			Effect.tap(() => Effect.sync(() => options.onEvent?.(event))),
			Effect.asVoid,
		);

	const publishInvocationEvent = Effect.fnUntraced(function* (result: AgentInvocationResult) {
		const pending = yield* options.store.pendingEvents([result.agent]);
		const event = pending.find(
			(candidate) => candidate.invocationId === result.invocationId && candidate.type === result.status,
		);
		if (event !== undefined) yield* publish(event);
	});

	const runInvocation = (agentId: string, message: string, job: AgentJob) =>
		Effect.gen(function* () {
			const invoked = yield* Effect.result(
				options.sessions.invoke(agentId, message, Deferred.succeed(job.started, undefined).pipe(Effect.asVoid)),
			);
			let result: AgentInvocationResult;
			if (Result.isSuccess(invoked)) {
				result = invoked.success;
			} else {
				const error = toError(invoked.failure).message || "The agent invocation failed.";
				yield* Deferred.fail(job.started, new AgentWorkflowError({ message: error }));
				const agent = yield* options.store.getAgent(agentId);
				if (agent !== undefined && (agent.status === "running" || agent.status === "waiting_parent")) {
					const recorded = yield* Effect.result(
						options.store.finishInvocation({
							agentId,
							invocationId: agent.invocationId,
							status: "error",
							error,
							occurredAt: Date.now(),
						}),
					);
					if (Result.isFailure(recorded)) {
						yield* Effect.logError(`Could not persist failed invocation for "${agentId}": ${String(recorded.failure)}`);
					}
				}
				result = {
					agent: agentId,
					invocationId: agent?.invocationId ?? "unknown",
					status: "error",
					error,
				};
			}
			yield* publishInvocationEvent(result);
			return result;
		}).pipe(
			Effect.exit,
			Effect.flatMap((exit) =>
				Effect.gen(function* () {
					if (Exit.isFailure(exit)) {
						const error = causeMessage(exit);
						yield* Deferred.fail(job.started, new AgentWorkflowError({ message: error }));
						const agent = yield* options.store.getAgent(agentId);
						if (agent !== undefined && (agent.status === "running" || agent.status === "waiting_parent")) {
							const recorded = yield* Effect.result(
								options.store.finishInvocation({
									agentId,
									invocationId: agent.invocationId,
									status: "error",
									error,
									occurredAt: Date.now(),
								}),
							);
							if (Result.isSuccess(recorded)) {
								yield* publish(recorded.success);
							} else {
								yield* Effect.logError(
									`Could not persist failed invocation for "${agentId}": ${String(recorded.failure)}`,
								);
							}
						}
					}
					const result = Exit.isSuccess(exit)
						? exit.value
						: {
								agent: agentId,
								invocationId: "unknown",
								status: "error" as const,
								error: causeMessage(exit),
							};
					yield* Ref.update(jobs, (current) => {
						if (current.get(agentId) !== job) return current;
						const next = new Map(current);
						next.delete(agentId);
						return next;
					});
					yield* Deferred.succeed(job.completion, result);
					return result;
				}),
			),
		);

	const launch = Effect.fnUntraced(function* (agentId: string, message: string) {
		return yield* Effect.uninterruptible(
			Effect.gen(function* () {
				if (closed) return yield* new AgentWorkflowError({ message: "Agent workflows are shutting down." });
				const job: AgentJob = {
					started: yield* Deferred.make<void, AgentWorkflowError>(),
					completion: yield* Deferred.make<AgentInvocationResult>(),
				};
				const reserved = yield* Ref.modify(jobs, (current) => {
					if (current.has(agentId)) return [false, current] as const;
					const next = new Map(current);
					next.set(agentId, job);
					return [true, next] as const;
				});
				if (!reserved) {
					return yield* new AgentWorkflowError({ message: `Agent "${agentId}" already has an active invocation.` });
				}
				fork(runInvocation(agentId, message, job), { propagateInterruption: false });
				yield* Deferred.await(job.started);
				return job;
			}),
		);
	});

	const spawnAgent: AgentWorkflows["spawnAgent"] = Effect.fnUntraced(function* (input: SpawnAgentInput) {
		if (input.message.trim().length === 0)
			return yield* new AgentWorkflowError({ message: "An initial agent message must not be blank." });
		if (options.capabilityPolicy?.allowsSpawnProfile(input.profile) === false) {
			return yield* new AgentWorkflowError({
				message: `Profile "${options.capabilityPolicy.profile}" is not allowed to spawn profile "${input.profile}".`,
			});
		}
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const profile = yield* restore(loadProfile(input.profile, options.models, options.profileDirectory));
				const agent = yield* options.sessions.registerAgent(profile, input.cwd);
				yield* launch(agent.id, input.message);
				if (input.mode === "wait") {
					const received = yield* restore(waitAgent([agent.id]));
					return received.length === 1 ? received[0]! : { events: received };
				}
				return { agent: agent.id, status: "running" as const };
			}),
		);
	});

	const waitAgent: AgentWorkflows["waitAgent"] = Effect.fnUntraced(function* (agentIds: readonly string[]) {
		const ids = [...new Set(agentIds)];
		if (ids.length === 0 || ids.some((id) => id.trim().length === 0)) {
			return yield* new AgentWorkflowError({ message: "wait_agent requires one or more agent IDs." });
		}
		for (const id of ids) {
			if ((yield* options.store.getAgent(id)) === undefined) {
				return yield* new AgentWorkflowError({ message: `Unknown direct child agent "${id}".` });
			}
		}
		const claimId = randomUUID();
		const deliver = () =>
			Effect.gen(function* () {
				const claimed = yield* options.store.claimEvents(claimId, ids);
				if (claimed.length > 0) {
					yield* options.store.acknowledgeEvents(
						claimId,
						claimed.map((event) => event.id),
						Date.now(),
					);
					return claimed.map(toEventResult);
				}
				return [];
			});
		const releaseAndNotify = Effect.gen(function* () {
			yield* options.store.releaseClaim(claimId);
			for (const event of yield* options.store.pendingEvents(ids)) {
				if (event.claimId === undefined) yield* publish(event);
			}
		});
		return yield* Effect.ensuring(
			Effect.scoped(
				Effect.gen(function* () {
					const subscription = yield* PubSub.subscribe(events);
					const selected = new Set(ids);
					const pending = yield* options.store.pendingEvents(ids);
					if (pending.length > 0) {
						const claimed = yield* deliver();
						if (claimed.length > 0) return claimed;
					}
					while (true) {
						const arrived = yield* PubSub.take(subscription);
						if (!selected.has(arrived.agentId)) continue;
						const claimed = yield* deliver();
						if (claimed.length > 0) return claimed;
					}
				}),
			),
			releaseAndNotify.pipe(Effect.orDie),
		);
	});

	const listAgents: AgentWorkflows["listAgents"] = () => options.store.listAgents().pipe(Effect.map(listAgentRecords));

	const inspectAgent: AgentWorkflows["inspectAgent"] = Effect.fnUntraced(function* (agentId: string) {
		const agent = yield* requireDirectAgent(options.store, agentId);
		const activity = yield* options.sessions.getActivity(agentId);
		return inspectAgentRecord(agent, [], activity);
	});

	const sendAgent: AgentWorkflows["sendAgent"] = Effect.fnUntraced(function* (agentId: string, message: string) {
		if (message.trim().length === 0)
			return yield* new AgentWorkflowError({ message: "An agent message must not be blank." });
		const agent = yield* requireDirectAgent(options.store, agentId);
		if (agent.status === "waiting_parent") {
			return yield* new AgentWorkflowError({
				message: `Agent "${agentId}" is waiting for a parent answer; use answer_agent.`,
			});
		}
		if (!TERMINAL_STATUSES.has(agent.status)) {
			return yield* new AgentWorkflowError({ message: `Agent "${agentId}" is active; use steer_agent.` });
		}
		yield* launch(agentId, message);
		return { agent: agentId, status: "running" as const };
	});

	const steerAgent: AgentWorkflows["steerAgent"] = Effect.fnUntraced(function* (
		agentId: string,
		instruction: string,
		mode: "steer" | "interrupt" = "steer",
	) {
		if (instruction.trim().length === 0)
			return yield* new AgentWorkflowError({ message: "A steering instruction must not be blank." });
		const agent = yield* requireDirectAgent(options.store, agentId);
		if (agent.status === "waiting_parent") {
			return yield* new AgentWorkflowError({
				message: `Agent "${agentId}" is waiting for a parent answer; use answer_agent.`,
			});
		}
		if (agent.status !== "running")
			return yield* new AgentWorkflowError({ message: `Agent "${agentId}" is not running; use send_agent.` });
		if (mode === "steer") {
			yield* options.sessions.steer(agentId, instruction);
			return { agent: agentId, status: "running" as const };
		}
		const job = yield* getJob(agentId);
		yield* options.sessions.stop(agentId, "interrupted");
		yield* Deferred.await(job.completion);
		yield* launch(agentId, instruction);
		return { agent: agentId, status: "running" as const };
	});

	const cancelAgent: AgentWorkflows["cancelAgent"] = Effect.fnUntraced(function* (agentId: string) {
		const agent = yield* requireDirectAgent(options.store, agentId);
		if (agent.status !== "running" && agent.status !== "waiting_parent") {
			return yield* new AgentWorkflowError({ message: `Agent "${agentId}" has no active invocation to cancel.` });
		}
		const job = yield* getJob(agentId);
		yield* options.sessions.stop(agentId, "cancelled");
		const result = yield* Deferred.await(job.completion);
		if (result.status !== "cancelled") {
			return yield* new AgentWorkflowError({
				message: `Agent "${agentId}" stopped as ${result.status}, not cancelled.`,
			});
		}
		return { agent: agentId, status: "cancelled" as const };
	});

	const askParentFor = (agentId: string, message: string, suggestedOptions?: readonly string[]) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				if (message.trim().length === 0) {
					return yield* new AgentWorkflowError({ message: "A parent request must not be blank." });
				}
				const agent = yield* requireDirectAgent(options.store, agentId);
				if (agent.status !== "running" || !(yield* hasJob(agentId))) {
					return yield* new AgentWorkflowError({
						message: `Agent "${agentId}" has no live invocation to ask its parent.`,
					});
				}
				const deferred = yield* Deferred.make<string>();
				const waiter: ParentWaiter = { invocationId: agent.invocationId, deferred };
				const admitted = yield* SynchronizedRef.modify(parentWaiters, (current) => {
					if (current.has(agentId)) return [false, current] as const;
					const next = new Map(current);
					next.set(agentId, waiter);
					return [true, next] as const;
				});
				if (!admitted) {
					return yield* new AgentWorkflowError({ message: `Agent "${agentId}" already has a pending parent request.` });
				}
				return yield* Effect.ensuring(
					Effect.gen(function* () {
						const request = yield* options.store.requestParent({
							agentId,
							invocationId: agent.invocationId,
							requestId: randomUUID(),
							message,
							...(suggestedOptions === undefined ? {} : { options: suggestedOptions }),
							occurredAt: Date.now(),
						});
						yield* publish(request.event);
						yield* restore(Deferred.await(deferred));
						return yield* options.store.consumeParentAnswer(agentId, agent.invocationId);
					}),
					SynchronizedRef.update(parentWaiters, (current) => {
						if (current.get(agentId) !== waiter) return current;
						const next = new Map(current);
						next.delete(agentId);
						return next;
					}),
				);
			}),
		);

	const answerAgent: AgentWorkflows["answerAgent"] = Effect.fnUntraced(function* (agentId: string, answer: string) {
		if (answer.trim().length === 0)
			return yield* new AgentWorkflowError({ message: "An agent answer must not be blank." });
		return yield* SynchronizedRef.modifyEffect<Map<string, ParentWaiter>, ParentRequest, AgentWorkflowFailure, never>(
			parentWaiters,
			(current) => {
				const waiter = current.get(agentId);
				if (waiter === undefined) {
					return Effect.fail(
						new AgentWorkflowError({ message: `Agent "${agentId}" has no live parent request to answer.` }),
					);
				}
				return Effect.uninterruptible(
					Effect.gen(function* () {
						const agent = yield* options.store.getAgent(agentId);
						if (
							agent === undefined ||
							agent.status !== "waiting_parent" ||
							agent.invocationId !== waiter.invocationId ||
							agent.parentRequest?.invocationId !== waiter.invocationId
						) {
							return yield* new AgentWorkflowError({
								message: `Agent "${agentId}" has no matching live parent request.`,
							});
						}
						const request = yield* options.store.answerParent(agentId, answer);
						const completed = yield* Deferred.succeed(waiter.deferred, answer);
						if (!completed) {
							return yield* new AgentWorkflowError({ message: `Parent request for "${agentId}" was already resumed.` });
						}
						const next = new Map(current);
						next.delete(agentId);
						return [request, next] as const;
					}),
				);
			},
		);
	});

	const getJob = Effect.fnUntraced(function* (agentId: string) {
		const job = (yield* Ref.get(jobs)).get(agentId);
		if (job === undefined)
			return yield* new AgentWorkflowError({ message: `Agent "${agentId}" has no live invocation.` });
		return job;
	});

	const hasJob = (agentId: string) => Ref.get(jobs).pipe(Effect.map((current) => current.has(agentId)));

	const dispose = Effect.fnUntraced(function* () {
		if (closed) return;
		closed = true;
		yield* options.sessions.dispose();
		yield* FiberSet.awaitEmpty(fibers);
	});

	return {
		events,
		listAgents,
		inspectAgent,
		spawnAgent,
		waitAgent,
		sendAgent,
		steerAgent,
		cancelAgent,
		childCommunication: (agentId: string) => ({
			askParent: (message: string, suggestedOptions?: readonly string[]) =>
				askParentFor(agentId, message, suggestedOptions),
		}),
		dispose: () => dispose(),
		answerAgent,
	};
});

function toEventResult(event: MailboxEvent): AgentEventResult {
	return {
		agent: event.agentId,
		event: event.type,
		...(event.message === undefined ? {} : { message: event.message }),
		...(event.options === undefined ? {} : { options: event.options }),
		...(event.error === undefined ? {} : { error: event.error }),
	};
}

function causeMessage(exit: Exit.Exit<unknown, unknown>): string {
	return Exit.isFailure(exit) ? String(exit.cause) : "The agent invocation failed.";
}

function requireDirectAgent(store: AgentStore, agentId: string): Effect.Effect<AgentRecord, AgentWorkflowFailure> {
	return Effect.gen(function* () {
		const agent = yield* store.getAgent(agentId);
		if (agent === undefined)
			return yield* new AgentWorkflowError({ message: `Unknown direct child agent "${agentId}".` });
		return agent;
	});
}
