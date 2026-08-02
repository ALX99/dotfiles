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
	transitionLifecycle,
	type AgentLifecycle,
	type AgentQuestion,
	type AgentSummary,
} from "./agent-types.ts";
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
	readStoredAgentResult,
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
interface Deferred {
	readonly generation: number;
	readonly promise: Promise<ReadonlyRunDetails>;
	readonly resolve: (details: ReadonlyRunDetails) => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
}

interface QuestionSignal {
	readonly generation: number;
	readonly promise: Promise<AgentQuestion>;
	readonly resolve: (question: AgentQuestion) => void;
	settled: boolean;
}

interface QueuedCustomAnswer {
	readonly generation: number;
	readonly answer: string;
}

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
	private deferred: Deferred | undefined;
	private lifecycle: AgentLifecycle = { phase: "created" };
	private generation = 0;
	private startedGeneration: number | undefined;
	private run: MutableRunData;
	private pendingQuestion: AgentQuestion | undefined;
	private questionSignal: QuestionSignal | undefined;
	private queuedCustomAnswer: QueuedCustomAnswer | undefined;
	private activeWaiters = 0;
	private readonly notifiedGenerations = new Set<number>();
	private readonly listeners = new Set<(details: ReadonlyRunDetails) => void>();
	private eventTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | undefined;
	private readonly options: ManagedAgentOptions;
	private readonly agentDir: string;
	private failureTask: Promise<void> | undefined;
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
		this.run = this.freshRun();
	}

	attachResultSink(sink: (captured: CapturedGeneration) => void): void {
		this.resultSink = sink;
	}

	getLifecycle(): AgentLifecycle {
		return this.lifecycle;
	}

	async start(
		message: string,
		handoff: string | undefined,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (this.lifecycle.phase !== "created") throw new Error("Subagent already started.");
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
			this.run.sessionId = validatedIdentity.sessionId;
			this.run.sessionFile = validatedIdentity.sessionFile;
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
		if (this.lifecycle.phase !== "running" && this.lifecycle.phase !== "starting") {
			throw new Error(`Agent ${this.id} is not running.`);
		}
		if (this.pendingQuestion) {
			throw new Error(
				`Agent ${this.id} is waiting for an answer to question '${this.pendingQuestion.question_id}'; use answer_agent.`,
			);
		}
		await this.sendPrompt(message, this.rpc(), "steer");
	}

	async answerQuestion(questionId: string, answer: string): Promise<void> {
		const question = this.pendingQuestion;
		if (!question || question.question_id !== questionId || this.generation !== this.questionSignal?.generation) {
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
		if (!isListedAnswer) this.queuedCustomAnswer = { generation: this.generation, answer };
		this.pendingQuestion = undefined;
		this.questionSignal = this.newQuestionSignal(this.generation);
		this.emit();

		try {
			await this.rpc().respondToUi(questionId, { value: isListedAnswer ? answer : OTHER_OPTION });
		} catch (cause) {
			this.failRun(cause);
			throw cause;
		}
	}

	async getMessages(): Promise<unknown[]> {
		const sessionFile = this.run.sessionFile;
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
		const generation = options.generation ?? this.generation;
		if (generation === this.generation && this.deferred && !this.deferred.settled) {
			const preview = resultPreview(this.run.lastAssistantText);
			const live: StoredAgentResult = {
				generation,
				resultId: this.run.resultId,
				text: preview,
				pageCount: 0,
				complete: false,
				totalBytes: Buffer.byteLength(preview, "utf8"),
				sha256: createHash("sha256").update(preview, "utf8").digest("hex"),
				source: "assistant",
			};
			return paginateStoredResult(this.id, live, options);
		}
		throw new Error(`Agent ${this.id} has no live result preview for generation ${generation}.`);
	}

	async readSettledResult(
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		const generation = options.generation ?? this.generation;
		if (generation !== this.generation) {
			throw new Error(`Agent ${this.id} has no fallback result for generation ${generation}.`);
		}
		return paginateStoredResult(this.id, await this.readLegacyStoredResult(), options);
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
		if (this.lifecycle.phase === "aborted" && this.deferred && !this.deferred.settled) {
			await this.deferred.promise.catch(() => {});
		}
		if (this.failureTask) await this.failureTask;
		const wasRunning = this.lifecycle.phase === "running" || this.lifecycle.phase === "starting";
		const run = wasRunning && this.deferred && !this.deferred.settled ? this.deferred : this.beginRun(taskName);
		if (wasRunning) this.run.taskName = taskName;
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
		if (!this.deferred || this.deferred.settled) return this.snapshot();
		return this.waitForGeneration(this.deferred.generation, signal, timeoutMs);
	}

	async interrupt(): Promise<void> {
		if (this.lifecycle.phase !== "running" && this.lifecycle.phase !== "starting") return;
		this.setLifecycle({ phase: "aborted" });
		const pendingQuestion = this.pendingQuestion;
		this.pendingQuestion = undefined;
		this.queuedCustomAnswer = undefined;
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
		const status = lifecycleStatus(this.lifecycle);
		const error = this.lifecycle.phase === "failed" ? this.lifecycle.error.message : this.run.assistantError;
		const resolvedRun = this.activeResolvedRun();
		const failure = this.lifecycle.phase === "failed" ? failureMetadata(this.lifecycle.error) : undefined;
		const durationMs = this.run.endTime === undefined ? undefined : Math.max(0, this.run.endTime - this.run.startTime);
		return {
			agent_id: this.id,
			agent: resolvedRun.agent,
			task_name: this.run.taskName,
			profile: resolvedRun.profile,
			model: resolvedRun.model,
			effective_thinking: resolvedRun.effectiveThinking,
			...(this.run.sessionId ? { session_id: this.run.sessionId } : {}),
			...(this.run.sessionFile ? { session_file: this.run.sessionFile } : {}),
			generation: this.generation,
			retained: this.options.retain,
			status,
			started_at: this.run.startTime,
			...(this.run.endTime === undefined ? {} : { ended_at: this.run.endTime }),
			...(durationMs === undefined ? {} : { duration_ms: durationMs }),
			usage: { ...this.run.usage },
			...(this.run.finalText ? { final_text: this.run.finalText } : {}),
			...(this.run.result ? { result: this.run.result } : {}),
			...(this.run.resultLocator ? { result_locator: this.run.resultLocator } : {}),
			...(error ? { error } : {}),
			...(failure ? { failure } : {}),
			...(this.pendingQuestion ? { pending_question: snapshotQuestion(this.pendingQuestion) } : {}),
		};
	}

	getDetails(): ReadonlyRunDetails {
		return this.snapshot();
	}

	hasPendingResult(generation: number): boolean {
		return generation === this.generation && this.deferred !== undefined && !this.deferred.settled;
	}

	subscribe(listener: (details: ReadonlyRunDetails) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isAvailable(): boolean {
		return (
			this.transport?.getState() === "open" && this.lifecycle.phase !== "closing" && this.lifecycle.phase !== "closed"
		);
	}

	/** Whether this entry still occupies a spawn-concurrency slot. */
	occupiesCapacity(): boolean {
		const transportState = this.transport?.getState();
		if (this.transport === undefined && (this.lifecycle.phase === "failed" || this.lifecycle.phase === "aborted")) {
			return false;
		}
		return (
			this.lifecycle.phase !== "closing" &&
			this.lifecycle.phase !== "closed" &&
			transportState !== "failed" &&
			transportState !== "closed"
		);
	}

	private beginRun(taskName: string): Deferred {
		if (this.deferred && !this.deferred.settled) {
			this.settleDeferred(this.deferred, {
				kind: "reject",
				error: new Error("Agent received a newer run before the previous run settled."),
			});
		}
		// Recovery belongs to the generation that just ended. Keep its task
		// available until that generation is replaced, then allow the next
		// generation to track its own failure independently.
		this.failureTask = undefined;
		const generation = this.generation + 1;
		this.generation = generation;
		this.startedGeneration = undefined;
		this.pendingQuestion = undefined;
		this.queuedCustomAnswer = undefined;
		this.questionSignal = this.newQuestionSignal(generation);
		this.setLifecycle({ phase: "starting" });
		this.run = this.freshRun(taskName);
		const { promise, resolve, reject } = Promise.withResolvers<ReadonlyRunDetails>();
		void promise.catch(() => {});
		const deferred = { generation, promise, resolve, reject, settled: false };
		this.deferred = deferred;
		this.emit();
		return deferred;
	}

	private queueEvent(event: AgentEvent): void {
		const generation = this.generation;
		this.eventTail = this.eventTail
			.then(() => this.processEvent(event, generation))
			.catch((cause) => this.failRun(cause));
	}

	private handleUiRequest(request: ExtensionUiRequest): boolean {
		if (isInputUiRequest(request)) return this.handleInputRequest(request);
		if (!isSelectUiRequest(request) || this.pendingQuestion || this.isClosing()) return false;

		const question: AgentQuestion = {
			question_id: request.id,
			question: request.title,
			options: [...request.options],
		};
		this.pendingQuestion = question;
		const signal =
			this.questionSignal?.generation === this.generation
				? this.questionSignal
				: this.newQuestionSignal(this.generation);
		this.questionSignal = signal;
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
		const queued = this.queuedCustomAnswer;
		if (!queued || queued.generation !== this.generation || this.isClosing()) return false;
		this.queuedCustomAnswer = undefined;
		void this.rpc()
			.respondToUi(request.id, { value: queued.answer })
			.catch((cause) => this.failRun(cause));
		return true;
	}

	private async processEvent(event: AgentEvent, generation: number): Promise<void> {
		if (generation !== this.generation || this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") {
			return;
		}
		if (event.type === "agent_settled" && this.startedGeneration !== generation) return;
		foldAgentEvent(event, this.run);
		if (generation !== this.generation) return;
		if (event.type === "agent_start") {
			this.startedGeneration = generation;
			if (this.lifecycle.phase === "starting") this.setLifecycle({ phase: "running" });
		}
		if (event.type === "agent_settled") {
			if (this.deferred?.settled) return;
			this.pendingQuestion = undefined;
			this.queuedCustomAnswer = undefined;
			this.run.endTime = Date.now();
			const captured = await this.generationCapture.captureSettlement(this.rpc(), generation, this.run.resultId);
			this.applyCapture(captured);
			if (this.lifecycle.phase === "aborted") {
				this.finalizeGeneration(captured);
				this.settleCurrent({ kind: "resolve" });
			} else if (this.run.assistantError) {
				if (this.isClosing()) return;
				const cause = new Error(this.run.assistantError);
				const failure = new RecoverableAgentFailure(
					"provider_failure",
					`${cause.message} The persisted child session and any submitted result checkpoint remain available.`,
					cause,
				);
				this.finalizeGeneration(captured);
				this.setLifecycle({ phase: "failed", error: failure });
				this.settleCurrent({ kind: "reject", error: failure });
			} else {
				this.finalizeGeneration(captured);
				this.setLifecycle({ phase: "idle" });
				this.settleCurrent({ kind: "resolve" });
			}
		}
		this.emit();
	}

	private onExit(error: Error | undefined): void {
		if (this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") return;
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
		if (this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed" || this.failureTask) return;
		const error = toError(cause);
		if (this.lifecycle.phase !== "failed") {
			this.setLifecycle({ phase: "failed", error });
		}
		this.pendingQuestion = undefined;
		this.queuedCustomAnswer = undefined;
		this.run.exitCode = 1;
		this.run.stderr = error.message;
		this.run.endTime = Date.now();
		this.failureTask = this.captureFailedGeneration()
			.catch((captureCause) => {
				this.run.stderr = `${this.run.stderr}\nResult recovery failed: ${toError(captureCause).message}`;
			})
			.finally(() => {
				this.settleCurrent({ kind: "reject", error });
				this.emit();
			});
		this.emit();
	}

	private async closeInternal(): Promise<void> {
		if (this.lifecycle.phase === "closed") return;
		if (this.lifecycle.phase !== "closing") {
			this.setLifecycle({ phase: "closing" });
			this.pendingQuestion = undefined;
			this.queuedCustomAnswer = undefined;
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
				await this.failureTask;
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
				this.setLifecycle({ phase: "closed" });
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
			...(this.run?.sessionId === undefined ? {} : { sessionId: this.run.sessionId }),
			...(this.run?.sessionFile === undefined ? {} : { sessionFile: this.run.sessionFile }),
			resultId: randomBytes(32).toString("hex"),
		});
		run.contextWindow = resolvedRun.contextWindow;
		return run;
	}

	private setLifecycle(next: AgentLifecycle): void {
		this.lifecycle = transitionLifecycle(this.lifecycle, next);
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}

	private snapshot(status: RunStatus = lifecycleStatus(this.lifecycle)): ReadonlyRunDetails {
		const snapshot = snapshotRunData(this.run, {
			agentId: this.id,
			generation: this.generation,
			status,
		});
		return this.pendingQuestion ? { ...snapshot, pendingQuestion: snapshotQuestion(this.pendingQuestion) } : snapshot;
	}

	private newQuestionSignal(generation: number): QuestionSignal {
		const { promise, resolve } = Promise.withResolvers<AgentQuestion>();
		return { generation, promise, resolve, settled: false };
	}

	private notifyWhenComplete(run: Deferred): void {
		if (this.notifiedGenerations.has(run.generation)) return;
		this.notifiedGenerations.add(run.generation);
		void run.promise.then(
			() => {
				const summary = this.summary();
				if (summary.status === "idle") this.options.onBackgroundComplete?.(summary);
				if (!this.options.retain) void this.close().catch(() => {});
			},
			(error: Error) => {
				if (
					this.lifecycle.phase !== "closed" &&
					this.lifecycle.phase !== "closing" &&
					this.lifecycle.phase !== "aborted"
				) {
					this.options.onBackgroundComplete?.({ ...this.summary(), status: "failed", error: error.message });
				}
				if (!this.options.retain) void this.close().catch(() => {});
			},
		);
	}

	private settleCurrent(
		outcome: { readonly kind: "resolve" } | { readonly kind: "reject"; readonly error: Error },
	): void {
		if (this.deferred) this.settleDeferred(this.deferred, outcome);
	}

	private settleDeferred(
		deferred: Deferred,
		outcome: { readonly kind: "resolve" } | { readonly kind: "reject"; readonly error: Error },
	): void {
		if (deferred.settled) return;
		deferred.settled = true;
		if (outcome.kind === "resolve") deferred.resolve(this.snapshot());
		else deferred.reject(outcome.error);
	}

	private async waitForGeneration(
		generation: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<ReadonlyRunDetails> {
		const deferred = this.deferred;
		if (!deferred || deferred.generation !== generation) return this.snapshot();
		if (this.pendingQuestion) {
			this.notifyWhenComplete(deferred);
			return this.snapshot();
		}
		const questionSignal =
			this.questionSignal?.generation === generation
				? this.questionSignal
				: (this.questionSignal = this.newQuestionSignal(generation));
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
							this.notifyWhenComplete(deferred);
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
				guards === undefined ? [deferred.promise, question] : [deferred.promise, question, guards],
			);
			if (result.pendingQuestion) this.notifyWhenComplete(deferred);
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
		this.run.result = resultReference(captured.result);
		this.run.finalText = resultPreview(captured.result.text);
		this.run.usage = { ...captured.stats.usage };
		this.run.tokens = runUsageTotalTokens(captured.stats.usage);
		if (captured.stats.startTime !== undefined) this.run.startTime = captured.stats.startTime;
		if (captured.stats.endTime !== undefined) this.run.endTime = captured.stats.endTime;
		if (captured.assistantError === undefined) delete this.run.assistantError;
		else this.run.assistantError = captured.assistantError;
	}

	private finalizeGeneration(captured: CapturedGeneration): void {
		this.resultSink(captured);
		this.run.resultLocator = captured.locator;
	}

	private async captureFailedGeneration(): Promise<void> {
		const captured = await this.generationCapture.captureFailedGeneration(
			this.transport,
			this.generation,
			this.run.resultId,
		);
		if (captured) {
			this.applyCapture(captured);
			this.finalizeGeneration(captured);
			return;
		}
		const result = await this.readLegacyStoredResult();
		this.run.result = resultReference(result);
		this.run.finalText = resultPreview(result.text);
	}

	private async readLegacyStoredResult(): Promise<StoredAgentResult> {
		const resultId = this.run.resultId;
		const sessionFile = this.run.sessionFile;
		if (sessionFile) {
			try {
				return await readStoredAgentResult(sessionFile, this.generation, resultId, this.agentDir);
			} catch (cause) {
				if (!this.run.lastAssistantText && this.run.result) throw cause;
			}
		}
		const text = this.run.lastAssistantText;
		return Object.freeze({
			generation: this.generation,
			resultId,
			text,
			pageCount: 0,
			complete: true,
			totalBytes: Buffer.byteLength(text, "utf8"),
			sha256: createHash("sha256").update(text, "utf8").digest("hex"),
			source: "assistant" as const,
		});
	}

	private recordOmittedTelemetry(): void {
		this.run.omittedTelemetryRecords++;
		this.emit();
	}

	private rpc(): RpcTransport {
		if (!this.transport || this.transport.getState() !== "open") {
			throw new Error(`Agent ${this.id} is not available.`);
		}
		return this.transport;
	}

	private assertTransport(transport: RpcTransport): void {
		if (this.transport !== transport || this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") {
			throw new Error(`Agent ${this.id} was closed during startup.`);
		}
	}

	private isClosing(): boolean {
		return this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed";
	}

	private assertAvailableForFollowUp(): void {
		if (this.transport?.getState() !== "open") {
			throw new Error(`Agent ${this.id} process is dead; close it and spawn a replacement before following up.`);
		}
		if (this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") {
			throw new Error(`Agent ${this.id} is closed.`);
		}
		if (this.pendingQuestion) {
			throw new Error(
				`Agent ${this.id} is waiting for an answer to question '${this.pendingQuestion.question_id}'; use answer_agent.`,
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
