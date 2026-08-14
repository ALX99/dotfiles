import { createHash } from "node:crypto";
import { OTHER_OPTION } from "../ask-question/choices.ts";
import { composeAbortSignal, onAbort } from "../_shared/abort.ts";
import { toError } from "../_shared/errors.ts";
import {
	AgentWaitDeferredReason,
	AgentWaitInterruptedError,
	AgentWaitTimeoutReason,
	lifecycleStatus,
	type AgentQuestion,
} from "./agent-types.ts";
import type { ChildSessionIdentity } from "./session-cursors.ts";
import type { AgentEvent } from "./event-schema.ts";
import {
	foldAgentEvent,
	runUsageTotalTokens,
	snapshotRunData,
	type MutableRunData,
	type ReadonlyRunDetails,
	type RunStatus,
} from "./run-state.ts";
import {
	paginateStoredResult,
	resultPreview,
	resultReference,
	type CapturedGeneration,
	type ResultPage,
	type StoredAgentResult,
} from "./result-store.ts";
import { isInputUiRequest, isSelectUiRequest, type ExtensionUiRequest, type InputUiRequest } from "./protocol.ts";

interface QuestionSignal {
	readonly promise: Promise<AgentQuestion>;
	readonly resolve: (question: AgentQuestion) => void;
	settled: boolean;
}

type QuestionInteraction =
	| { readonly kind: "waiting"; readonly signal: QuestionSignal }
	| { readonly kind: "pending"; readonly question: AgentQuestion; readonly signal: QuestionSignal }
	| { readonly kind: "custom-answer"; readonly answer: string; readonly signal: QuestionSignal };

interface RunCompletion {
	readonly generation: number;
	readonly promise: Promise<ReadonlyRunDetails>;
	readonly resolve: (details: ReadonlyRunDetails) => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
}

interface GenerationStateBase {
	readonly generation: number;
	readonly run: MutableRunData;
}

type ActiveGenerationPhase = "starting" | "running" | "aborted";

type ActiveGenerationState<P extends ActiveGenerationPhase = ActiveGenerationPhase> = GenerationStateBase & {
	readonly phase: P;
	readonly completion: RunCompletion;
	readonly question: QuestionInteraction;
};

type IdleGenerationState = GenerationStateBase & { readonly phase: "idle"; readonly completion: RunCompletion };
type FailedGenerationState = GenerationStateBase & {
	readonly phase: "failed";
	readonly completion: RunCompletion;
	readonly error: Error;
	readonly recovery?: Promise<void>;
};

type GenerationState =
	| ActiveGenerationState<"starting">
	| ActiveGenerationState<"running">
	| ActiveGenerationState<"aborted">
	| IdleGenerationState
	| FailedGenerationState;

function isActiveGeneration(state: GenerationState): state is ActiveGenerationState {
	return state.phase === "starting" || state.phase === "running" || state.phase === "aborted";
}

function beginGeneration(run: MutableRunData, completion: RunCompletion): ActiveGenerationState<"starting"> {
	return {
		phase: "starting",
		generation: completion.generation,
		run,
		completion,
		question: { kind: "waiting", signal: newQuestionSignal() },
	};
}

function markGenerationRunning(state: ActiveGenerationState<"starting">): ActiveGenerationState<"running"> {
	return { ...state, phase: "running" };
}

function markGenerationAborted(
	state: ActiveGenerationState<"starting"> | ActiveGenerationState<"running">,
): ActiveGenerationState<"aborted"> {
	return {
		...state,
		phase: "aborted",
		question: { kind: "waiting", signal: newQuestionSignal() },
	};
}

function updateGenerationQuestion(state: ActiveGenerationState, question: QuestionInteraction): ActiveGenerationState {
	return { ...state, question };
}

function markGenerationIdle(
	state: ActiveGenerationState<"starting"> | ActiveGenerationState<"running">,
): IdleGenerationState {
	return {
		phase: "idle",
		generation: state.generation,
		run: state.run,
		completion: state.completion,
	};
}

function markGenerationFailed(
	state: ActiveGenerationState | IdleGenerationState,
	error: Error,
	recovery?: Promise<void>,
): FailedGenerationState {
	return {
		phase: "failed",
		generation: state.generation,
		run: state.run,
		completion: state.completion,
		error,
		...(recovery === undefined ? {} : { recovery }),
	};
}

function newQuestionSignal(): QuestionSignal {
	const { promise, resolve } = Promise.withResolvers<AgentQuestion>();
	return { promise, resolve, settled: false };
}

export interface GenerationSession {
	prepareGeneration(): Promise<void>;
	captureSettlement(generation: number, resultId: string): Promise<CapturedGeneration>;
	captureFailedGeneration(generation: number, resultId: string): Promise<CapturedGeneration | undefined>;
	sendPrompt(content: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
	respondToUi(requestId: string, response: { readonly value: string } | { readonly cancelled: true }): Promise<void>;
	abort(): Promise<unknown>;
}

export interface AgentGenerationOptions {
	readonly agentId: string;
	readonly generation: number;
	readonly run: MutableRunData;
	readonly session: GenerationSession;
	readonly onChange: () => void;
	readonly onCapture: (captured: CapturedGeneration) => void;
	readonly onQuestion: (generation: AgentGeneration, question: AgentQuestion) => void;
	readonly onCompletion: (generation: AgentGeneration, error: Error | undefined) => void;
}

/**
 * Owns the mutable state of exactly one child prompt generation.
 *
 * A generation is intentionally independent of child-process ownership. The
 * same retained ChildSession can host many generations, while a process exit
 * can fail this generation without changing the stable agent's identity.
 */
export class AgentGeneration {
	private state: GenerationState;
	private activeWaiters = 0;
	private eventTail: Promise<void> = Promise.resolve();
	private completionNotified = false;
	private closed = false;
	private readonly options: AgentGenerationOptions;

	constructor(options: AgentGenerationOptions) {
		this.options = options;
		const { promise, resolve, reject } = Promise.withResolvers<ReadonlyRunDetails>();
		void promise.catch(() => {});
		const completion: RunCompletion = {
			generation: options.generation,
			promise,
			resolve,
			reject,
			settled: false,
		};
		this.state = beginGeneration(options.run, completion);
	}

	get generation(): number {
		return this.state.generation;
	}

	get phase(): GenerationState["phase"] {
		return this.state.phase;
	}

	get isActive(): boolean {
		return this.state.phase === "starting" || this.state.phase === "running";
	}

	get isAborted(): boolean {
		return this.state.phase === "aborted";
	}

	get isFailed(): boolean {
		return this.state.phase === "failed";
	}

	get isSettled(): boolean {
		return this.completion.settled;
	}

	get recovery(): Promise<void> | undefined {
		return this.state.phase === "failed" ? this.state.recovery : undefined;
	}

	get error(): Error | undefined {
		return this.state.phase === "failed" ? this.state.error : undefined;
	}

	get completion(): RunCompletion {
		return this.state.completion;
	}

	get pendingQuestion(): AgentQuestion | undefined {
		if (!isActiveGeneration(this.state)) return undefined;
		return this.state.question.kind === "pending" ? this.state.question.question : undefined;
	}

	prepare(): Promise<void> {
		return this.options.session.prepareGeneration();
	}

	setSessionIdentity(identity: ChildSessionIdentity): void {
		this.state.run.sessionId = identity.sessionId;
		this.state.run.sessionFile = identity.sessionFile;
		this.emit();
	}

	setTaskName(taskName: string): void {
		this.state.run.taskName = taskName;
		this.emit();
	}

	reserveForegroundWaiter(): () => void {
		this.activeWaiters++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeWaiters--;
		};
	}

	async prompt(content: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		try {
			await this.options.session.sendPrompt(content, streamingBehavior);
		} catch (cause) {
			this.fail(cause);
			throw cause;
		}
	}

	async steer(message: string): Promise<void> {
		if (!this.isActive) throw new Error(`Agent ${this.options.agentId} is not running.`);
		if (this.pendingQuestion) {
			throw new Error(
				`Agent ${this.options.agentId} is waiting for an answer to question '${this.pendingQuestion.question_id}'; use answer_agent.`,
			);
		}
		await this.prompt(message, "steer");
	}

	async answerQuestion(questionId: string, answer: string): Promise<void> {
		if (!isActiveGeneration(this.state)) {
			throw new Error(`Agent ${this.options.agentId} has no pending question '${questionId}'.`);
		}
		const question = this.pendingQuestion;
		if (!question || question.question_id !== questionId) {
			throw new Error(`Agent ${this.options.agentId} has no pending question '${questionId}'.`);
		}
		if (answer === OTHER_OPTION) {
			throw new Error(`Provide the custom answer itself instead of the reserved '${OTHER_OPTION}' option.`);
		}

		const isListedAnswer = question.options.includes(answer);
		if (!isListedAnswer && !question.options.includes(OTHER_OPTION)) {
			throw new Error(`Answer must match one of the options for question '${questionId}'.`);
		}
		const signal = newQuestionSignal();
		this.state = updateGenerationQuestion(
			this.state,
			isListedAnswer ? { kind: "waiting", signal } : { kind: "custom-answer", answer, signal },
		);
		this.emit();

		try {
			await this.options.session.respondToUi(questionId, { value: isListedAnswer ? answer : OTHER_OPTION });
		} catch (cause) {
			this.fail(cause);
			throw cause;
		}
	}

	async interrupt(): Promise<void> {
		if (this.state.phase !== "starting" && this.state.phase !== "running") return;
		const question = this.pendingQuestion;
		this.state = markGenerationAborted(this.state);
		this.emit();
		try {
			if (question) await this.options.session.respondToUi(question.question_id, { cancelled: true });
			await this.options.session.abort();
		} catch (cause) {
			this.fail(cause);
			throw cause;
		}
	}

	receiveAgentEvent(event: AgentEvent): void {
		this.eventTail = this.eventTail.then(() => this.processAgentEvent(event)).catch((cause) => this.fail(cause));
	}

	handleUiRequest(request: ExtensionUiRequest): boolean {
		if (this.closed) return false;
		if (isInputUiRequest(request)) return this.handleInputRequest(request);
		if (!isSelectUiRequest(request) || this.pendingQuestion || !isActiveGeneration(this.state)) return false;

		const question: AgentQuestion = {
			question_id: request.id,
			question: request.title,
			options: [...request.options],
		};
		const signal = this.state.question.signal;
		this.state = updateGenerationQuestion(this.state, { kind: "pending", question, signal });
		if (!signal.settled) {
			signal.settled = true;
			signal.resolve(snapshotQuestion(question));
		}
		this.emit();
		if (this.activeWaiters === 0) this.options.onQuestion(this, snapshotQuestion(question));
		return true;
	}

	recordOmittedTelemetry(): void {
		if (this.closed) return;
		this.state.run.omittedTelemetryRecords++;
		this.emit();
	}

	fail(cause: unknown): void {
		if (this.closed || this.state.phase === "failed") return;
		const failedState = this.state;
		const error = toError(cause);
		failedState.run.exitCode = 1;
		failedState.run.stderr = error.message;
		failedState.run.endTime = Date.now();
		const completion = this.completion;
		const recovery = this.options.session
			.captureFailedGeneration(this.generation, failedState.run.resultId)
			.then(() => {})
			.catch((captureCause) => {
				failedState.run.stderr = `${failedState.run.stderr}\nResult recovery failed: ${toError(captureCause).message}`;
			})
			.finally(() => {
				if (this.state.phase === "failed" && this.state.generation === failedState.generation) {
					this.settle(completion, { kind: "reject", error });
				}
				this.emit();
			});
		this.state = markGenerationFailed(failedState, error, recovery);
		this.emit();
	}

	close(error: Error): void {
		this.closed = true;
		this.settle(this.completion, { kind: "reject", error });
	}

	async drain(): Promise<void> {
		await this.eventTail;
	}

	async wait(timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		if (this.isSettled) return this.snapshot();
		return this.waitForCompletion(signal, timeoutMs);
	}

	async waitForeground(signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		return this.waitForCompletion(signal, undefined, true);
	}

	promoteCompletion(): void {
		this.notifyCompletion();
	}

	hasPendingResult(generation: number): boolean {
		return generation === this.generation && !this.isSettled;
	}

	async readLiveResultPreview(
		options: {
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		if (!this.isSettled) {
			const preview = resultPreview(this.state.run.liveAssistantPreview);
			const live: StoredAgentResult = {
				generation: this.generation,
				resultId: this.state.run.resultId,
				text: preview,
				complete: false,
				totalBytes: Buffer.byteLength(preview, "utf8"),
				sha256: createHash("sha256").update(preview, "utf8").digest("hex"),
			};
			return paginateStoredResult(this.options.agentId, live, options);
		}
		throw new Error(`Agent ${this.options.agentId} has no live result preview for generation ${this.generation}.`);
	}

	snapshot(status: RunStatus = lifecycleStatus(this.state)): ReadonlyRunDetails {
		const snapshot = snapshotRunData(this.state.run, {
			agentId: this.options.agentId,
			generation: this.generation,
			status,
		});
		const question = this.pendingQuestion;
		return question ? { ...snapshot, pendingQuestion: snapshotQuestion(question) } : snapshot;
	}

	private handleInputRequest(request: InputUiRequest): boolean {
		if (!isActiveGeneration(this.state) || this.state.question.kind !== "custom-answer") return false;
		const interaction = this.state.question;
		this.state = updateGenerationQuestion(this.state, { kind: "waiting", signal: interaction.signal });
		void this.options.session.respondToUi(request.id, { value: interaction.answer }).catch((cause) => this.fail(cause));
		return true;
	}

	private async processAgentEvent(event: AgentEvent): Promise<void> {
		if (this.closed) return;
		if (event.type === "agent_settled" && this.state.phase === "starting") return;
		foldAgentEvent(event, this.state.run);
		if (event.type === "agent_start" && this.state.phase === "starting") {
			this.state = markGenerationRunning(this.state);
		}
		if (event.type === "agent_settled") await this.settleFromChild();
		this.emit();
	}

	private async settleFromChild(): Promise<void> {
		if (this.closed) return;
		const completion = this.completion;
		if (completion.settled || !isActiveGeneration(this.state)) return;
		this.state.run.endTime = Date.now();
		const captured = await this.options.session.captureSettlement(this.generation, this.state.run.resultId);
		this.applyCapture(captured);
		this.options.onCapture(captured);
		this.state.run.resultLocator = captured.locator;
		if (!isActiveGeneration(this.state)) return;
		if (this.state.phase === "aborted") {
			this.settle(completion, { kind: "resolve" });
		} else if (this.state.run.assistantError) {
			const cause = new Error(this.state.run.assistantError);
			const failure = new RecoverableAgentFailure(
				"provider_failure",
				`${cause.message} The persisted child session and any submitted result checkpoint remain available.`,
				cause,
			);
			this.state = markGenerationFailed(this.state, failure);
			this.settle(completion, { kind: "reject", error: failure });
		} else {
			this.state = markGenerationIdle(this.state);
			this.settle(completion, { kind: "resolve" });
		}
	}

	private applyCapture(captured: CapturedGeneration): void {
		this.state.run.result = resultReference(captured.result);
		this.state.run.finalText = resultPreview(captured.result.text);
		this.state.run.usage = { ...captured.stats.usage };
		this.state.run.tokens = runUsageTotalTokens(captured.stats.usage);
		if (captured.stats.startTime !== undefined) this.state.run.startTime = captured.stats.startTime;
		if (captured.stats.endTime !== undefined) this.state.run.endTime = captured.stats.endTime;
		if (captured.assistantError === undefined) delete this.state.run.assistantError;
		else this.state.run.assistantError = captured.assistantError;
	}

	private async waitForCompletion(
		signal?: AbortSignal,
		timeoutMs?: number,
		alreadyForeground = false,
	): Promise<ReadonlyRunDetails> {
		const question = this.pendingQuestion;
		if (question) {
			this.notifyCompletion();
			return this.snapshot();
		}
		const questionSignal = this.questionSignal();
		const guard = composeAbortSignal(signal, timeoutMs);
		let subscription: Disposable | undefined;
		const interruption =
			guard === undefined
				? undefined
				: new Promise<never>((_, reject) => {
						subscription = onAbort(guard.signal, () => {
							// A foreground caller gave up waiting, not the child. Promote its
							// eventual settlement through the same callback as a background
							// run so it is not silently stranded.
							this.notifyCompletion();
							const kind = guard.timedOut()
								? "timed_out"
								: guard.signal.reason instanceof AgentWaitDeferredReason
									? "deferred"
									: guard.signal.reason instanceof AgentWaitTimeoutReason
										? "timed_out"
										: "cancelled";
							reject(new AgentWaitInterruptedError(kind, this.options.agentId, guard.signal.reason));
						});
					});
		const release = alreadyForeground ? undefined : this.reserveForegroundWaiter();
		try {
			const question = questionSignal.promise.then(() => this.snapshot());
			const result = await Promise.race(
				interruption === undefined
					? [this.completion.promise, question]
					: [this.completion.promise, question, interruption],
			);
			if (result.pendingQuestion) this.notifyCompletion();
			return result;
		} finally {
			release?.();
			subscription?.[Symbol.dispose]();
		}
	}

	private questionSignal() {
		if (!isActiveGeneration(this.state)) {
			throw new Error(`Agent ${this.options.agentId} has no active question signal.`);
		}
		return this.state.question.signal;
	}

	private notifyCompletion(): void {
		if (this.completionNotified) return;
		this.completionNotified = true;
		void this.completion.promise.then(
			() => this.options.onCompletion(this, undefined),
			(error: Error) => this.options.onCompletion(this, error),
		);
	}

	private settle(
		completion: RunCompletion,
		outcome: { readonly kind: "resolve" } | { readonly kind: "reject"; readonly error: Error },
	): void {
		if (completion.settled) return;
		completion.settled = true;
		if (outcome.kind === "resolve") completion.resolve(this.snapshot());
		else completion.reject(outcome.error);
	}

	private emit(): void {
		this.options.onChange();
	}
}

export function failureMetadata(error: Error): { readonly kind: string; readonly recoverable: boolean } {
	return error instanceof RecoverableAgentFailure
		? { kind: error.kind, recoverable: true }
		: { kind: "subagent_failure", recoverable: false };
}

export function recoverableTransportFailure(cause: Error): Error {
	return new RecoverableAgentFailure(
		"transport_failure",
		`${cause.message} The persisted child session and any submitted result checkpoint remain available.`,
		cause,
	);
}

class RecoverableAgentFailure extends Error {
	readonly kind: string;
	readonly recoverable = true;

	constructor(kind: string, message: string, cause: Error) {
		super(message, { cause });
		this.name = "RecoverableAgentFailure";
		this.kind = kind;
	}
}

function snapshotQuestion(question: AgentQuestion): AgentQuestion {
	return { ...question, options: [...question.options] };
}
