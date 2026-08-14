import { randomBytes } from "node:crypto";
import { toError } from "../_shared/errors.ts";
import type { AgentConfig } from "./agents.ts";
import { AgentGeneration, failureMetadata, recoverableTransportFailure } from "./agent-generation.ts";
import type { AgentPhase, AgentQuestion, AgentSummary, AgentView } from "./agent-types.ts";
import { CleanupAggregateError, lifecycleStatus } from "./agent-types.ts";
import { ChildSession, type ChildSessionEvent } from "./child-session.ts";
import type { ChildExecutionContext } from "./child-process.ts";
import type { ResolvedRun } from "./profiles.ts";
import { readChildTranscript, type CapturedGeneration, type ResultPage } from "./result-store.ts";
import {
	initRunData,
	snapshotRunData,
	type MutableRunData,
	type ReadonlyRunDetails,
	type RunStatus,
} from "./run-state.ts";
import type { ChildSessionIdentity } from "./session-cursors.ts";
import type { SpawnRpcProcess } from "./rpc-transport.ts";

let nextAgentId = 1;

export function reserveManagedAgentIds(agentIds: Iterable<string>): void {
	for (const agentId of agentIds) {
		const suffix = /-(\d+)$/.exec(agentId)?.[1];
		if (suffix === undefined) continue;
		const value = Number(suffix);
		if (Number.isSafeInteger(value) && value >= nextAgentId) nextAgentId = value + 1;
	}
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

/**
 * Stable facade for one subagent identity.
 *
 * ChildSession owns process resources and AgentGeneration owns every mutable
 * prompt lifecycle. This class only coordinates their boundaries and exposes
 * the tool-facing API.
 */
export class ManagedAgent {
	readonly id: string;
	private readonly options: ManagedAgentOptions;
	private readonly session: ChildSession;
	private lifecycle: "created" | "closing" | "closed" = "created";
	private currentGeneration: AgentGeneration | undefined;
	private nextGeneration = 0;
	private initialRun: MutableRunData;
	private readonly listeners = new Set<(details: ReadonlyRunDetails) => void>();
	private closePromise: Promise<void> | undefined;
	private resultSink: (captured: CapturedGeneration) => void = () => {};

	constructor(options: ManagedAgentOptions) {
		this.options = options;
		this.id = options.id ?? `${options.agent.name}-${nextAgentId++}`;
		this.session = new ChildSession({
			agentId: this.id,
			agentDir: options.agentDir,
			defaultCwd: options.defaultCwd,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			agent: options.agent,
			resolvedRun: options.resolvedRun,
			childContext: options.childContext,
			...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
			...(options.validateSessionIdentity === undefined
				? {}
				: { validateSessionIdentity: options.validateSessionIdentity }),
			onEvent: (event) => this.handleSessionEvent(event),
		});
		this.initialRun = this.freshRun();
	}

	attachResultSink(sink: (captured: CapturedGeneration) => void): void {
		this.resultSink = sink;
	}

	get phase(): AgentPhase {
		if (this.lifecycle !== "created") return this.lifecycle;
		return this.currentGeneration?.phase ?? "created";
	}

	async start(
		message: string,
		handoff: string | undefined,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		if (this.phase !== "created") throw new Error("Subagent already started.");
		const generation = this.beginGeneration(taskName);
		let releaseForeground: (() => void) | undefined;
		try {
			const identity = await this.session.open();
			this.assertOpen();
			generation.setSessionIdentity(identity);
			await generation.prepare();
			if (!background) releaseForeground = generation.reserveForegroundWaiter();
			await generation.prompt(buildInitialTask(message, handoff));
		} catch (cause) {
			releaseForeground?.();
			const error = toError(cause);
			if (!this.isClosing()) generation.fail(error);
			try {
				await this.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], `Agent ${this.id} startup and cleanup failed.`);
			}
			throw error;
		}

		if (background) {
			generation.promoteCompletion();
			return this.snapshot("launched");
		}
		try {
			return await generation.waitForeground(signal);
		} finally {
			releaseForeground?.();
			if (!this.options.retain && generation.isSettled) await this.close();
		}
	}

	async steer(message: string): Promise<void> {
		await this.requireGeneration().steer(message);
	}

	answerQuestion(questionId: string, answer: string): Promise<void> {
		return this.requireGeneration().answerQuestion(questionId, answer);
	}

	async getMessages(): Promise<unknown[]> {
		const sessionFile = this.snapshot().sessionFile;
		if (!sessionFile) throw new Error(`Agent ${this.id} has no persisted session.`);
		return readChildTranscript(sessionFile, this.options.agentDir);
	}

	async readLiveResultPreview(
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		const generation = options.generation ?? this.currentGeneration?.generation;
		const current = this.currentGeneration;
		if (!current || generation !== current.generation || !current.hasPendingResult(generation)) {
			throw new Error(`Agent ${this.id} has no live result preview for generation ${generation ?? 0}.`);
		}
		return current.readLiveResultPreview(options);
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
		const previous = this.requireGeneration();
		// Drain every child event received before deciding whether this prompt
		// continues the active generation. That prevents a queued settlement from
		// racing a freshly allocated generation.
		await previous.drain();
		this.assertAvailableForFollowUp();
		if (previous.isAborted && !previous.isSettled) await previous.completion.promise.catch(() => {});
		if (previous.isFailed && previous.recovery) await previous.recovery;

		const continuesActiveGeneration = previous.isActive;
		const generation = continuesActiveGeneration ? previous : this.beginGeneration(taskName);
		if (continuesActiveGeneration) generation.setTaskName(taskName);
		let releaseForeground: (() => void) | undefined;
		try {
			if (!background) releaseForeground = generation.reserveForegroundWaiter();
			if (!continuesActiveGeneration) await generation.prepare();
			await generation.prompt(message, continuesActiveGeneration ? "followUp" : undefined);
		} catch (cause) {
			releaseForeground?.();
			throw cause;
		}

		if (background) {
			generation.promoteCompletion();
			return this.snapshot("launched");
		}
		try {
			return await generation.waitForeground(signal);
		} finally {
			releaseForeground?.();
		}
	}

	async wait(timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		return this.currentGeneration?.wait(timeoutMs, signal) ?? this.snapshot();
	}

	interrupt(): Promise<void> {
		return this.currentGeneration?.interrupt() ?? Promise.resolve();
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	summary(): AgentSummary {
		const details = this.snapshot();
		const status = lifecycleStatus({ phase: this.phase });
		const failed = this.phase === "failed" && this.currentGeneration?.isFailed;
		const error = failed ? this.currentGeneration?.error?.message : details.assistantError;
		const failure = failed && this.currentGeneration?.error ? failureMetadata(this.currentGeneration.error) : undefined;
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
	}

	view(): AgentView {
		const details = this.snapshot();
		return { summary: this.summary(), details };
	}

	hasPendingResult(generation: number): boolean {
		return this.currentGeneration?.hasPendingResult(generation) ?? false;
	}

	subscribe(listener: (details: ReadonlyRunDetails) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isAvailable(): boolean {
		return this.session.isOpen && !this.isClosing();
	}

	/** Whether this entry still occupies a spawn-concurrency slot. */
	occupiesCapacity(): boolean {
		const transportState = this.session.state;
		if (transportState === "created" && (this.phase === "failed" || this.phase === "aborted")) return false;
		return (
			this.phase !== "closing" && this.phase !== "closed" && transportState !== "failed" && transportState !== "closed"
		);
	}

	private beginGeneration(taskName: string): AgentGeneration {
		const previous = this.currentGeneration;
		if (previous && !previous.isSettled) {
			previous.close(new Error("Agent received a newer run before the previous run settled."));
		}
		const generation = new AgentGeneration({
			agentId: this.id,
			generation: ++this.nextGeneration,
			run: this.freshRun(taskName),
			session: this.session,
			onChange: () => this.emit(),
			onCapture: (captured) => this.resultSink(captured),
			onQuestion: (run, question) => this.handleGenerationQuestion(run, question),
			onCompletion: (run, error) => this.handleGenerationCompletion(run, error),
		});
		this.currentGeneration = generation;
		this.emit();
		return generation;
	}

	private handleSessionEvent(event: ChildSessionEvent): boolean | void {
		if (this.isClosing()) return false;
		const generation = this.currentGeneration;
		switch (event.kind) {
			case "agent-event":
				generation?.receiveAgentEvent(event.event);
				return;
			case "ui-request":
				return generation?.handleUiRequest(event.request) ?? false;
			case "oversized-record":
				generation?.recordOmittedTelemetry();
				return;
			case "exit":
				if (generation) {
					generation.fail(recoverableTransportFailure(event.error ?? new Error("Subagent process exited.")));
				}
				return;
		}
	}

	private handleGenerationQuestion(generation: AgentGeneration, question: AgentQuestion): void {
		if (this.currentGeneration !== generation || this.isClosing()) return;
		this.options.onQuestion?.(this.summary(), question);
	}

	private handleGenerationCompletion(generation: AgentGeneration, error: Error | undefined): void {
		if (this.currentGeneration !== generation) return;
		if (error === undefined) {
			const summary = this.summary();
			if (summary.status === "idle") this.options.onBackgroundComplete?.(summary);
		} else if (this.phase !== "closing" && this.phase !== "closed" && this.phase !== "aborted") {
			this.options.onBackgroundComplete?.({ ...this.summary(), status: "failed", error: error.message });
		}
		if (!this.options.retain) void this.close().catch(() => {});
	}

	private async closeInternal(): Promise<void> {
		if (this.lifecycle === "closed") return;
		this.lifecycle = "closing";
		this.emit();
		const generation = this.currentGeneration;
		generation?.close(new Error(`Agent ${this.id} was closed.`));
		const failures: unknown[] = [];
		try {
			try {
				await this.session.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await generation?.drain();
			} catch (error) {
				failures.push(error);
			}
			try {
				await generation?.recovery;
			} catch (error) {
				failures.push(error);
			}
		} finally {
			this.lifecycle = "closed";
			this.emit();
			this.listeners.clear();
		}
		if (failures.length > 0) throw new CleanupAggregateError(`Agent ${this.id}`, failures);
	}

	private freshRun(taskName = ""): MutableRunData {
		const identity = this.session?.sessionIdentity;
		const run = initRunData({
			agent: this.options.agent,
			taskName,
			profile: this.options.resolvedRun.profile,
			model: this.options.resolvedRun.model,
			effectiveThinking: this.options.resolvedRun.effectiveThinking,
			...(identity === undefined ? {} : { sessionId: identity.sessionId, sessionFile: identity.sessionFile }),
			resultId: randomBytes(32).toString("hex"),
		});
		run.contextWindow = this.options.resolvedRun.contextWindow;
		return run;
	}

	private snapshot(status: RunStatus = lifecycleStatus({ phase: this.phase })): ReadonlyRunDetails {
		const generation = this.currentGeneration;
		if (generation) return generation.snapshot(status);
		return snapshotRunData(this.initialRun, {
			agentId: this.id,
			generation: 0,
			status,
		});
	}

	private requireGeneration(): AgentGeneration {
		if (!this.currentGeneration) throw new Error(`Agent ${this.id} has not started.`);
		return this.currentGeneration;
	}

	private assertOpen(): void {
		if (this.isClosing() || !this.session.isOpen) {
			throw new Error(`Agent ${this.id} was closed during startup.`);
		}
	}

	private isClosing(): boolean {
		return this.lifecycle === "closing" || this.lifecycle === "closed";
	}

	private assertAvailableForFollowUp(): void {
		if (!this.session.isOpen) {
			throw new Error(`Agent ${this.id} process is dead; close it and spawn a replacement before following up.`);
		}
		if (this.isClosing()) throw new Error(`Agent ${this.id} is closed.`);
		const question = this.currentGeneration?.pendingQuestion;
		if (question) {
			throw new Error(
				`Agent ${this.id} is waiting for an answer to question '${question.question_id}'; use answer_agent.`,
			);
		}
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

export function buildInitialTask(message: string, handoff: string | undefined): string {
	return handoff?.trim()
		? `Task: ${message}\n\nParent context (may be incomplete; use it to understand the assignment and verify factual claims when material):\n${handoff}`
		: `Task: ${message}`;
}
