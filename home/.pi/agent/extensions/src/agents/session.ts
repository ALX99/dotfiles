import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentActivityOutcome,
	type AgentSession,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Effect, Result, Schema } from "effect";

import type { ApplicationEffects } from "../application.ts";
import { createToolSelection } from "../integration/tool-selection.ts";
import systemPromptExtension from "../context/system-prompt/systemprompt.ts";
import {
	appendLiveActivity,
	createAgentActivityRefreshThrottle,
	latestActivityTimestamp,
	observeSessionEvent,
	projectAgentFooterRows,
	type AgentActivity,
	type AgentFooterMetrics,
	type AgentFooterRow,
} from "./inspection.ts";
import type { FsError } from "../support/errors.ts";
import { toError } from "../support/errors.ts";
import { AgentStateError, type AgentRecord, type LifecycleEventType } from "./state.ts";
import { createCapabilityPolicy, installToolExecutionPolicy } from "./policy.ts";
import type { ProfileSnapshot } from "./profile.ts";
import type { AgentStore, AgentStoreError } from "./store.ts";
import { sessionTotals } from "../support/session-totals.ts";

export type AgentStopIntent = "interrupted" | "cancelled";

export interface ClassifiedInvocation {
	readonly status: LifecycleEventType;
	readonly error?: string;
}

/** Classify Pi's explicit pre-settlement outcome; `agent_settled` alone is not informative. */
export function classifyInvocationOutcome(
	outcome: AgentActivityOutcome | undefined,
	stopIntent?: AgentStopIntent,
	failure?: unknown,
): ClassifiedInvocation {
	if (failure !== undefined || outcome === "error") {
		const message = failure === undefined ? "The agent runtime reported an error." : toError(failure).message;
		return { status: "error", error: message.trim().length > 0 ? message : "The agent runtime failed." };
	}
	if (outcome === "aborted") return { status: stopIntent ?? "interrupted" };
	if (outcome === "completed") return { status: "settled" };
	if (stopIntent !== undefined) return { status: stopIntent };
	return { status: "settled" };
}

export class AgentSessionOwnerError extends Schema.TaggedError<AgentSessionOwnerError>()("AgentSessionOwnerError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export interface InvocationObservation {
	outcome: AgentActivityOutcome | undefined;
}

export interface AgentSessionOwnerOptions {
	readonly store: AgentStore;
	/** Current parent cwd. A caller may pass a fresher cwd to registerAgent. */
	readonly parentCwd?: string;
	readonly agentDir?: string;
	readonly sessionDirectory?: string;
	/** Reuse the host's configured model runtime when one is available. */
	readonly modelRuntime?: ModelRuntime;
	/** Copy providers registered by the active parent Pi extension runtime. */
	readonly providerRegistry?: Pick<
		ModelRegistry,
		"getRegisteredProviderIds" | "getRegisteredNativeProvider" | "getRegisteredProviderConfig"
	>;
	/** Child-safe extensions are supplied by the orchestrator; profile enforcement is always installed. */
	readonly extensionFactories?: (
		agent: AgentRecord,
		observation: InvocationObservation,
		modelRuntime: ModelRuntime,
		registerDisposer: (dispose: () => void | Promise<void>) => void,
	) => readonly ExtensionFactory[];
	/** Disable configured disk extensions in isolated tests or specialized hosts. */
	readonly noConfiguredExtensions?: boolean;
	/** Bind host observation or test behavior before the first child prompt. */
	readonly onSessionCreated?: (session: AgentSession, agent: AgentRecord) => void;
	/** Notify a footer observer when a child session becomes live or appends an entry. */
	readonly onSessionChanged?: (agentId: string) => void;
}

export interface AgentInvocationResult {
	readonly agent: string;
	readonly invocationId: string;
	readonly status: LifecycleEventType;
	readonly error?: string;
}

export interface AgentSessionOwner {
	readonly registerAgent: (
		profile: ProfileSnapshot,
		cwd?: string,
	) => Effect.Effect<AgentRecord, AgentStateError | FsError>;
	readonly invoke: (
		agentId: string,
		message: string,
		onStarted?: Effect.Effect<void>,
	) => Effect.Effect<AgentInvocationResult, AgentStateError | AgentStoreError | FsError>;
	readonly stop: (agentId: string, intent: AgentStopIntent) => Effect.Effect<void, AgentStateError>;
	readonly steer: (agentId: string, instruction: string) => Effect.Effect<void, AgentStateError>;
	readonly getSession: (agentId: string) => Effect.Effect<AgentSession | undefined>;
	readonly getActivity: (
		agentId: string,
	) => Effect.Effect<readonly AgentActivity[], AgentStateError | AgentSessionOwnerError>;
	readonly getFooterRows: (modelRegistry: Pick<ModelRegistry, "find">) => Effect.Effect<readonly AgentFooterRow[]>;
	readonly dispose: () => Effect.Effect<void, AgentSessionOwnerError | AgentStoreError | FsError | AgentStateError>;
}

interface ChildSession {
	readonly session: AgentSession;
	readonly observation: InvocationObservation;
	readonly dispose: () => Promise<void>;
}

interface ActiveInvocation {
	invocationId: string;
	stopIntent?: AgentStopIntent;
	session?: AgentSession;
	promptStarted: boolean;
	pendingSteering: string[];
	abortPromise?: Promise<void>;
	readonly done: Promise<void>;
	readonly resolveDone: () => void;
}

/** Owns normal Pi JSONL sessions and the invocation lifetime associated with each persistent agent. */
export const createAgentSessionOwner = Effect.fn("createAgentSessionOwner")(function* (
	options: AgentSessionOwnerOptions,
): Effect.fn.Return<AgentSessionOwner, AgentSessionOwnerError | AgentStoreError | FsError | AgentStateError> {
	const agentDir = options.agentDir ?? getAgentDir();
	const sessionDirectory = options.sessionDirectory ?? join(agentDir, "agents", "sessions");
	const parentCwd = options.parentCwd ?? process.cwd();
	const modelRuntime =
		options.modelRuntime ??
		(yield* Effect.tryPromise({
			try: () =>
				ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					allowModelNetwork: false,
					refreshOnCreate: false,
				}),
			catch: (cause) =>
				new AgentSessionOwnerError({
					message: "Could not initialize the shared Pi model runtime for child agents.",
					cause,
				}),
		}));
	if (options.modelRuntime === undefined && options.providerRegistry !== undefined) {
		for (const providerId of options.providerRegistry.getRegisteredProviderIds()) {
			const provider = options.providerRegistry.getRegisteredNativeProvider(providerId);
			if (provider !== undefined) {
				modelRuntime.registerNativeProvider(provider);
				continue;
			}
			const config = options.providerRegistry.getRegisteredProviderConfig(providerId);
			if (config !== undefined) modelRuntime.registerProvider(providerId, config);
		}
	}

	const sessions = new Map<string, ChildSession>();
	const liveActivity = new Map<string, readonly AgentActivity[]>();
	const activityRefreshThrottle = createAgentActivityRefreshThrottle();
	const active = new Map<string, ActiveInvocation>();
	const firstInvocations = new Set<string>();
	let closed = false;

	const notifySessionChanged = (agentId: string): void => {
		if (!closed) options.onSessionChanged?.(agentId);
	};

	// A JavaScript process cannot restore an in-flight provider call or its Deferred stack.
	// Mark stale invocations interrupted while retaining their agents and JSONL sessions.
	for (const agent of yield* options.store.listAgents()) {
		if (agent.status !== "running" && agent.status !== "waiting_parent") continue;
		yield* options.store.finishInvocation({
			agentId: agent.id,
			invocationId: agent.invocationId,
			status: "interrupted",
			occurredAt: Date.now(),
		});
	}

	const registerAgent: AgentSessionOwner["registerAgent"] = Effect.fnUntraced(function* (
		profile: ProfileSnapshot,
		cwd?: string,
	): Effect.fn.Return<AgentRecord, AgentStateError | FsError> {
		if (closed) return yield* new AgentStateError({ message: "Agent session owner is closed." });
		const workingDirectory = cwd ?? parentCwd;
		if (workingDirectory.trim().length === 0) {
			return yield* new AgentStateError({ message: "A child agent requires a working directory." });
		}
		const agent = yield* options.store.createAgent({
			profile,
			sessionId: randomUUID(),
			cwd: workingDirectory,
			invocationId: randomUUID(),
			createdAt: Date.now(),
		});
		firstInvocations.add(agent.id);
		return agent;
	});

	const invoke: AgentSessionOwner["invoke"] = Effect.fnUntraced(function* (
		agentId: string,
		message: string,
		onStarted?: Effect.Effect<void>,
	): Effect.fn.Return<AgentInvocationResult, AgentStateError | AgentStoreError | FsError> {
		if (closed) return yield* new AgentStateError({ message: "Agent session owner is closed." });
		if (message.trim().length === 0)
			return yield* new AgentStateError({ message: "An agent message must not be blank." });

		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const control: ActiveInvocation = {
			invocationId: "",
			promptStarted: false,
			pendingSteering: [],
			done,
			resolveDone,
		};
		if (active.has(agentId)) return yield* new AgentStateError({ message: `Agent "${agentId}" is already running.` });
		active.set(agentId, control);

		return yield* Effect.ensuring(
			Effect.gen(function* () {
				const agent = yield* options.store.getAgent(agentId);
				if (agent === undefined) return yield* new AgentStateError({ message: `Unknown agent "${agentId}".` });

				let invocationId = agent.invocationId;
				if (firstInvocations.delete(agentId)) {
					if (agent.status !== "running") {
						return yield* new AgentStateError({ message: `Agent "${agentId}" has no initial invocation to start.` });
					}
				} else if (
					agent.status === "settled" ||
					agent.status === "interrupted" ||
					agent.status === "cancelled" ||
					agent.status === "error"
				) {
					invocationId = randomUUID();
					yield* options.store.startInvocation(agentId, invocationId);
				} else {
					return yield* new AgentStateError({ message: `Agent "${agentId}" already has an active invocation.` });
				}
				control.invocationId = invocationId;
				if (onStarted !== undefined) yield* onStarted;

				const execution = yield* Effect.result(
					Effect.tryPromise({
						try: async () => {
							let child = sessions.get(agentId);
							if (child === undefined) {
								child = await createChildSession({
									agent,
									agentDir,
									sessionDirectory,
									modelRuntime,
									...(options.noConfiguredExtensions === undefined
										? {}
										: { noConfiguredExtensions: options.noConfiguredExtensions }),
									...(options.extensionFactories === undefined
										? {}
										: { extensionFactories: options.extensionFactories }),
								});
								sessions.set(agentId, child);
								child.session.subscribe((event) => {
									const observed = observeSessionEvent(event);
									if (observed.length > 0) {
										liveActivity.set(agentId, appendLiveActivity(liveActivity.get(agentId) ?? [], observed));
									}
									if (event.type === "message_update" && observed.length > 0) {
										const occurredAt = observed[0]!.occurredAt;
										if (
											options.onSessionChanged !== undefined &&
											activityRefreshThrottle.shouldRefresh(agentId, occurredAt)
										) {
											notifySessionChanged(agentId);
										}
									} else if (event.type === "message_end") {
										// Pi emits message_end before appending; defer until the native log has committed the message.
										queueMicrotask(() => notifySessionChanged(agentId));
									} else if (
										event.type === "entry_appended" ||
										event.type === "agent_end" ||
										event.type === "compaction_end"
									) {
										notifySessionChanged(agentId);
									}
								});
								options.onSessionCreated?.(child.session, agent);
								notifySessionChanged(agentId);
							}

							control.session = child.session;
							child.observation.outcome = undefined;
							activityRefreshThrottle.reset(agentId);
							const prompt = child.session.prompt(message);
							control.promptStarted = true;
							for (const instruction of control.pendingSteering.splice(0)) {
								await child.session.steer(instruction);
							}
							if (control.stopIntent !== undefined) control.abortPromise = child.session.abort();
							await prompt;
							if (control.abortPromise !== undefined) await control.abortPromise;
							return child.observation.outcome;
						},
						catch: toError,
					}),
				);

				const failure = Result.isFailure(execution) ? execution.failure : undefined;
				const outcome = Result.isSuccess(execution) ? execution.success : undefined;
				const classified = classifyInvocationOutcome(outcome, control.stopIntent, failure);
				yield* options.store.finishInvocation({
					agentId,
					invocationId,
					status: classified.status,
					occurredAt: Date.now(),
					...(classified.error === undefined ? {} : { error: classified.error }),
				});
				return {
					agent: agentId,
					invocationId,
					status: classified.status,
					...(classified.error === undefined ? {} : { error: classified.error }),
				};
			}),
			Effect.sync(() => {
				active.delete(agentId);
				control.resolveDone();
			}),
		);
	});

	const stop: AgentSessionOwner["stop"] = Effect.fnUntraced(function* (
		agentId: string,
		intent: AgentStopIntent,
	): Effect.fn.Return<void, AgentStateError> {
		const control = active.get(agentId);
		if (control === undefined) {
			return yield* new AgentStateError({ message: `Agent "${agentId}" has no active invocation.` });
		}
		if (control.stopIntent !== undefined && control.stopIntent !== intent) {
			return yield* new AgentStateError({ message: `Agent "${agentId}" already has a different stop request.` });
		}
		control.stopIntent = intent;
		if (control.session !== undefined) {
			if (control.session.isIdle) {
				return yield* new AgentStateError({ message: `Agent "${agentId}" is already idle.` });
			}
			control.abortPromise ??= control.session.abort();
			yield* Effect.tryPromise({
				try: () => control.abortPromise!,
				catch: (cause) =>
					new AgentStateError({ message: `Could not stop agent "${agentId}": ${toError(cause).message}` }),
			});
		}
		return yield* Effect.void;
	});

	const getSession: AgentSessionOwner["getSession"] = (agentId) => Effect.sync(() => sessions.get(agentId)?.session);

	const getActivity: AgentSessionOwner["getActivity"] = Effect.fnUntraced(function* (agentId) {
		const agent = yield* options.store.getAgent(agentId);
		if (agent === undefined) return yield* new AgentStateError({ message: `Unknown agent "${agentId}".` });
		const current = sessions.get(agentId)?.session.sessionManager;
		const entries = yield* Effect.try({
			try: (): readonly SessionEntry[] => {
				if (current !== undefined) return current.getBranch();
				const sessionFile = SessionManager.findById(agent.cwd, agent.sessionId, sessionDirectory);
				if (sessionFile === undefined) return [];
				return SessionManager.open(sessionFile, sessionDirectory, agent.cwd).getBranch();
			},
			catch: (cause) =>
				new AgentSessionOwnerError({
					message: `Could not read activity for agent "${agentId}": ${toError(cause).message}`,
					cause,
				}),
		});
		return appendLiveActivity(
			[],
			[
				...entries.flatMap((entry) => observeSessionEvent({ type: "entry_appended", entry })),
				...(liveActivity.get(agentId) ?? []),
			],
		);
	});

	const getFooterRows: AgentSessionOwner["getFooterRows"] = Effect.fnUntraced(function* (modelRegistry) {
		const records = yield* options.store.listAgents();
		const metricsByAgent = new Map<string, AgentFooterMetrics>();
		for (const agent of records) {
			const result = yield* Effect.result(
				Effect.try({
					try: (): AgentFooterMetrics => {
						const resident = sessions.get(agent.id)?.session;
						let sessionManager = resident?.sessionManager;
						if (sessionManager === undefined) {
							const sessionFile = SessionManager.findById(agent.cwd, agent.sessionId, sessionDirectory);
							if (sessionFile !== undefined) {
								sessionManager = SessionManager.open(sessionFile, sessionDirectory, agent.cwd);
							}
						}

						let model = agent.profile.model;
						const entries = sessionManager?.getBranch() ?? [];
						if (entries.length > 0) {
							for (const entry of entries.toReversed()) {
								if (entry.type === "model_change") {
									model = { provider: entry.provider, id: entry.modelId };
									break;
								}
							}
						}

						const contextUsage = resident?.getContextUsage();
						const contextWindow =
							contextUsage?.contextWindow ?? modelRegistry.find(model.provider, model.id)?.contextWindow;
						return {
							model,
							...(sessionManager === undefined
								? {}
								: { totalTokens: sessionTotals(sessionManager.getEntries()).totalTokens }),
							lastActivityAt: latestActivityTimestamp(entries, liveActivity.get(agent.id) ?? []),
							...(contextUsage === undefined ? {} : { contextUsage }),
							...(contextWindow === undefined ? {} : { contextWindow }),
						};
					},
					catch: (cause) =>
						new AgentSessionOwnerError({
							message: `Could not read footer metrics for agent "${agent.id}": ${toError(cause).message}`,
							cause,
						}),
				}),
			);
			if (Result.isSuccess(result)) {
				metricsByAgent.set(agent.id, result.success);
			} else {
				yield* Effect.logWarning(result.failure.message);
				const model = agent.profile.model;
				const contextWindow = modelRegistry.find(model.provider, model.id)?.contextWindow;
				metricsByAgent.set(agent.id, {
					model,
					lastActivityAt: latestActivityTimestamp([], liveActivity.get(agent.id) ?? []),
					...(contextWindow === undefined ? {} : { contextWindow }),
				});
			}
		}
		return projectAgentFooterRows(records, metricsByAgent);
	});

	const steer: AgentSessionOwner["steer"] = Effect.fnUntraced(function* (
		agentId: string,
		instruction: string,
	): Effect.fn.Return<void, AgentStateError> {
		if (instruction.trim().length === 0) {
			return yield* new AgentStateError({ message: "A steering instruction must not be blank." });
		}
		const control = active.get(agentId);
		if (control === undefined)
			return yield* new AgentStateError({ message: `Agent "${agentId}" has no active invocation.` });
		if (control.stopIntent !== undefined)
			return yield* new AgentStateError({ message: `Agent "${agentId}" is stopping.` });
		if (control.session === undefined || !control.promptStarted) {
			control.pendingSteering.push(instruction);
			return yield* Effect.void;
		}
		yield* Effect.tryPromise({
			try: () => control.session!.steer(instruction),
			catch: (cause) =>
				new AgentStateError({ message: `Could not steer agent "${agentId}": ${toError(cause).message}` }),
		}).pipe(Effect.asVoid);
		return yield* Effect.void;
	});

	const dispose: AgentSessionOwner["dispose"] = Effect.fnUntraced(function* (): Effect.fn.Return<
		void,
		AgentSessionOwnerError | AgentStoreError | FsError | AgentStateError
	> {
		if (closed) return;
		closed = true;
		const activeRuns = [...active.values()];
		for (const control of activeRuns) {
			control.stopIntent ??= "interrupted";
			if (control.session !== undefined && !control.session.isIdle) {
				control.abortPromise ??= control.session.abort();
			}
		}
		yield* Effect.tryPromise({
			try: async () => {
				await Promise.all(
					activeRuns.flatMap((control) => [
						...(control.abortPromise === undefined ? [] : [control.abortPromise]),
						control.done,
					]),
				);
			},
			catch: (cause) =>
				new AgentSessionOwnerError({ message: "Could not stop child invocations during shutdown.", cause }),
		});
		yield* Effect.tryPromise({
			try: async () => {
				const results = await Promise.allSettled([...sessions.values()].map((child) => child.dispose()));
				sessions.clear();
				liveActivity.clear();
				activityRefreshThrottle.clear();
				const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (failures.length > 0) {
					throw new AggregateError(failures, "One or more child sessions failed to dispose cleanly.");
				}
			},
			catch: (cause) =>
				new AgentSessionOwnerError({
					message: "Could not dispose child sessions and their extension resources.",
					cause,
				}),
		});
	});

	return { registerAgent, invoke, stop, steer, getSession, getActivity, getFooterRows, dispose };
});

async function createChildSession(input: {
	readonly agent: AgentRecord;
	readonly agentDir: string;
	readonly sessionDirectory: string;
	readonly modelRuntime: ModelRuntime;
	readonly noConfiguredExtensions?: boolean;
	readonly extensionFactories?: AgentSessionOwnerOptions["extensionFactories"];
}): Promise<ChildSession> {
	const { agent } = input;
	const disposers: Array<() => void | Promise<void>> = [];
	let disposed = false;
	let session: AgentSession | undefined;
	const registerDisposer = (dispose: () => void | Promise<void>): void => {
		if (disposed) throw new Error("Cannot register an extension disposer after its child session is disposed.");
		disposers.push(dispose);
	};
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		const failures: unknown[] = [];
		for (const disposeResource of disposers.toReversed()) {
			try {
				await disposeResource();
			} catch (cause) {
				failures.push(cause);
			}
		}
		try {
			session?.dispose();
		} catch (cause) {
			failures.push(cause);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `Could not dispose agent "${agent.id}" runtime resources.`);
		}
	};
	try {
		const model = input.modelRuntime.getModel(agent.profile.model.provider, agent.profile.model.id);
		if (model === undefined)
			throw new Error(
				`Profile model "${agent.profile.model.provider}/${agent.profile.model.id}" is no longer available.`,
			);

		const policy = createCapabilityPolicy(agent.profile);
		const settingsManager = SettingsManager.create(agent.cwd, input.agentDir);
		const observation: InvocationObservation = { outcome: undefined };
		const profileExtension: ExtensionFactory = (pi) => {
			installToolExecutionPolicy(pi, policy);
			const selection = createToolSelection(pi, policy);
			pi.on("session_start", () => selection.applyCapabilityPolicy());
			pi.on("model_select", () => selection.applyCapabilityPolicy());
			pi.on("tool_result", () => selection.applyCapabilityPolicy());
			pi.on("agent_before_settle", (event) => {
				observation.outcome = event.outcome;
			});
			systemPromptExtension(pi, childApplicationEffects, {
				getPolicy: () => policy,
				getProfile: () => agent.profile,
			});
		};
		const extensions = [
			...(input.extensionFactories?.(agent, observation, input.modelRuntime, registerDisposer) ?? []),
			profileExtension,
		];
		const resourceLoader = new DefaultResourceLoader({
			cwd: agent.cwd,
			agentDir: input.agentDir,
			settingsManager,
			noExtensions: input.noConfiguredExtensions ?? true,
			extensionFactories: extensions,
			skillsOverride: (base) => ({ ...base, skills: policy.filterSkills(base.skills) }),
		});
		await resourceLoader.reload();

		const sessionFile = SessionManager.findById(agent.cwd, agent.sessionId, input.sessionDirectory);
		const sessionManager =
			sessionFile === undefined
				? SessionManager.create(agent.cwd, input.sessionDirectory, { id: agent.sessionId })
				: SessionManager.open(sessionFile, input.sessionDirectory, agent.cwd);
		const created = await createAgentSession({
			cwd: agent.cwd,
			agentDir: input.agentDir,
			model,
			modelRuntime: input.modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager,
			...(agent.profile.tools === undefined
				? {}
				: {
						tools: [
							...agent.profile.tools,
							"ask_parent",
							...(agent.profile.tools.length > 0 ? ["codemode", "tool_search"] : []),
						],
					}),
		});
		session = created.session;
		applyProfileThinkingLevel(session, agent.profile);
		await session.bindExtensions({ mode: "print" });
		return { session, observation, dispose };
	} catch (cause) {
		try {
			await dispose();
		} catch (cleanupCause) {
			console.error(
				`Agent "${agent.id}" failed to initialize and cleanup also failed: ${toError(cleanupCause).message}`,
			);
		}
		throw cause;
	}
}

export function applyProfileThinkingLevel(
	session: Pick<AgentSession, "getAvailableThinkingLevels" | "setThinkingLevel">,
	profile: Pick<ProfileSnapshot, "name" | "model" | "thinkingLevel">,
): void {
	const requested = profile.thinkingLevel;
	if (requested === undefined) return;

	const available = session.getAvailableThinkingLevels();
	if (!available.includes(requested)) {
		throw new Error(
			`Profile "${profile.name}" requests unsupported thinking level "${requested}" for model "${profile.model.provider}/${profile.model.id}". Available levels: ${available.join(", ")}.`,
		);
	}
	session.setThinkingLevel(requested);
}

const childApplicationEffects: ApplicationEffects = {
	run: (effect, options) => Effect.runPromise(effect, options),
	initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
};
