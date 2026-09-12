import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	type AgentSession,
	type SessionEntry,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { makeDirectory } from "../_shared/fs.ts";
import { Type } from "typebox";
import { toError } from "../_shared/errors.ts";
import { runFork, runPromise } from "../_shared/effect-runtime.ts";
import { getProcessReaper } from "../process-reaper/index.ts";
import type { AgentConfig } from "./agents.ts";
import {
	AgentWaitInterruptedError,
	CleanupAggregateError,
	lifecycleStatus,
	type AgentPhase,
	type AgentQuestion,
	type AgentSummary,
	type AgentView,
} from "./agent-types.ts";
import type { ResolvedRun } from "./profiles.ts";
import {
	assistantText,
	resultPreview,
	resultReference,
	storedResult,
	type GenerationResultLocator,
} from "./result-store.ts";
import {
	foldSessionEvent,
	initRunData,
	snapshotRunData,
	type MutableRunData,
	type ReadonlyRunDetails,
} from "./run-state.ts";
import {
	routeAgentTurnInput,
	type AgentTurnInput,
	type AnswerTurnInput,
	type FollowUpTurnInput,
	type StartTurnInput,
	type SteerTurnInput,
} from "./turn-routing.ts";

let nextAgentId = 1;

/** Terminates the process groups a child session started; failures cross as unknown values. */
export interface OwnedProcessTerminator {
	terminateOwner(ownerId: string): Effect.Effect<void, unknown>;
}

/** Why a child-session operation was rejected. */
export const ManagedAgentReason = Schema.Literals([
	"closed_while_starting",
	"missing_session",
	"missing_task_address",
	"session_not_opened",
	"missing_persisted_session",
	"no_active_generation",
	"question_already_pending",
	"question_cancelled",
	"missing_terminal_message",
]);
export type ManagedAgentReason = Schema.Schema.Type<typeof ManagedAgentReason>;

/** A rejected child-session operation; `message` is the text a tool reports. */
export class ManagedAgentError extends Schema.TaggedError<ManagedAgentError>()("ManagedAgentError", {
	reason: ManagedAgentReason,
	message: Schema.String,
}) {}

function agentError(reason: ManagedAgentReason, message: string): ManagedAgentError {
	return new ManagedAgentError({ reason, message });
}

/** Silent child time before a generation is considered stuck and aborted internally. */
export const AGENT_STALL_TIMEOUT_MS = 15 * 60 * 1_000;

function formatStallDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
	return `${Math.round(ms / 60_000)}m`;
}

export function reserveManagedAgentIds(agentIds: Iterable<string>): void {
	for (const id of agentIds) {
		const suffix = /-(\d+)$/.exec(id)?.[1];
		if (suffix && Number(suffix) >= nextAgentId) nextAgentId = Number(suffix) + 1;
	}
}

type AssistantSessionEntry = Extract<SessionEntry, { type: "message" }> & {
	readonly message: Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }>;
};

interface PendingQuestion {
	readonly question: AgentQuestion;
	/** Resolved by answer_agent, failed when the question is cancelled. */
	readonly answer: Deferred.Deferred<string, Error>;
}

interface Generation {
	readonly number: number;
	/** The single settlement point; its completion state is the generation's. */
	readonly settlement: Deferred.Deferred<ReadonlyRunDetails, Error>;
	/** Fires when a question arrives, so a waiting parent can return early. */
	arrival: Deferred.Deferred<void>;
	readonly run: MutableRunData;
	readonly initialEntryIds: ReadonlySet<string>;
	background: boolean;
	aborted: boolean;
	/** Set when the stall watchdog aborted this generation for inactivity. */
	stalled: boolean;
	question?: PendingQuestion;
}

/** A generation is over once its settlement is completed, once. */
function generationSettled(generation: Generation): boolean {
	return Deferred.isDoneUnsafe(generation.settlement);
}

function newArrival(): Deferred.Deferred<void> {
	return Deferred.makeUnsafe<void>();
}

export interface ManagedAgentOptions {
	readonly id?: string;
	readonly agentDir: string;
	readonly defaultCwd: string;
	readonly cwd?: string;
	readonly agent: AgentConfig;
	readonly resolvedRun: ResolvedRun;
	readonly retain: boolean;
	/** The one reaper operation a child owns, declared so tests can substitute it. */
	readonly processReaper?: OwnedProcessTerminator;
	/** Test seam for contract tests; production always constructs an SDK session. */
	readonly sessionFactory?: (customTools: readonly ToolDefinition[]) => Promise<AgentSession>;
	/** Test seam for the stall-watchdog threshold; production uses AGENT_STALL_TIMEOUT_MS. */
	readonly stallTimeoutMs?: number;
	readonly onBackgroundComplete?: (summary: AgentSummary) => void;
	readonly onQuestion?: (summary: AgentSummary, question: AgentQuestion) => void;
}

/**
 * The only live owner of a child conversation. It owns one AgentSession and
 * derives every public generation value from its native session entries/events.
 */
export class ManagedAgent {
	readonly id: string;
	private readonly listeners = new Set<(details: ReadonlyRunDetails) => void>();
	private readonly cwd: string;
	private readonly options: ManagedAgentOptions;
	private readonly processReaper: OwnedProcessTerminator;
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private phaseState: AgentPhase = "created";
	private current: Generation | undefined;
	private closePromise: Promise<void> | undefined;
	private stallFiber: Fiber.Fiber<void> | undefined;

	constructor(options: ManagedAgentOptions) {
		this.options = options;
		this.id = options.id ?? `${options.agent.name}-${nextAgentId++}`;
		this.cwd = options.cwd ?? options.defaultCwd;
		this.processReaper = options.processReaper ?? getProcessReaper();
	}

	get phase(): AgentPhase {
		return this.phaseState;
	}

	async start(
		message: string,
		handoff: string | undefined,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		return this.submit({ kind: "start", message, handoff, taskName, background, signal });
	}

	async followUp(message: string, background: boolean, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		return this.submit({ kind: "follow_up", message, background, signal });
	}

	async steer(message: string): Promise<void> {
		await this.submit({ kind: "steer", message });
	}

	async answerQuestion(questionId: string, answer: string): Promise<void> {
		await this.submit({ kind: "answer", questionId, answer });
	}

	private submit(input: StartTurnInput | FollowUpTurnInput): Promise<ReadonlyRunDetails>;
	private submit(input: SteerTurnInput | AnswerTurnInput): Promise<void>;
	private async submit(input: AgentTurnInput): Promise<ReadonlyRunDetails | void> {
		const route = routeAgentTurnInput(this.turnRoutingState(), input);
		switch (route.action) {
			case "open_and_launch":
				return this.openAndLaunch(route.input);
			case "launch":
				// Follow-up generations inherit the immutable task address claimed at
				// spawn; no caller may rename a live agent.
				return this.launch(route.input.message, this.followUpTaskName(), route.input.background, route.input.signal);
			case "steer":
				return this.steerActiveTurn(route.input);
			case "answer":
				return this.answerPendingQuestion(route.input);
		}
	}

	private async openAndLaunch(input: StartTurnInput): Promise<ReadonlyRunDetails> {
		this.phaseState = "starting";
		this.emit();
		try {
			await this.open();
			if (this.phaseState !== "starting") {
				this.disposeSession();
				throw agentError("closed_while_starting", `Agent ${this.id} was closed while its session was starting.`);
			}
			await this.session!.bindExtensions({
				mode: "print",
				onError: (error) =>
					process.emitWarning(`${error.extensionPath}: ${error.error}`, { type: "SubagentExtensionError" }),
			});
			if (this.phaseState !== "starting") {
				this.disposeSession();
				throw agentError("closed_while_starting", `Agent ${this.id} was closed while its session was starting.`);
			}
		} catch (cause) {
			if (this.phaseState === "starting") {
				this.disposeSession();
				this.phaseState = "failed";
				this.emit();
			}
			throw cause;
		}
		return this.launch(buildInitialTask(input.message, input.handoff), input.taskName, input.background, input.signal);
	}

	private async steerActiveTurn(input: SteerTurnInput): Promise<void> {
		const session = this.session;
		if (!session) throw agentError("missing_session", `Agent ${this.id} lost its running session.`);
		await session.steer(input.message);
	}

	private answerPendingQuestion(input: AnswerTurnInput): void {
		const current = this.current;
		const pending = current?.question;
		if (!current || !pending || pending.question.question_id !== input.questionId) {
			throw agentError("missing_session", `Agent ${this.id} lost its pending question.`);
		}
		this.clearPendingQuestion(current);
		Deferred.doneUnsafe(pending.answer, Effect.succeed(input.answer));
		this.emit();
	}

	/**
	 * Release a pending question and arm a fresh arrival signal. The child's
	 * question tool observes the completion of its own deferred.
	 */
	private clearPendingQuestion(generation: Generation): void {
		if (!generation.question) return;
		delete generation.question;
		generation.run.lastActivityTime = Date.now();
		generation.arrival = newArrival();
	}

	/** Wait for the parent's answer, releasing the question if the tool is cancelled. */
	private awaitAnswer(
		generation: Generation,
		question: AgentQuestion,
		answer: Deferred.Deferred<string, Error>,
		signal?: AbortSignal,
	): Effect.Effect<string, Error> {
		if (!signal) return Deferred.await(answer);
		return Effect.gen({ self: this }, function* () {
			const cancelled = Effect.callback<never, Error>((resume) => {
				const onAbort = () => {
					if (generation.question?.question.question_id === question.question_id) {
						this.clearPendingQuestion(generation);
						this.emit();
					}
					resume(
						Effect.fail(
							agentError(
								"question_cancelled",
								`Subagent question was cancelled: ${String(signal.reason ?? "aborted")}`,
							),
						),
					);
				};
				if (signal.aborted) {
					onAbort();
					return Effect.void;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				return Effect.sync(() => signal.removeEventListener("abort", onAbort));
			});
			return yield* Effect.raceFirst(Deferred.await(answer), cancelled);
		});
	}

	private turnRoutingState() {
		return {
			agentId: this.id,
			phase: this.phaseState,
			retained: this.options.retain,
			hasSession: this.session !== undefined,
			pendingQuestionId: this.current?.question?.question.question_id,
		};
	}

	private followUpTaskName(): string {
		const taskName = this.current?.run.taskName;
		if (!taskName) throw agentError("missing_task_address", `Agent ${this.id} lost its task address.`);
		return taskName;
	}

	async wait(signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const current = this.current;
		if (!current || generationSettled(current) || current.question) return this.snapshot();
		return this.waitFor(current, signal);
	}

	async interrupt(): Promise<void> {
		const current = this.current;
		if (!current || generationSettled(current) || !this.session) {
			await this.reapOwnedProcesses();
			this.finishInterruption();
			return;
		}
		current.aborted = true;
		this.phaseState = "interrupting";
		this.clearStallWatchdog();
		this.cancelPendingQuestion(current, `Agent ${this.id} was interrupted while waiting for input.`);
		this.emit();
		try {
			await this.session.abort();
		} finally {
			await this.reapOwnedProcesses();
			this.finishInterruption();
		}
	}

	private finishInterruption(): void {
		if (this.phaseState !== "interrupting") return;
		this.phaseState = "aborted";
		if (this.current) this.settle(this.current);
	}

	async close(): Promise<void> {
		if (this.phaseState === "closed") return;
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeSession();
		try {
			await this.closePromise;
		} finally {
			this.closePromise = undefined;
		}
	}

	private async closeSession(): Promise<void> {
		const failures: unknown[] = [];
		try {
			this.phaseState = "closing";
			this.clearStallWatchdog();
			this.emit();
			const current = this.current;
			if (current && !generationSettled(current)) {
				current.aborted = true;
				this.cancelPendingQuestion(current, `Agent ${this.id} was closed while waiting for input.`);
				try {
					await this.session?.abort();
				} catch (error) {
					failures.push(error);
				}
				// abort() waits for Pi to reach idle, but settle defensively here as
				// well so an incomplete or misbehaving session cannot leave a live
				// generation behind after its owner is archived.
				this.settle(current);
			}
			await this.session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await this.reapOwnedProcesses();
		} catch (error) {
			failures.push(error);
		} finally {
			try {
				this.disposeSession();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new CleanupAggregateError(`Agent ${this.id}`, failures);
		this.phaseState = "closed";
		this.emit();
		this.listeners.clear();
	}

	summary(): AgentSummary {
		const details = this.snapshot();
		const durationMs = details.endTime === undefined ? undefined : Math.max(0, details.endTime - details.startTime);
		return {
			agent_id: this.id,
			agent: details.agent,
			task_name: details.taskName,
			profile: details.profile,
			model: details.model,
			effective_thinking: details.effectiveThinking,
			...(details.sessionId ? { session_id: details.sessionId } : {}),
			...(details.sessionFile ? { session_file: details.sessionFile } : {}),
			generation: details.generation ?? 0,
			retained: this.options.retain,
			status: lifecycleStatus({ phase: this.phaseState }),
			started_at: details.startTime,
			...(details.endTime === undefined ? {} : { ended_at: details.endTime }),
			...(durationMs === undefined ? {} : { duration_ms: durationMs }),
			usage: details.usage,
			...(details.finalText ? { final_text: details.finalText } : {}),
			...(details.result ? { result: details.result } : {}),
			...(details.resultLocator ? { result_locator: details.resultLocator } : {}),
			...(details.error ? { error: details.error } : {}),
			...(details.pendingQuestion ? { pending_question: details.pendingQuestion } : {}),
		};
	}

	view(): AgentView {
		return { summary: this.summary(), details: this.snapshot() };
	}

	subscribe(listener: (details: ReadonlyRunDetails) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	occupiesCapacity(): boolean {
		if (this.phaseState === "closed") return false;
		return (
			this.phaseState === "created" ||
			this.phaseState === "starting" ||
			this.phaseState === "closing" ||
			this.session !== undefined
		);
	}

	/** True while the given generation is the live unsettled generation. */
	hasPendingResult(generation: number): boolean {
		return this.current?.number === generation && !generationSettled(this.current);
	}

	async getMessages(): Promise<unknown[]> {
		return this.session?.messages ?? [];
	}

	private async open(): Promise<void> {
		const askQuestion = defineTool({
			name: "ask_question",
			label: "Ask Question",
			description: "Ask the parent a multiple-choice question and wait for its answer.",
			executionMode: "sequential",
			parameters: Type.Object(
				{
					question: Type.String({ minLength: 1 }),
					alternatives: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 5 }),
				},
				{ additionalProperties: false },
			),
			execute: async (_id, params, signal) => {
				signal?.throwIfAborted();
				const generation = this.current;
				if (!generation || generationSettled(generation)) {
					throw agentError("no_active_generation", "No active subagent generation.");
				}
				if (generation.question) {
					throw agentError("question_already_pending", "The subagent already has a pending question.");
				}
				const question: AgentQuestion = {
					question_id: randomBytes(16).toString("hex"),
					question: params.question,
					options: [...params.alternatives],
				};
				const answer = Deferred.makeUnsafe<string, Error>();
				generation.question = { question, answer };
				Deferred.doneUnsafe(generation.arrival, Effect.void);
				this.emit();
				this.options.onQuestion?.(this.summary(), question);
				const text = await runPromise(this.awaitAnswer(generation, question, answer, signal));
				return { content: [{ type: "text", text }], details: { answer: text } };
			},
		});
		const tools = this.options.agent.tools ? [...this.options.agent.tools] : [];
		const customTools = tools.includes("ask_question") ? [askQuestion] : [];
		if (this.options.sessionFactory) {
			this.session = await this.options.sessionFactory(customTools);
			this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
			return;
		}
		const directory = path.join(this.options.agentDir, "subagent-sessions");
		await runPromise(
			Effect.gen(function* () {
				yield* makeDirectory(directory);
			}),
		);
		const manager = SessionManager.create(this.cwd, directory);
		const subagentExtension = path.resolve(this.options.agentDir, "extensions", "subagents", "index.ts");
		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.options.agentDir,
			appendSystemPrompt: [this.options.agent.systemPrompt],
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter(
					(extension) =>
						path.resolve(extension.resolvedPath) !== subagentExtension &&
						!extension.tools.has("spawn_agent") &&
						!extension.tools.has("ask_question"),
				),
			}),
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir: this.options.agentDir,
			model: this.options.resolvedRun.modelInstance,
			thinkingLevel: this.options.resolvedRun.effectiveThinking,
			sessionManager: manager,
			resourceLoader: loader,
			customTools,
			tools,
		});
		this.session = session;
		this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
	}

	private launch(
		message: string,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (!this.session) {
			throw agentError("session_not_opened", `Agent ${this.id} did not open its child session.`);
		}
		const run = initRunData({
			agent: this.options.agent,
			taskName,
			profile: this.options.resolvedRun.profile,
			model: this.options.resolvedRun.model,
			effectiveThinking: this.options.resolvedRun.effectiveThinking,
			contextWindow: this.options.resolvedRun.contextWindow,
			...(this.session.sessionId ? { sessionId: this.session.sessionId } : {}),
			...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}),
			resultId: randomBytes(32).toString("hex"),
		});
		const generation: Generation = {
			number: (this.current?.number ?? 0) + 1,
			settlement: Deferred.makeUnsafe<ReadonlyRunDetails, Error>(),
			arrival: newArrival(),
			run,
			initialEntryIds: new Set(this.session.sessionManager.getEntries().map((entry) => entry.id)),
			background,
			aborted: false,
			stalled: false,
		};
		this.current = generation;
		this.phaseState = "running";
		this.watchForStall(generation);
		this.emit();
		void this.session
			.prompt(message, { expandPromptTemplates: false })
			.then(
				() => this.settle(generation),
				(error) => this.settle(generation, toError(error)),
			)
			.catch((error: unknown) => this.reportCleanupFailure(error));
		return background ? Promise.resolve(this.snapshot("launched")) : this.waitFor(generation, signal);
	}

	private settle(generation: Generation, failure?: Error): void {
		if (generationSettled(generation) || this.current !== generation || this.phaseState === "interrupting") return;
		this.clearStallWatchdog();
		const entry = this.terminalAssistantEntry(generation);
		if (!entry) {
			failure ??= agentError(
				"missing_terminal_message",
				`Agent ${this.id} completed without a terminal assistant message.`,
			);
		}
		try {
			this.persistResult(generation, entry);
		} catch (cause) {
			const persistenceError = toError(cause);
			failure = failure
				? new Error(`${failure.message} (result persistence failed: ${persistenceError.message})`, { cause: failure })
				: persistenceError;
		}
		const stopReason = entry?.message.stopReason;
		if (generation.stalled) {
			generation.run.error = this.stallErrorMessage();
		} else if (failure) {
			generation.run.error = failure.message;
		} else if (stopReason === "error" && !generation.run.error) {
			generation.run.error = entry?.message.errorMessage ?? "Subagent assistant failed.";
		}
		generation.run.endTime = Date.now();
		const terminalPhase: AgentPhase = generation.stalled
			? "failed"
			: generation.aborted || stopReason === "aborted"
				? "aborted"
				: failure || stopReason === "error"
					? "failed"
					: "idle";
		if (this.phaseState !== "closing" && this.phaseState !== "closed") this.phaseState = terminalPhase;
		const details = this.snapshot();
		// The settlement is the generation's single completion point: failures
		// reach the waiter, while an aborted generation settles successfully so
		// its details stay readable.
		Deferred.doneUnsafe(
			generation.settlement,
			failure && !generation.aborted ? Effect.fail(failure) : Effect.succeed(details),
		);
		Deferred.doneUnsafe(generation.arrival, Effect.void);
		this.emit();
		if (
			generation.background &&
			this.phaseState !== "closing" &&
			this.phaseState !== "closed" &&
			(terminalPhase === "idle" || terminalPhase === "failed")
		) {
			this.options.onBackgroundComplete?.(this.summary());
		}
		if (!this.options.retain && this.phaseState !== "closing" && this.phaseState !== "closed") {
			void this.close().catch((error: unknown) => this.reportCleanupFailure(error));
		}
	}

	private terminalAssistantEntry(generation: Generation): AssistantSessionEntry | undefined {
		return this.session?.sessionManager
			.getBranch()
			.findLast(
				(candidate): candidate is AssistantSessionEntry =>
					!generation.initialEntryIds.has(candidate.id) && isAssistantSessionEntry(candidate),
			);
	}

	private persistResult(generation: Generation, entry: AssistantSessionEntry | undefined): void {
		if (generation.run.resultLocator || !entry) return;
		const text = assistantText(entry) ?? "";
		const result = storedResult(generation.number, generation.run.resultId, text, entry.message.stopReason === "stop");
		const sessionId = this.session?.sessionId ?? generation.run.sessionId;
		const sessionFile = this.session?.sessionFile ?? generation.run.sessionFile;
		if (!sessionId || !sessionFile) {
			throw agentError("missing_persisted_session", `Agent ${this.id} settled without a persisted child session.`);
		}
		const locator: GenerationResultLocator = {
			version: 2,
			generation: generation.number,
			resultId: result.resultId,
			sessionId,
			sessionFile,
			resultEntryId: entry.id,
		};
		generation.run.result = resultReference(result);
		generation.run.resultLocator = locator;
		generation.run.finalText = resultPreview(text);
	}

	private handleEvent(event: AgentSessionEvent): void {
		const generation = this.current;
		if (!generation || generationSettled(generation)) return;
		foldSessionEvent(event, generation.run);
		const contextUsage = this.session?.getContextUsage();
		if (contextUsage) generation.run.contextUsage = { ...contextUsage };
		this.emit();
	}

	private cancelPendingQuestion(generation: Generation, message: string): void {
		const pending = generation.question;
		if (!pending) return;
		delete generation.question;
		Deferred.doneUnsafe(pending.answer, Effect.fail(agentError("question_cancelled", message)));
	}

	/**
	 * Watch generation liveness in a fiber: activity stamps keep deferring it,
	 * and the frame that owns the generation interrupts the fiber on settle.
	 */
	private watchForStall(generation: Generation): void {
		this.clearStallWatchdog();
		const watch: Effect.Effect<void> = Effect.gen({ self: this }, function* () {
			while (!generationSettled(generation) && this.current === generation) {
				const thresholdMs = this.stallTimeoutMs();
				// A child parked at ask_question emits no events while waiting
				// for its answer; poll later instead of treating the human as a hang.
				if (generation.question) {
					yield* Effect.sleep(thresholdMs);
					continue;
				}
				const remainingMs = thresholdMs - (Date.now() - generation.run.lastActivityTime);
				if (remainingMs > 0) {
					yield* Effect.sleep(remainingMs);
					continue;
				}
				const outcome = yield* Effect.tryPromise({
					try: () => this.recoverStalledGeneration(generation),
					catch: (error) => toError(error),
				}).pipe(Effect.exit);
				if (Exit.isFailure(outcome)) this.reportCleanupFailure(Cause.squash(outcome.cause));
				return;
			}
		});
		this.stallFiber = runFork(watch);
	}

	/** Abort a silent generation so it settles through the normal failure path. */
	private async recoverStalledGeneration(generation: Generation): Promise<void> {
		if (generationSettled(generation) || this.current !== generation || generation.question) return;
		generation.stalled = true;
		this.phaseState = "interrupting";
		this.clearStallWatchdog();
		try {
			await this.session?.abort();
		} finally {
			await this.reapOwnedProcesses();
			this.finishInterruption();
		}
	}

	private reportCleanupFailure(error: unknown): void {
		if (this.current) this.current.run.error = `${this.current.run.error ?? ""}\n${toError(error).message}`.trim();
		this.emit();
		process.emitWarning(toError(error), { type: "SubagentCleanupError" });
	}

	private clearStallWatchdog(): void {
		const fiber = this.stallFiber;
		if (fiber === undefined) return;
		this.stallFiber = undefined;
		void runPromise(Effect.andThen(Fiber.interrupt(fiber), Effect.void)).catch(() => {});
	}

	private stallTimeoutMs(): number {
		return this.options.stallTimeoutMs ?? AGENT_STALL_TIMEOUT_MS;
	}

	private stallErrorMessage(): string {
		return `Subagent stalled: no activity for ${formatStallDuration(this.stallTimeoutMs())}; the run was aborted internally.`;
	}

	private disposeSession(): void {
		const unsubscribe = this.unsubscribe;
		const session = this.session;
		this.unsubscribe = undefined;
		this.session = undefined;
		try {
			unsubscribe?.();
		} finally {
			session?.dispose();
		}
	}

	private async reapOwnedProcesses(): Promise<void> {
		const owner = this.session?.sessionId ?? this.current?.run.sessionId;
		if (owner !== undefined) await runPromise(this.processReaper.terminateOwner(owner));
	}

	private waitFor(generation: Generation, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		return runPromise(this.awaitGeneration(generation, signal));
	}

	/**
	 * Settle the wait on whichever comes first: the generation's settlement, a
	 * question that needs the parent now, or the caller abandoning the wait. An
	 * abandoned wait leaves the child running in the background.
	 */
	private awaitGeneration(generation: Generation, signal?: AbortSignal): Effect.Effect<ReadonlyRunDetails, Error> {
		return Effect.gen({ self: this }, function* () {
			const question = Effect.gen({ self: this }, function* () {
				yield* Deferred.await(generation.arrival);
				generation.background = true;
				if (generation.question) return this.snapshot();
				return yield* Deferred.await(generation.settlement);
			});
			const settled = Effect.raceFirst(Deferred.await(generation.settlement), question);
			if (!signal) return yield* settled;
			const interrupted = Effect.callback<never, Error>((resume) => {
				const onAbort = () => {
					generation.background = true;
					resume(Effect.fail(new AgentWaitInterruptedError(this.id, signal.reason)));
				};
				if (signal.aborted) {
					onAbort();
					return Effect.void;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				return Effect.sync(() => signal.removeEventListener("abort", onAbort));
			});
			return yield* Effect.raceFirst(settled, interrupted);
		});
	}

	private snapshot(status?: "launched"): ReadonlyRunDetails {
		const current = this.current;
		if (!current) {
			return snapshotRunData(
				initRunData({
					agent: this.options.agent,
					taskName: "",
					profile: this.options.resolvedRun.profile,
					model: this.options.resolvedRun.model,
					effectiveThinking: this.options.resolvedRun.effectiveThinking,
					contextWindow: this.options.resolvedRun.contextWindow,
					resultId: randomBytes(32).toString("hex"),
				}),
				{ agentId: this.id, generation: 0, status: lifecycleStatus({ phase: this.phaseState }) },
			);
		}
		return snapshotRunData(current.run, {
			agentId: this.id,
			generation: current.number,
			status: status ?? lifecycleStatus({ phase: this.phaseState }),
			aborted: current.aborted,
			...(current.question ? { pendingQuestion: current.question.question } : {}),
		});
	}

	private emit(): void {
		const details = this.snapshot();
		for (const listener of this.listeners) listener(details);
	}
}

function isAssistantSessionEntry(entry: SessionEntry): entry is AssistantSessionEntry {
	return entry.type === "message" && entry.message.role === "assistant";
}

export function buildInitialTask(message: string, handoff: string | undefined): string {
	return handoff?.trim()
		? `Task: ${message}\n\nParent context (may be incomplete; use it to understand the assignment and verify factual claims when material):\n${handoff}`
		: `Task: ${message}`;
}
