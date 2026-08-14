import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { OTHER_OPTION } from "../ask-question/choices.ts";
import { composeAbortSignal, onAbort } from "../_shared/abort.ts";
import { toError } from "../_shared/errors.ts";
import type { AgentConfig } from "./agents.ts";
import {
	AgentWaitDeferredReason,
	AgentWaitInterruptedError,
	AgentWaitTimeoutReason,
	CleanupAggregateError,
	lifecycleStatus,
	type AgentQuestion,
	type AgentSummary,
	type AgentView,
} from "./agent-types.ts";
import {
	beginAgentRun,
	isActiveState,
	markAgentAborted,
	markAgentClosed,
	markAgentClosing,
	markAgentFailed,
	markAgentIdle,
	markAgentRunning,
	newQuestionSignal,
	updateAgentQuestion,
	type AgentState,
	type RunCompletion,
} from "./agent-state.ts";
import type { AgentEvent } from "./event-schema.ts";
import type { ResolvedRun } from "./profiles.ts";
import {
	CHILD_CONTEXT_ENV,
	composeRoleSystemPrompt,
	getPiInvocation,
	serializeChildExecutionContext,
	writeTempPrompt,
	type ChildExecutionContext,
} from "./child-process.ts";
import {
	foldAgentEvent,
	initRunData,
	snapshotRunData,
	runUsageTotalTokens,
	type MutableRunData,
	type ReadonlyRunDetails,
	type RunStatus,
} from "./run-state.ts";
import {
	paginateStoredResult,
	readChildTranscript,
	resultPreview,
	resultReference,
	type CapturedGeneration,
	type ResultPage,
	type StoredAgentResult,
} from "./result-store.ts";
import { parseChildSessionIdentity, type ChildSessionIdentity } from "./session-cursors.ts";
import { GenerationCapture } from "./generation-capture.ts";
import { isInputUiRequest, isSelectUiRequest, type ExtensionUiRequest, type InputUiRequest } from "./protocol.ts";
import { RpcTransport, type SpawnRpcProcess } from "./rpc-transport.ts";

let nextAgentId = 1;

export function reserveManagedAgentIds(agentIds: Iterable<string>): void {
	for (const agentId of agentIds) {
		const suffix = /-(\d+)$/.exec(agentId)?.[1];
		if (suffix === undefined) continue;
		const value = Number(suffix);
		if (Number.isSafeInteger(value) && value >= nextAgentId) nextAgentId = value + 1;
	}
}

/** Leaves room for JSON framing inside RpcTransport's 1 MiB hard limit. */
export const MAX_DIRECT_RPC_PROMPT_BYTES = 512 * 1024;

const SCOUT_WITHHELD_ENVIRONMENT = new Set([
	// Agent sockets authorize use of credentials independently of the tool
	// allowlist. Scouts do not need either agent, so do not hand them these
	// capabilities. Provider credentials remain inherited: Pi may need them
	// to run the configured model.
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"GPG_AGENT_INFO",
]);
export interface ManagedAgentOptions {
	readonly id?: string;
	readonly agentDir: string;
	readonly defaultCwd: string;
	readonly cwd?: string;
	readonly agent: AgentConfig;
	readonly resolvedRun: ResolvedRun;
	readonly childContext: ChildExecutionContext;
	readonly retain: boolean;
	readonly spawnProcess?: SpawnRpcProcess;
	/** Test seam; production callers omit this and validate the native file. */
	readonly validateSessionIdentity?: (
		identity: ChildSessionIdentity,
		agentDir: string,
	) => Promise<ChildSessionIdentity>;
	readonly onBackgroundComplete?: (summary: AgentSummary) => void;
	readonly onQuestion?: (summary: AgentSummary, question: AgentQuestion) => void;
}

export class ManagedAgent {
	readonly id: string;
	private transport: RpcTransport | undefined;
	private promptDir: string | undefined;
	private promptPath: string | undefined;
	private state: AgentState;
	private activeWaiters = 0;
	private readonly notifiedGenerations = new Set<number>();
	private readonly listeners = new Set<(details: ReadonlyRunDetails) => void>();
	private eventTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | undefined;
	private readonly options: ManagedAgentOptions;
	private readonly agentDir: string;
	private resultSink: (captured: CapturedGeneration) => void = () => {};
	private readonly generationCapture: GenerationCapture;

	constructor(options: ManagedAgentOptions) {
		this.options = options;
		this.agentDir = options.agentDir;
		this.id = options.id ?? `${options.agent.name}-${nextAgentId++}`;
		this.generationCapture = new GenerationCapture({
			agentId: this.id,
			agentDir: this.agentDir,
			...(options.validateSessionIdentity === undefined
				? {}
				: { validateSessionIdentity: options.validateSessionIdentity }),
		});
		this.state = {
			phase: "created",
			generation: 0,
			run: this.freshRun(),
		};
	}

	attachResultSink(sink: (captured: CapturedGeneration) => void): void {
		this.resultSink = sink;
	}

	get phase(): AgentState["phase"] {
		return this.state.phase;
	}

	async start(
		message: string,
		handoff: string | undefined,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (this.state.phase !== "created") throw new Error("Subagent already started.");
		const run = this.beginRun(taskName);
		let promptPath: string | undefined;
		let foregroundQuestionGuard = false;
		try {
			if (this.options.agent.systemPrompt) {
				const prompt = composeRoleSystemPrompt(
					this.options.agent.systemPrompt,
					this.options.cwd ?? this.options.defaultCwd,
					this.agentDir,
				);
				const written = await writeTempPrompt(this.options.agent.name, prompt);
				if (this.isClosing()) {
					await fs.promises.rm(written.dir, { recursive: true, force: true });
					throw new Error(`Agent ${this.id} was closed during startup.`);
				}
				this.promptDir = written.dir;
				this.promptPath = written.path;
				promptPath = written.path;
			}
			const sessionDir = path.join(this.agentDir, "subagent-sessions");
			// Session JSONL files intentionally outlive this process.
			await fs.promises.mkdir(sessionDir, { recursive: true });
			const args = this.rpcArguments(sessionDir, promptPath);
			const invocation = getPiInvocation(args);
			const transport = new RpcTransport({
				command: invocation.command,
				args: invocation.args,
				cwd: this.options.cwd ?? this.options.defaultCwd,
				env: childEnvironment({ ...this.options.childContext, agentId: this.id }),
				...(this.options.spawnProcess === undefined ? {} : { spawnProcess: this.options.spawnProcess }),
				onEvent: () => {},
				onAgentEvent: (event) => this.queueEvent(event),
				onUiRequest: (request) => this.handleUiRequest(request),
				onOversizedRecord: () => this.recordOmittedTelemetry(),
				onExit: (error) => {
					if (this.transport === transport) this.onExit(error);
				},
			});
			this.transport = transport;
			await transport.start();
			this.assertTransport(transport);
			const state = await transport.request({ type: "get_state" });
			const validatedIdentity = await this.generationCapture.setIdentity(parseChildSessionIdentity(state));
			this.state.run.sessionId = validatedIdentity.sessionId;
			this.state.run.sessionFile = validatedIdentity.sessionFile;
			await this.generationCapture.prepareGeneration(transport);
			const task = buildInitialTask(message, handoff);
			if (!background) {
				this.activeWaiters++;
				foregroundQuestionGuard = true;
			}
			await this.sendPrompt(task, transport);
		} catch (cause) {
			if (foregroundQuestionGuard) {
				this.activeWaiters--;
				foregroundQuestionGuard = false;
			}
			const error = toError(cause);
			if (!this.isClosing()) this.failRun(error);
			try {
				await this.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], `Agent ${this.id} startup and cleanup failed.`);
			}
			throw error;
		}
		if (background) {
			this.notifyWhenComplete(run);
			return this.snapshot("launched");
		}
		try {
			return await this.waitForGeneration(run.generation, signal);
		} finally {
			if (foregroundQuestionGuard) this.activeWaiters--;
			if (!this.options.retain && run.settled) await this.close();
		}
	}

	async steer(message: string): Promise<void> {
		if (this.state.phase !== "running" && this.state.phase !== "starting") {
			throw new Error(`Agent ${this.id} is not running.`);
		}
		const question = this.pendingQuestion();
		if (question) {
			throw new Error(
				`Agent ${this.id} is waiting for an answer to question '${question.question_id}'; use answer_agent.`,
			);
		}
		await this.sendPrompt(message, this.rpc(), "steer");
	}

	async answerQuestion(questionId: string, answer: string): Promise<void> {
		if (!isActiveState(this.state)) {
			throw new Error(`Agent ${this.id} has no pending question '${questionId}'.`);
		}
		const interaction = this.state.question;
		const question = interaction?.kind === "pending" ? interaction.question : undefined;
		if (!question || question.question_id !== questionId) {
			throw new Error(`Agent ${this.id} has no pending question '${questionId}'.`);
		}
		if (answer === OTHER_OPTION) {
			throw new Error(`Provide the custom answer itself instead of the reserved '${OTHER_OPTION}' option.`);
		}

		const isListedAnswer = question.options.includes(answer);
		if (!isListedAnswer && !question.options.includes(OTHER_OPTION)) {
			throw new Error(`Answer must match one of the options for question '${questionId}'.`);
		}
		// A listed choice belongs to the child's select request. Only an
		// unlisted answer takes the "Something else" path and is delivered to
		// the subsequent input request.
		const signal = newQuestionSignal();
		this.state = updateAgentQuestion(
			this.state,
			isListedAnswer ? { kind: "waiting", signal } : { kind: "custom-answer", answer, signal },
		);
		this.emit();

		try {
			await this.rpc().respondToUi(questionId, { value: isListedAnswer ? answer : OTHER_OPTION });
		} catch (cause) {
			this.failRun(cause);
			throw cause;
		}
	}

	async getMessages(): Promise<unknown[]> {
		const sessionFile = this.state.run.sessionFile;
		if (!sessionFile) throw new Error(`Agent ${this.id} has no persisted session.`);
		return readChildTranscript(sessionFile, this.agentDir);
	}

	async readLiveResultPreview(
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		const generation = options.generation ?? this.state.generation;
		if (generation === this.state.generation && this.pendingCompletion()) {
			const preview = resultPreview(this.state.run.liveAssistantPreview);
			const live: StoredAgentResult = {
				generation,
				resultId: this.state.run.resultId,
				text: preview,
				complete: false,
				totalBytes: Buffer.byteLength(preview, "utf8"),
				sha256: createHash("sha256").update(preview, "utf8").digest("hex"),
			};
			return paginateStoredResult(this.id, live, options);
		}
		throw new Error(`Agent ${this.id} has no live result preview for generation ${generation}.`);
	}

	async followUp(
		message: string,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (!this.options.retain) {
			throw new Error(`Agent ${this.id} is one-shot. Spawn with retain:true before using followup_agent.`);
		}
		// Process events already received from the child before deciding whether
		// this continues an active run. In particular, a queued settlement must
		// not resolve a deferred reused for a new follow-up.
		await this.eventTail;
		this.assertAvailableForFollowUp();
		const previous = this.pendingCompletion();
		if (this.state.phase === "aborted" && previous) await previous.promise.catch(() => {});
		if (this.state.phase === "failed" && this.state.recovery) await this.state.recovery;
		const wasRunning = this.state.phase === "running" || this.state.phase === "starting";
		const active = this.pendingCompletion();
		const run = wasRunning && active ? active : this.beginRun(taskName);
		if (wasRunning) this.state.run.taskName = taskName;
		let foregroundQuestionGuard = false;
		try {
			if (!background) {
				this.activeWaiters++;
				foregroundQuestionGuard = true;
			}
			if (!wasRunning) await this.generationCapture.prepareGeneration(this.rpc());
			await this.sendPrompt(message, this.rpc(), wasRunning ? "followUp" : undefined);
		} catch (cause) {
			if (foregroundQuestionGuard) {
				this.activeWaiters--;
				foregroundQuestionGuard = false;
			}
			const error = toError(cause);
			this.failRun(error);
			throw error;
		}
		if (background) {
			this.notifyWhenComplete(run);
			return this.snapshot("launched");
		}
		try {
			return await this.waitForGeneration(run.generation, signal);
		} finally {
			if (foregroundQuestionGuard) this.activeWaiters--;
		}
	}

	async wait(timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const completion = this.pendingCompletion();
		if (!completion) return this.snapshot();
		return this.waitForGeneration(completion.generation, signal, timeoutMs);
	}

	async interrupt(): Promise<void> {
		if (this.state.phase !== "running" && this.state.phase !== "starting") return;
		const pendingQuestion = this.pendingQuestion();
		this.state = markAgentAborted(this.state);
		this.emit();
		try {
			if (pendingQuestion) {
				await this.rpc().respondToUi(pendingQuestion.question_id, { cancelled: true });
			}
			await this.rpc().request({ type: "abort" });
		} catch (cause) {
			const error = toError(cause);
			this.failRun(error);
			throw error;
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	summary(): AgentSummary {
		return this.view().summary;
	}

	view(): AgentView {
		const details = this.snapshot();
		const status = lifecycleStatus(this.state);
		const error = this.state.phase === "failed" ? this.state.error.message : this.state.run.assistantError;
		const failure = this.state.phase === "failed" ? failureMetadata(this.state.error) : undefined;
		const durationMs = details.endTime === undefined ? undefined : Math.max(0, details.endTime - details.startTime);
		const summary: AgentSummary = {
			agent_id: this.id,
			agent: details.agent,
			task_name: details.taskName,
			profile: details.profile,
			model: details.model,
			effective_thinking: details.effectiveThinking,
			...(details.sessionId ? { session_id: details.sessionId } : {}),
			...(details.sessionFile ? { session_file: details.sessionFile } : {}),
			generation: this.state.generation,
			retained: this.options.retain,
			status,
			started_at: details.startTime,
			...(details.endTime === undefined ? {} : { ended_at: details.endTime }),
			...(durationMs === undefined ? {} : { duration_ms: durationMs }),
			usage: details.usage,
			...(details.finalText ? { final_text: details.finalText } : {}),
			...(details.result ? { result: details.result } : {}),
			...(details.resultLocator ? { result_locator: details.resultLocator } : {}),
			...(error ? { error } : {}),
			...(failure ? { failure } : {}),
			...(details.pendingQuestion ? { pending_question: details.pendingQuestion } : {}),
		};
		return { summary, details };
	}

	hasPendingResult(generation: number): boolean {
		return generation === this.state.generation && this.pendingCompletion() !== undefined;
	}

	subscribe(listener: (details: ReadonlyRunDetails) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isAvailable(): boolean {
		return this.transport?.getState() === "open" && this.state.phase !== "closing" && this.state.phase !== "closed";
	}

	/** Whether this entry still occupies a spawn-concurrency slot. */
	occupiesCapacity(): boolean {
		const transportState = this.transport?.getState();
		if (this.transport === undefined && (this.state.phase === "failed" || this.state.phase === "aborted")) {
			return false;
		}
		return (
			this.state.phase !== "closing" &&
			this.state.phase !== "closed" &&
			transportState !== "failed" &&
			transportState !== "closed"
		);
	}

	private beginRun(taskName: string): RunCompletion {
		const previous = this.pendingCompletion();
		if (previous) {
			this.settleCompletion(previous, {
				kind: "reject",
				error: new Error("Agent received a newer run before the previous run settled."),
			});
		}
		const generation = this.state.generation + 1;
		const run = this.freshRun(taskName);
		const { promise, resolve, reject } = Promise.withResolvers<ReadonlyRunDetails>();
		void promise.catch(() => {});
		const completion: RunCompletion = { generation, promise, resolve, reject, settled: false };
		this.state = beginAgentRun(run, completion);
		this.emit();
		return completion;
	}

	private queueEvent(event: AgentEvent): void {
		const generation = this.state.generation;
		this.eventTail = this.eventTail
			.then(() => this.processEvent(event, generation))
			.catch((cause) => this.failRun(cause));
	}

	private handleUiRequest(request: ExtensionUiRequest): boolean {
		if (isInputUiRequest(request)) return this.handleInputRequest(request);
		if (!isSelectUiRequest(request) || this.pendingQuestion() || this.isClosing()) return false;

		const question: AgentQuestion = {
			question_id: request.id,
			question: request.title,
			options: [...request.options],
		};
		if (!isActiveState(this.state)) return false;
		const signal = this.state.question.signal;
		this.state = updateAgentQuestion(this.state, { kind: "pending", question, signal });
		if (!signal.settled) {
			signal.settled = true;
			signal.resolve(snapshotQuestion(question));
		}
		this.emit();
		if (this.activeWaiters === 0) {
			this.options.onQuestion?.(this.summary(), snapshotQuestion(question));
		}
		return true;
	}

	private handleInputRequest(request: InputUiRequest): boolean {
		if (!isActiveState(this.state) || this.state.question.kind !== "custom-answer") return false;
		const interaction = this.state.question;
		this.state = updateAgentQuestion(this.state, { kind: "waiting", signal: interaction.signal });
		void this.rpc()
			.respondToUi(request.id, { value: interaction.answer })
			.catch((cause) => this.failRun(cause));
		return true;
	}

	private async processEvent(event: AgentEvent, generation: number): Promise<void> {
		if (generation !== this.state.generation || this.state.phase === "closing" || this.state.phase === "closed") {
			return;
		}
		if (event.type === "agent_settled" && this.state.phase === "starting") return;
		foldAgentEvent(event, this.state.run);
		if (generation !== this.state.generation) return;
		if (event.type === "agent_start") {
			if (this.state.phase === "starting") this.state = markAgentRunning(this.state);
		}
		if (event.type === "agent_settled") {
			const completion = this.pendingCompletion();
			if (!completion || !isActiveState(this.state)) return;
			this.state.run.endTime = Date.now();
			const captured = await this.generationCapture.captureSettlement(this.rpc(), generation, this.state.run.resultId);
			this.applyCapture(captured);
			this.finalizeGeneration(captured);
			if (generation !== this.state.generation || !isActiveState(this.state)) return;
			if (this.state.phase === "aborted") {
				this.settleCompletion(completion, { kind: "resolve" });
			} else if (this.state.run.assistantError) {
				if (this.isClosing()) return;
				const cause = new Error(this.state.run.assistantError);
				const failure = new RecoverableAgentFailure(
					"provider_failure",
					`${cause.message} The persisted child session and any submitted result checkpoint remain available.`,
					cause,
				);
				this.state = markAgentFailed(this.state, failure);
				this.settleCompletion(completion, { kind: "reject", error: failure });
			} else {
				this.state = markAgentIdle(this.state);
				this.settleCompletion(completion, { kind: "resolve" });
			}
		}
		this.emit();
	}

	private onExit(error: Error | undefined): void {
		if (this.state.phase === "closing" || this.state.phase === "closed") return;
		const cause = error ?? new Error("Subagent process exited.");
		this.failRun(
			new RecoverableAgentFailure(
				"transport_failure",
				`${cause.message} The persisted child session and any submitted result checkpoint remain available.`,
				cause,
			),
		);
	}

	private failRun(cause: unknown): void {
		if (
			this.state.phase === "created" ||
			this.state.phase === "closing" ||
			this.state.phase === "closed" ||
			this.state.phase === "failed"
		)
			return;
		const failedState = this.state;
		const error = toError(cause);
		const completion = this.pendingCompletion();
		failedState.run.exitCode = 1;
		failedState.run.stderr = error.message;
		failedState.run.endTime = Date.now();
		const recovery = this.captureFailedGeneration()
			.catch((captureCause) => {
				failedState.run.stderr = `${failedState.run.stderr}\nResult recovery failed: ${toError(captureCause).message}`;
			})
			.finally(() => {
				if (this.state.phase === "failed" && this.state.generation === failedState.generation && completion) {
					this.settleCompletion(completion, { kind: "reject", error });
				}
				this.emit();
			});
		this.state = markAgentFailed(failedState, error, recovery);
		this.emit();
	}

	private async closeInternal(): Promise<void> {
		if (this.state.phase === "closed") return;
		const recovery = this.state.phase === "failed" ? this.state.recovery : undefined;
		if (this.state.phase !== "closing") {
			this.state = markAgentClosing(this.state);
			this.emit();
		}
		this.settleCurrent({ kind: "reject", error: new Error(`Agent ${this.id} was closed.`) });
		const failures: unknown[] = [];
		const transport = this.transport;
		this.transport = undefined;
		try {
			try {
				await transport?.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await this.eventTail;
			} catch (error) {
				failures.push(error);
			}
			try {
				await recovery;
			} catch (error) {
				failures.push(error);
			}
		} finally {
			try {
				if (this.promptDir) await fs.promises.rm(this.promptDir, { recursive: true, force: true });
			} catch (error) {
				failures.push(error);
			} finally {
				this.promptDir = undefined;
				this.promptPath = undefined;
				this.state = markAgentClosed(this.state);
				this.emit();
				this.listeners.clear();
			}
		}
		if (failures.length > 0) throw new CleanupAggregateError(`Agent ${this.id}`, failures);
	}

	private freshRun(taskName = ""): MutableRunData {
		const resolvedRun = this.activeResolvedRun();
		const run = initRunData({
			agent: this.options.agent,
			taskName,
			profile: resolvedRun.profile,
			model: resolvedRun.model,
			effectiveThinking: resolvedRun.effectiveThinking,
			...(this.state?.run.sessionId === undefined ? {} : { sessionId: this.state.run.sessionId }),
			...(this.state?.run.sessionFile === undefined ? {} : { sessionFile: this.state.run.sessionFile }),
			resultId: randomBytes(32).toString("hex"),
		});
		run.contextWindow = resolvedRun.contextWindow;
		return run;
	}

	private currentCompletion(): RunCompletion | undefined {
		return "completion" in this.state ? this.state.completion : undefined;
	}

	private pendingCompletion(): RunCompletion | undefined {
		const completion = this.currentCompletion();
		return completion?.settled ? undefined : completion;
	}

	private pendingQuestion(): AgentQuestion | undefined {
		if (!isActiveState(this.state)) return undefined;
		return this.state.question.kind === "pending" ? this.state.question.question : undefined;
	}

	private questionSignal(generation: number) {
		if (!isActiveState(this.state) || this.state.completion.generation !== generation) {
			throw new Error(`Agent ${this.id} has no active question signal.`);
		}
		return this.state.question.signal;
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}

	private snapshot(status: RunStatus = lifecycleStatus(this.state)): ReadonlyRunDetails {
		const snapshot = snapshotRunData(this.state.run, {
			agentId: this.id,
			generation: this.state.generation,
			status,
		});
		const question = this.pendingQuestion();
		return question ? { ...snapshot, pendingQuestion: snapshotQuestion(question) } : snapshot;
	}

	private notifyWhenComplete(run: RunCompletion): void {
		if (this.notifiedGenerations.has(run.generation)) return;
		this.notifiedGenerations.add(run.generation);
		void run.promise.then(
			() => {
				const summary = this.summary();
				if (summary.status === "idle") this.options.onBackgroundComplete?.(summary);
				if (!this.options.retain) void this.close().catch(() => {});
			},
			(error: Error) => {
				if (this.state.phase !== "closed" && this.state.phase !== "closing" && this.state.phase !== "aborted") {
					this.options.onBackgroundComplete?.({ ...this.summary(), status: "failed", error: error.message });
				}
				if (!this.options.retain) void this.close().catch(() => {});
			},
		);
	}

	private settleCurrent(
		outcome: { readonly kind: "resolve" } | { readonly kind: "reject"; readonly error: Error },
	): void {
		const completion = this.currentCompletion();
		if (completion) this.settleCompletion(completion, outcome);
	}

	private settleCompletion(
		completion: RunCompletion,
		outcome: { readonly kind: "resolve" } | { readonly kind: "reject"; readonly error: Error },
	): void {
		if (completion.settled) return;
		completion.settled = true;
		if (outcome.kind === "resolve") completion.resolve(this.snapshot());
		else completion.reject(outcome.error);
	}

	private async waitForGeneration(
		generation: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<ReadonlyRunDetails> {
		const completion = this.currentCompletion();
		if (!completion || completion.generation !== generation) return this.snapshot();
		const question = this.pendingQuestion();
		if (question) {
			this.notifyWhenComplete(completion);
			return this.snapshot();
		}
		const questionSignal = this.questionSignal(generation);
		const guard = composeAbortSignal(signal, timeoutMs);
		let subscription: Disposable | undefined;
		const guards =
			guard === undefined
				? undefined
				: new Promise<never>((_, reject) => {
						subscription = onAbort(guard.signal, () => {
							// A foreground caller gave up waiting, not the child. Promote its
							// eventual settlement through the same callback as a background
							// run so it is not silently stranded.
							this.notifyWhenComplete(completion);
							const kind = guard.timedOut()
								? "timed_out"
								: guard.signal.reason instanceof AgentWaitDeferredReason
									? "deferred"
									: guard.signal.reason instanceof AgentWaitTimeoutReason
										? "timed_out"
										: "cancelled";
							reject(new AgentWaitInterruptedError(kind, this.id, guard.signal.reason));
						});
					});
		this.activeWaiters++;
		try {
			const question = questionSignal.promise.then(() => this.snapshot());
			const result = await Promise.race(
				guards === undefined ? [completion.promise, question] : [completion.promise, question, guards],
			);
			if (result.pendingQuestion) this.notifyWhenComplete(completion);
			return result;
		} finally {
			this.activeWaiters--;
			subscription?.[Symbol.dispose]();
		}
	}

	private async sendPrompt(
		content: string,
		transport: RpcTransport,
		streamingBehavior?: "steer" | "followUp",
	): Promise<void> {
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_DIRECT_RPC_PROMPT_BYTES) {
			throw new Error(
				`Subagent RPC prompt is ${bytes} UTF-8 bytes; the direct prompt limit is ${MAX_DIRECT_RPC_PROMPT_BYTES}.`,
			);
		}
		await transport.request({
			type: "prompt",
			message: content,
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		});
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

	private finalizeGeneration(captured: CapturedGeneration): void {
		this.resultSink(captured);
		this.state.run.resultLocator = captured.locator;
	}

	private async captureFailedGeneration(): Promise<void> {
		const captured = await this.generationCapture.captureFailedGeneration(
			this.transport,
			this.state.generation,
			this.state.run.resultId,
		);
		if (captured) {
			this.applyCapture(captured);
			this.finalizeGeneration(captured);
		}
	}

	private recordOmittedTelemetry(): void {
		this.state.run.omittedTelemetryRecords++;
		this.emit();
	}

	private rpc(): RpcTransport {
		if (!this.transport || this.transport.getState() !== "open") {
			throw new Error(`Agent ${this.id} is not available.`);
		}
		return this.transport;
	}

	private assertTransport(transport: RpcTransport): void {
		if (this.transport !== transport || this.state.phase === "closing" || this.state.phase === "closed") {
			throw new Error(`Agent ${this.id} was closed during startup.`);
		}
	}

	private isClosing(): boolean {
		return this.state.phase === "closing" || this.state.phase === "closed";
	}

	private assertAvailableForFollowUp(): void {
		if (this.transport?.getState() !== "open") {
			throw new Error(`Agent ${this.id} process is dead; close it and spawn a replacement before following up.`);
		}
		if (this.state.phase === "closing" || this.state.phase === "closed") {
			throw new Error(`Agent ${this.id} is closed.`);
		}
		const question = this.pendingQuestion();
		if (question) {
			throw new Error(
				`Agent ${this.id} is waiting for an answer to question '${question.question_id}'; use answer_agent.`,
			);
		}
		this.rpc();
	}

	private rpcArguments(
		sessionDir: string,
		promptPath: string | undefined,
		resolvedRun = this.activeResolvedRun(),
		sessionFile?: string,
	): string[] {
		const args = [
			"--mode",
			"rpc",
			"--model",
			resolvedRun.model,
			"--thinking",
			resolvedRun.effectiveThinking,
			"--session-dir",
			sessionDir,
		];
		if (sessionFile) args.push("--session", sessionFile);
		const tools = new Set(this.options.agent.tools);
		if (tools.size > 0) args.push("--tools", [...tools].join(","));
		else args.push("--no-tools");
		if (promptPath) args.push("--append-system-prompt", promptPath);
		return args;
	}

	private activeResolvedRun(): ResolvedRun {
		return this.options.resolvedRun;
	}
}

export function buildInitialTask(message: string, handoff: string | undefined): string {
	return handoff?.trim()
		? `Task: ${message}\n\nParent context (may be incomplete; use it to understand the assignment and verify factual claims when material):\n${handoff}`
		: `Task: ${message}`;
}

export function childEnvironment(
	context: ChildExecutionContext,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (context.agent === "scout" && SCOUT_WITHHELD_ENVIRONMENT.has(name)) continue;
		environment[name] = value;
	}
	environment[CHILD_CONTEXT_ENV] = serializeChildExecutionContext(context);
	return environment;
}

function snapshotQuestion(question: AgentQuestion): AgentQuestion {
	return { ...question, options: [...question.options] };
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

function failureMetadata(error: Error): { readonly kind: string; readonly recoverable: boolean } {
	return error instanceof RecoverableAgentFailure
		? { kind: error.kind, recoverable: true }
		: { kind: "subagent_failure", recoverable: false };
}
