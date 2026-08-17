import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { composeAbortSignal, onAbort } from "../_shared/abort.ts";
import { toError } from "../_shared/errors.ts";
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

let nextAgentId = 1;

export function reserveManagedAgentIds(agentIds: Iterable<string>): void {
	for (const id of agentIds) {
		const suffix = /-(\d+)$/.exec(id)?.[1];
		if (suffix && Number(suffix) >= nextAgentId) nextAgentId = Number(suffix) + 1;
	}
}

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
	/** Test seam for contract tests; production always constructs an SDK session. */
	readonly sessionFactory?: (customTools: readonly ToolDefinition[]) => Promise<AgentSession>;
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
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private phaseState: AgentPhase = "created";
	private current: Generation | undefined;
	private nextGeneration = 0;
	private closePromise: Promise<void> | undefined;

	constructor(options: ManagedAgentOptions) {
		this.options = options;
		this.id = options.id ?? `${options.agent.name}-${nextAgentId++}`;
		this.cwd = options.cwd ?? options.defaultCwd;
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
		if (this.phaseState !== "created") throw new Error("Subagent already started.");
		this.phaseState = "starting";
		this.emit();
		try {
			await this.open();
			if (this.phaseState !== "starting") {
				this.disposeSession();
				throw new Error(`Agent ${this.id} was closed while its session was starting.`);
			}
		} catch (cause) {
			if (this.phaseState === "starting") {
				this.phaseState = "failed";
				this.emit();
			}
			throw cause;
		}
		return this.launch(buildInitialTask(message, handoff), taskName, background, signal);
	}

	async followUp(
		message: string,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (!this.options.retain)
			throw new Error(`Agent ${this.id} is one-shot. Spawn with retain:true before using followup_agent.`);
		if (this.phaseState === "closed" || this.phaseState === "closing") throw new Error(`Agent ${this.id} is closed.`);
		if (this.current?.question) {
			throw new Error(
				`Agent ${this.id} is waiting for '${this.current.question.question.question_id}'; use answer_agent.`,
			);
		}
		if (this.phaseState === "starting" || this.phaseState === "running") {
			throw new Error(`Agent ${this.id} is still running; use send_agent or wait_agent before a follow-up.`);
		}
		return this.launch(message, taskName, background, signal);
	}

	async steer(message: string): Promise<void> {
		if (!this.session || (this.phaseState !== "starting" && this.phaseState !== "running")) {
			throw new Error(`Agent ${this.id} is not running.`);
		}
		if (this.current?.question) throw new Error(`Agent ${this.id} is waiting for input; use answer_agent.`);
		await this.session.steer(message);
	}

	async answerQuestion(questionId: string, answer: string): Promise<void> {
		const pending = this.current?.question;
		if (!pending || pending.question.question_id !== questionId) {
			throw new Error(`Agent ${this.id} has no pending question '${questionId}'.`);
		}
		delete this.current!.question;
		this.current!.questionArrival = Promise.withResolvers<void>();
		pending.resolve(answer);
		this.emit();
	}

	async wait(timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const current = this.current;
		if (!current || current.settled || current.question) return this.snapshot();
		return this.waitFor(current, timeoutMs, signal);
	}

	async interrupt(): Promise<void> {
		const current = this.current;
		if (!current || current.settled || !this.session) return;
		current.aborted = true;
		this.phaseState = "aborted";
		this.cancelPendingQuestion(current, `Agent ${this.id} was interrupted while waiting for input.`);
		this.emit();
		await this.session.abort();
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = (async () => {
			if (this.phaseState === "closed") return;
			this.phaseState = "closing";
			this.emit();
			const current = this.current;
			if (current && !current.settled) {
				current.aborted = true;
				this.cancelPendingQuestion(current, `Agent ${this.id} was closed while waiting for input.`);
				await this.session?.abort().catch(() => {});
			}
			this.disposeSession();
			this.phaseState = "closed";
			this.emit();
			this.listeners.clear();
		})();
		return this.closePromise;
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
						resolve: (answer) => {
							cleanup();
							resolve(answer);
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
			this.session = await this.options.sessionFactory(customTools);
			this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
			return;
		}
		const directory = path.join(this.options.agentDir, "subagent-sessions");
		await fs.promises.mkdir(directory, { recursive: true });
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
			questionArrival: Promise.withResolvers<void>(),
		};
		this.current = generation;
		this.phaseState = "running";
		this.emit();
		void this.session.prompt(message, { expandPromptTemplates: false }).then(
			() => this.settle(generation),
			(error) => this.fail(generation, error),
		);
		return background ? Promise.resolve(this.snapshot("launched")) : this.waitFor(generation, undefined, signal);
	}

	private async settle(generation: Generation): Promise<void> {
		if (generation.settled || this.current !== generation) return;
		const manager = this.session?.sessionManager;
		const entry = manager
			?.getBranch()
			.findLast(
				(candidate) =>
					!generation.initialEntryIds.has(candidate.id) &&
					candidate.type === "message" &&
					candidate.message.role === "assistant",
			);
		const text = assistantText(entry) ?? "";
		const stopReason =
			entry?.type === "message" && entry.message.role === "assistant" ? entry.message.stopReason : undefined;
		const complete = stopReason === "stop";
		const result = storedResult(generation.number, generation.run.resultId, text, complete);
		const sessionId = this.session?.sessionId ?? generation.run.sessionId;
		const sessionFile = this.session?.sessionFile ?? generation.run.sessionFile;
		if (!sessionId || !sessionFile) {
			this.fail(generation, new Error(`Agent ${this.id} settled without a persisted child session.`));
			return;
		}
		const locator: GenerationResultLocator = {
			version: 2,
			generation: generation.number,
			resultId: result.resultId,
			sessionId,
			sessionFile,
			resultEntryId: entry?.id ?? null,
			resultSha256: result.sha256,
		};
		generation.run.result = resultReference(result);
		generation.run.resultLocator = locator;
		generation.run.finalText = resultPreview(text);
		if (stopReason === "error" && !generation.run.error) {
			generation.run.error =
				entry?.type === "message" && entry.message.role === "assistant"
					? (entry.message.errorMessage ?? "Subagent assistant failed.")
					: "Subagent assistant failed.";
		}
		generation.run.endTime = Date.now();
		generation.settled = true;
		const terminalPhase: AgentPhase =
			generation.aborted || stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "idle";
		if (this.phaseState !== "closing" && this.phaseState !== "closed") this.phaseState = terminalPhase;
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
		if (!this.options.retain) await this.close();
	}

	private fail(generation: Generation, cause: unknown): void {
		if (generation.settled || this.current !== generation) return;
		const error = toError(cause);
		generation.run.error = error.message;
		generation.run.endTime = Date.now();
		generation.settled = true;
		const terminalPhase = generation.aborted ? "aborted" : "failed";
		if (this.phaseState !== "closing" && this.phaseState !== "closed") this.phaseState = terminalPhase;
		generation.reject(error);
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
		if (!this.options.retain) void this.close();
	}

	private handleEvent(event: AgentSessionEvent): void {
		const generation = this.current;
		if (!generation || generation.settled) return;
		foldSessionEvent(event, generation.run);
		const contextUsage = this.session?.getContextUsage();
		if (contextUsage) generation.run.contextUsage = { ...contextUsage };
		this.emit();
	}

	private cancelPendingQuestion(generation: Generation, message: string): void {
		const pending = generation.question;
		if (!pending) return;
		delete generation.question;
		pending.reject(new Error(message));
	}

	private disposeSession(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session?.dispose();
		this.session = undefined;
	}

	private async waitFor(generation: Generation, timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const guard = composeAbortSignal(signal, timeoutMs);
		const question = generation.questionArrival.promise.then(() => {
			if (generation.question) {
				generation.background = true;
				return this.snapshot();
			}
			return generation.completion;
		});
		if (!guard) return Promise.race([generation.completion, question]);
		let remove: Disposable | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			remove = onAbort(guard.signal, () => {
				if (!generation.background) generation.background = true;
				reject(
					new AgentWaitInterruptedError(guard.timedOut() ? "timed_out" : "cancelled", this.id, guard.signal.reason),
				);
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
			...(current.question ? { pendingQuestion: current.question.question } : {}),
		});
	}

	private emit(): void {
		const details = this.snapshot();
		for (const listener of this.listeners) listener(details);
	}
}

export function buildInitialTask(message: string, handoff: string | undefined): string {
	return handoff?.trim()
		? `Task: ${message}\n\nParent context (may be incomplete; use it to understand the assignment and verify factual claims when material):\n${handoff}`
		: `Task: ${message}`;
}
