import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
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
import { Type } from "typebox";
import { toError } from "../_shared/errors.ts";
import { getProcessReaper, type ProcessReaper } from "../process-reaper/index.ts";
import type { AgentConfig } from "./agents.ts";
import {
	AgentWaitInterruptedError,
	lifecycleStatus,
	type AgentPhase,
	type AgentQuestion,
	type AgentSummary,
	type AgentView,
} from "./agent-types.ts";
import type { ResolvedRun } from "./profiles.ts";
import {
	assistantText,
	paginateStoredResult,
	resultPreview,
	resultReference,
	storedResult,
	type GenerationResultLocator,
	type ResultPage,
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

/** Silent child time before a generation is considered stuck and aborted internally. */
export const AGENT_STARTUP_TIMEOUT_MS = 120_000;
const PRESENTATION_INTERVAL_MS = 150;

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
	readonly resolve: (answer: string) => void;
	readonly reject: (error: Error) => void;
}

interface Generation {
	readonly number: number;
	readonly completion: Promise<ReadonlyRunDetails>;
	readonly resolve: (details: ReadonlyRunDetails) => void;
	readonly reject: (error: Error) => void;
	readonly run: MutableRunData;
	readonly initialEntryIds: ReadonlySet<string>;
	settled: boolean;
	background: boolean;
	aborted: boolean;
	/** Set when the stall watchdog aborted this generation for inactivity. */
	stalled: boolean;
	questionArrival: ReturnType<typeof Promise.withResolvers<void>>;
	question?: PendingQuestion;
}

export interface ManagedAgentOptions {
	readonly id?: string;
	readonly agentDir: string;
	readonly defaultCwd: string;
	readonly cwd?: string;
	readonly agent: AgentConfig;
	readonly resolvedRun: ResolvedRun;
	readonly retain: boolean;
	readonly processReaper?: Pick<ProcessReaper, "terminateOwner">;
	/** Test seam for contract tests; production always constructs an SDK session. */
	readonly sessionFactory?: (customTools: readonly ToolDefinition[]) => Promise<AgentSession>;
	/** Test seam for the stall-watchdog threshold; production uses AGENT_STALL_TIMEOUT_MS. */
	readonly stallTimeoutMs?: number;
	readonly startupTimeoutMs?: number;
	readonly onCleanupError?: (summary: AgentSummary, error: Error) => void;
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
	private readonly processReaper: Pick<ProcessReaper, "terminateOwner">;
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private phaseState: AgentPhase = "created";
	private current: Generation | undefined;
	private nextGeneration = 0;
	private closePromise: Promise<void> | undefined;
	private startupMs: number | undefined;
	private presentationTimer: NodeJS.Timeout | undefined;
	private stallTimer: NodeJS.Timeout | undefined;

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

	async followUp(
		message: string,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		return this.submit({ kind: "follow_up", message, taskName, background, signal });
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
				return this.launch(route.input.message, route.input.taskName, route.input.background, route.input.signal);
			case "steer":
				return this.steerActiveTurn(route.input);
			case "answer":
				return this.answerPendingQuestion(route.input);
		}
	}

	private async openAndLaunch(input: StartTurnInput): Promise<ReadonlyRunDetails> {
		this.phaseState = "starting";
		this.emit();
		const started = Date.now();
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.open(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Agent ${this.id} startup timed out.`)),
						this.options.startupTimeoutMs ?? AGENT_STARTUP_TIMEOUT_MS,
					);
				}),
			]);
			this.startupMs = Date.now() - started;
			if (this.phaseState !== "starting") {
				this.disposeSession();
				throw new Error(`Agent ${this.id} was closed while its session was starting.`);
			}
		} catch (cause) {
			if (this.phaseState === "starting") {
				this.phaseState = "idle";
				this.emit();
			}
			await this.close().catch((error) => this.reportCleanupError(error));
			throw cause;
		} finally {
			clearTimeout(timer);
		}
		return this.launch(buildInitialTask(input.message, input.handoff), input.taskName, input.background, input.signal);
	}

	private async steerActiveTurn(input: SteerTurnInput): Promise<void> {
		const session = this.session;
		if (!session) throw new Error(`Agent ${this.id} lost its running session.`);
		await session.steer(input.message);
	}

	private answerPendingQuestion(input: AnswerTurnInput): void {
		const pending = this.current?.question;
		if (!pending || pending.question.question_id !== input.questionId)
			throw new Error(`Agent ${this.id} lost its pending question.`);
		delete this.current!.question;
		this.current!.questionArrival = Promise.withResolvers<void>();
		pending.resolve(input.answer);
		this.emit();
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

	async wait(signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const current = this.current;
		if (!current || current.settled || current.question) return this.snapshot();
		return this.waitFor(current, signal);
	}

	async interrupt(): Promise<void> {
		const current = this.current;
		if (!current || current.settled || !this.session) {
			await this.reapOwnedProcesses();
			return;
		}
		current.aborted = true;
		this.cancelPendingQuestion(current, `Agent ${this.id} was interrupted while waiting for input.`);
		this.emit();
		await this.session.abort();
		await this.reapOwnedProcesses();
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = (async () => {
			if (this.phaseState === "closed") return;
			this.phaseState = "closing";
			this.clearStallWatchdog();
			this.emit();
			const errors: unknown[] = [];
			const current = this.current;
			if (current && !current.settled) {
				current.aborted = true;
				this.cancelPendingQuestion(current, `Agent ${this.id} was closed while waiting for input.`);
				try {
					await this.session?.abort();
				} catch (error) {
					errors.push(error);
				}
				try {
					await this.settle(current, false);
				} catch (error) {
					errors.push(error);
				}
			}
			try {
				await this.reapOwnedProcesses();
			} catch (error) {
				errors.push(error);
			}
			try {
				this.disposeSession();
			} catch (error) {
				errors.push(error);
			}
			const failure = errors.length
				? new AggregateError(errors, errors.map((error) => toError(error).message).join("; "))
				: undefined;
			if (failure && current) current.run.cleanupError = failure.message;
			this.phaseState = "closed";
			this.emit();
			this.listeners.clear();
			if (failure) throw failure;
		})();
		return this.closePromise;
	}

	private reportCleanupError(cause: unknown): void {
		this.options.onCleanupError?.(this.summary(), toError(cause));
	}

	private async closeAfterSettlement(): Promise<void> {
		if (this.options.retain || this.phaseState === "closing" || this.phaseState === "closed") return;
		try {
			await this.close();
		} catch (error) {
			this.reportCleanupError(error);
		}
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
			...(details.outcome ? { outcome: details.outcome } : {}),
			...(details.cleanupError ? { cleanup_error: details.cleanupError } : {}),
			...(details.startupMs === undefined ? {} : { startup_ms: details.startupMs }),
			...(details.firstResponseMs === undefined ? {} : { first_response_ms: details.firstResponseMs }),
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
		if (this.phaseState === "closed" || this.phaseState === "closing") return false;
		return this.phaseState === "starting" || this.session !== undefined;
	}

	hasPendingResult(generation: number): boolean {
		return this.current?.number === generation && !this.current.settled;
	}

	readLiveResultPreview(
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): ResultPage {
		const current = this.current;
		if (!current || current.settled || (options.generation !== undefined && options.generation !== current.number)) {
			throw new Error(`Agent ${this.id} has no live result preview.`);
		}
		return paginateStoredResult(
			this.id,
			storedResult(current.number, current.run.resultId, resultPreview(current.run.liveAssistantPreview), false),
			options,
		);
	}

	async getMessages(): Promise<unknown[]> {
		return this.session?.messages ?? [];
	}

	private async open(): Promise<void> {
		const askQuestion = defineTool({
			name: "ask_question",
			label: "Ask Question",
			description: "Ask the parent a multiple-choice question and wait for its answer.",
			parameters: Type.Object(
				{
					question: Type.String({ minLength: 1 }),
					alternatives: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 5 }),
				},
				{ additionalProperties: false },
			),
			execute: async (_id, params, signal) => {
				const generation = this.current;
				if (!generation || generation.settled) throw new Error("No active subagent generation.");
				const question: AgentQuestion = {
					question_id: randomBytes(16).toString("hex"),
					question: params.question,
					options: [...params.alternatives],
				};
				const answer = await new Promise<string>((resolve, reject) => {
					const cleanup = () => signal?.removeEventListener("abort", abort);
					const abort = () => {
						if (generation.question?.question.question_id === question.question_id) {
							delete generation.question;
							generation.questionArrival = Promise.withResolvers<void>();
							this.emit();
						}
						cleanup();
						reject(new Error(`Subagent question was cancelled: ${String(signal?.reason ?? "aborted")}`));
					};
					generation.question = {
						question,
						resolve: (resolvedAnswer) => {
							cleanup();
							resolve(resolvedAnswer);
						},
						reject: (error) => {
							cleanup();
							reject(error);
						},
					};
					generation.questionArrival.resolve();
					this.emit();
					this.options.onQuestion?.(this.summary(), question);
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				});
				return { content: [{ type: "text", text: answer }], details: { answer } };
			},
		});
		const tools = this.options.agent.tools ? [...this.options.agent.tools] : [];
		const customTools = tools.includes("ask_question") ? [askQuestion] : [];
		if (this.options.sessionFactory) {
			this.attachSession(await this.options.sessionFactory(customTools));
			return;
		}
		const directory = path.join(this.options.agentDir, "subagent-sessions");
		await fs.promises.mkdir(directory, { recursive: true });
		const manager = SessionManager.create(this.cwd, directory);
		const loader = createChildResourceLoader(this.cwd, this.options.agentDir, this.options.agent.systemPrompt);
		await loader.reload();
		if (this.phaseState !== "starting") throw new Error(`Agent ${this.id} was closed while its session was starting.`);
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
		this.attachSession(session);
	}

	private attachSession(session: AgentSession): void {
		if (this.phaseState !== "starting") {
			session.dispose();
			throw new Error(`Agent ${this.id} was closed while its session was starting.`);
		}
		this.session = session;
		this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
	}

	private launch(
		message: string,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (!this.session) throw new Error(`Agent ${this.id} did not open its child session.`);
		const { promise, resolve, reject } = Promise.withResolvers<ReadonlyRunDetails>();
		void promise.catch(() => {});
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
		if (this.nextGeneration === 0 && this.startupMs !== undefined) run.startupMs = this.startupMs;
		const generation: Generation = {
			number: ++this.nextGeneration,
			completion: promise,
			resolve,
			reject,
			run,
			initialEntryIds: new Set(this.session.sessionManager.getEntries().map((entry) => entry.id)),
			settled: false,
			background,
			aborted: false,
			stalled: false,
			questionArrival: Promise.withResolvers<void>(),
		};
		this.current = generation;
		this.phaseState = "running";
		this.watchForStall(generation);
		this.emit();
		void this.session
			.prompt(message, { expandPromptTemplates: false })
			.then(
				() => this.settle(generation),
				(error) => this.fail(generation, error),
			)
			.catch((error) => this.reportCleanupError(error));
		return background ? Promise.resolve(this.snapshot("launched")) : this.waitFor(generation, signal);
	}

	private async settle(generation: Generation, closeWhenSettled = true): Promise<void> {
		if (generation.settled || this.current !== generation) return;
		this.clearStallWatchdog();
		const entry = this.terminalAssistantEntry(generation);
		if (!entry) {
			this.fail(generation, new Error(`Agent ${this.id} completed without a terminal assistant message.`));
			return;
		}
		try {
			this.persistResult(generation, entry);
		} catch (cause) {
			this.fail(generation, cause);
			return;
		}
		const stopReason = entry.message.stopReason;
		if (generation.stalled && !generation.run.error) {
			generation.run.error = this.stallErrorMessage();
		}
		if (stopReason === "error" && !generation.run.error) {
			generation.run.error = entry.message.errorMessage ?? "Subagent assistant failed.";
		}
		generation.run.endTime = Date.now();
		generation.settled = true;
		const terminalPhase = generation.stalled
			? "failed"
			: generation.aborted || stopReason === "aborted"
				? "aborted"
				: stopReason === "error"
					? "failed"
					: "idle";
		if (this.phaseState !== "closing" && this.phaseState !== "closed") this.phaseState = "idle";
		generation.run.outcome =
			terminalPhase === "failed"
				? "failed"
				: terminalPhase === "aborted"
					? "aborted"
					: stopReason === "stop"
						? "succeeded"
						: "incomplete";
		const details = this.snapshot();
		generation.resolve(details);
		generation.questionArrival.resolve();
		this.emit();
		if (
			generation.background &&
			this.phaseState !== "closing" &&
			this.phaseState !== "closed" &&
			(terminalPhase === "idle" || terminalPhase === "failed")
		) {
			this.options.onBackgroundComplete?.(this.summary());
		}
		if (closeWhenSettled) await this.closeAfterSettlement();
	}

	private fail(generation: Generation, cause: unknown): void {
		if (generation.settled || this.current !== generation) return;
		this.clearStallWatchdog();
		const error = toError(cause);
		try {
			this.persistResult(generation, this.terminalAssistantEntry(generation));
		} catch (persistenceCause) {
			generation.run.error = `${error.message} (result persistence failed: ${toError(persistenceCause).message})`;
		}
		generation.run.error ??= generation.stalled ? this.stallErrorMessage() : error.message;
		generation.run.endTime = Date.now();
		generation.settled = true;
		const terminalPhase = generation.aborted ? "aborted" : "failed";
		generation.run.outcome = terminalPhase;
		if (this.phaseState !== "closing" && this.phaseState !== "closed") this.phaseState = "idle";
		const details = this.snapshot();
		if (generation.aborted) generation.resolve(details);
		else generation.reject(error);
		generation.questionArrival.resolve();
		this.emit();
		if (
			generation.background &&
			this.phaseState !== "closing" &&
			this.phaseState !== "closed" &&
			terminalPhase === "failed"
		) {
			this.options.onBackgroundComplete?.(this.summary());
		}
		void this.closeAfterSettlement();
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
		if (!sessionId || !sessionFile) throw new Error(`Agent ${this.id} settled without a persisted child session.`);
		const locator: GenerationResultLocator = {
			version: 2,
			generation: generation.number,
			resultId: result.resultId,
			sessionId,
			sessionFile,
			resultEntryId: entry.id,
			resultSha256: result.sha256,
		};
		generation.run.result = resultReference(result);
		generation.run.resultLocator = locator;
		generation.run.finalText = resultPreview(text);
	}

	private handleEvent(event: AgentSessionEvent): void {
		const generation = this.current;
		if (!generation || generation.settled) return;
		foldSessionEvent(event, generation.run);
		if (
			generation.run.firstResponseMs === undefined &&
			(event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			generation.run.firstResponseMs = Date.now() - generation.run.startTime;
		}
		if (event.type === "message_end" || event.type === "compaction_end") {
			const contextUsage = this.session?.getContextUsage();
			if (contextUsage) generation.run.contextUsage = { ...contextUsage };
		}
		if (!this.presentationTimer)
			this.presentationTimer = setTimeout(() => {
				this.presentationTimer = undefined;
				this.emit();
			}, PRESENTATION_INTERVAL_MS);
	}

	private cancelPendingQuestion(generation: Generation, message: string): void {
		const pending = generation.question;
		if (!pending) return;
		delete generation.question;
		pending.reject(new Error(message));
	}

	/** Arm the per-generation liveness watchdog; activity stamps keep deferring it. */
	private watchForStall(generation: Generation): void {
		this.clearStallWatchdog();
		const thresholdMs = this.stallTimeoutMs();
		const schedule = (delayMs: number) => {
			this.stallTimer = setTimeout(() => this.checkForStall(generation, thresholdMs, schedule), delayMs);
			this.stallTimer.unref?.();
		};
		schedule(thresholdMs);
	}

	private checkForStall(generation: Generation, thresholdMs: number, schedule: (delayMs: number) => void): void {
		if (generation.settled || this.current !== generation) return;
		// A child parked at ask_question emits no events while waiting for its
		// answer; poll again later instead of treating the human as a hang.
		if (generation.question) {
			schedule(thresholdMs);
			return;
		}
		const remainingMs = thresholdMs - (Date.now() - generation.run.lastActivityTime);
		if (remainingMs > 0) {
			schedule(remainingMs);
			return;
		}
		void this.recoverStalledGeneration(generation).catch((error) => this.reportCleanupError(error));
	}

	/** Abort a silent generation so it settles through the normal failure path. */
	private async recoverStalledGeneration(generation: Generation): Promise<void> {
		if (generation.settled || this.current !== generation || generation.question) return;
		generation.stalled = true;
		await this.session?.abort().catch(() => {});
		await this.reapOwnedProcesses();
		// abort() waits for Pi to reach idle and prompt resolution then flows into
		// settle()/fail(), but settle defensively here as well so an incomplete or
		// misbehaving session cannot leave an unsettled stalled generation behind.
		await this.settle(generation);
	}

	private clearStallWatchdog(): void {
		if (this.stallTimer === undefined) return;
		clearTimeout(this.stallTimer);
		this.stallTimer = undefined;
	}

	private stallTimeoutMs(): number {
		return this.options.stallTimeoutMs ?? AGENT_STALL_TIMEOUT_MS;
	}

	private stallErrorMessage(): string {
		return `Subagent stalled: no activity for ${formatStallDuration(this.stallTimeoutMs())}; the run was aborted internally.`;
	}

	private disposeSession(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const session = this.session;
		this.session = undefined;
		session?.dispose();
	}

	private async reapOwnedProcesses(): Promise<void> {
		if (this.session === undefined) return;
		await this.processReaper.terminateOwner(this.session.sessionId);
	}

	private async waitFor(generation: Generation, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const question = generation.questionArrival.promise.then(() => {
			if (generation.question) {
				generation.background = true;
				return this.snapshot();
			}
			return generation.completion;
		});
		if (!signal) return Promise.race([generation.completion, question]);
		let remove: Disposable | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			remove = addAbortListener(signal, () => {
				if (!generation.background) generation.background = true;
				reject(new AgentWaitInterruptedError(this.id, signal.reason));
			});
		});
		try {
			return await Promise.race([generation.completion, question, interrupted]);
		} finally {
			remove?.[Symbol.dispose]();
		}
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
		clearTimeout(this.presentationTimer);
		this.presentationTimer = undefined;
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

/** Load only session-relevant extensions, before any factory executes. Project instructions and skills still use native discovery. */
export function createChildResourceLoader(cwd: string, agentDir: string, systemPrompt: string): DefaultResourceLoader {
	const childExtensions = ["codex-apply-patch/index.ts", "nested-context.ts", "process-reaper/index.ts"]
		.map((relative) => path.resolve(agentDir, "extensions", relative))
		.filter((file) => fs.existsSync(file));
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		appendSystemPrompt: [systemPrompt],
		noExtensions: true,
		additionalExtensionPaths: childExtensions,
	});
}
