import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { toError } from "../_shared/errors.ts";
import { isRecord } from "../_shared/json.ts";
import type { AgentConfig } from "./agents.ts";
import {
	CleanupAggregateError,
	lifecycleStatus,
	transitionLifecycle,
	type AgentLifecycle,
	type AgentSummary,
} from "./agent-types.ts";
import type { AgentEvent } from "./event-schema.ts";
import { OutputSpool } from "./output-spool.ts";
import type { ResolvedRun } from "./profiles.ts";
import {
	CHILD_CONTEXT_ENV,
	getPiInvocation,
	serializeChildExecutionContext,
	writeTempPrompt,
	type ChildExecutionContext,
} from "./process.ts";
import {
	foldAgentEvent,
	initRunState,
	snapshotRunState,
	type MutableRunState,
	type ReadonlyRunDetails,
	type RunStatus,
} from "./run-state.ts";
import { RpcTransport, type SpawnRpcProcess } from "./rpc.ts";

let nextAgentId = 1;
const SUBAGENT_TOOL_NAMES = [
	"spawn_agent",
	"send_agent",
	"followup_agent",
	"wait_agent",
	"list_agents",
	"interrupt_agent",
	"close_agent",
] as const;

interface Deferred {
	readonly generation: number;
	readonly promise: Promise<ReadonlyRunDetails>;
	readonly resolve: (details: ReadonlyRunDetails) => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
}

export interface ManagedAgentOptions {
	readonly id?: string;
	readonly defaultCwd: string;
	readonly cwd?: string;
	readonly agent: AgentConfig;
	readonly resolvedRun: ResolvedRun;
	readonly childContext: ChildExecutionContext;
	readonly subagentToolsEnabled: boolean;
	readonly spawnProcess?: SpawnRpcProcess;
	readonly onUpdate?: (details: ReadonlyRunDetails) => void;
	readonly onBackgroundComplete?: (summary: AgentSummary) => void;
}

export class ManagedAgent {
	readonly id: string;
	readonly depth: number;
	private transport: RpcTransport | undefined;
	private promptDir: string | undefined;
	private output = new OutputSpool();
	private deferred: Deferred | undefined;
	private lifecycle: AgentLifecycle = { phase: "created", generation: 0 };
	private taskName = "";
	private details: MutableRunState;
	private readonly notifiedGenerations = new Set<number>();
	private readonly listeners = new Set<() => void>();
	private onUpdate: ((details: ReadonlyRunDetails) => void) | undefined;
	private eventTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | undefined;
	private readonly options: ManagedAgentOptions;

	constructor(options: ManagedAgentOptions) {
		this.options = options;
		this.id = options.id ?? `agent-${nextAgentId++}`;
		this.depth = options.childContext.depth;
		this.onUpdate = options.onUpdate;
		this.details = this.freshDetails();
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
		const run = await this.beginRun(taskName);
		let promptPath: string | undefined;
		try {
			if (this.options.agent.systemPrompt) {
				const written = await writeTempPrompt(
					this.options.agent.name,
					buildAgentSystemPrompt(this.options.agent.systemPrompt, this.options.childContext),
				);
				if (this.isClosing()) {
					await fs.promises.rm(written.dir, { recursive: true, force: true });
					throw new Error(`Agent ${this.id} was closed during startup.`);
				}
				this.promptDir = written.dir;
				promptPath = written.path;
			}
			const sessionDir = path.join(getAgentDir(), "subagent-sessions");
			await fs.promises.mkdir(sessionDir, { recursive: true });
			const args = this.rpcArguments(sessionDir, promptPath);
			const invocation = getPiInvocation(args);
			const transport = new RpcTransport({
				command: invocation.command,
				args: invocation.args,
				cwd: this.options.cwd ?? this.options.defaultCwd,
				env: childEnvironment(this.options.childContext),
				...(this.options.spawnProcess === undefined ? {} : { spawnProcess: this.options.spawnProcess }),
				onEvent: () => {},
				onAgentEvent: (event) => this.queueEvent(event),
				onExit: (error) => this.onExit(error),
			});
			this.transport = transport;
			await transport.start();
			this.assertTransport(transport);
			const state = await transport.request({ type: "get_state" });
			if (!isRecord(state) || typeof state.sessionFile !== "string" || !state.sessionFile.trim()) {
				throw new Error(`Agent ${this.id} returned an invalid session state.`);
			}
			this.details.sessionFile = state.sessionFile;
			const task = handoff?.trim()
				? `Task: ${message}\n\nParent handoff (trusted context; verify if needed):\n${handoff.trim()}`
				: `Task: ${message}`;
			await transport.request({ type: "prompt", message: task });
		} catch (cause) {
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
		return this.waitForGeneration(run.generation, signal);
	}

	async steer(message: string): Promise<void> {
		if (this.lifecycle.phase !== "running" && this.lifecycle.phase !== "starting") {
			throw new Error(`Agent ${this.id} is not running.`);
		}
		await this.rpc().request({ type: "steer", message });
	}

	async getMessages(): Promise<unknown[]> {
		const response = await this.rpc().request({ type: "get_messages" });
		if (!isRecord(response) || !Array.isArray(response.messages)) {
			throw new Error(`Agent ${this.id} returned an invalid transcript response.`);
		}
		return response.messages;
	}

	async loadFullOutput(): Promise<string> {
		return this.output.loadFullOutput();
	}

	async followUp(
		message: string,
		taskName: string,
		background: boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyRunDetails> {
		this.assertAvailableForFollowUp();
		if (this.lifecycle.phase === "aborted" && this.deferred && !this.deferred.settled) {
			await this.deferred.promise.catch(() => {});
		}
		const wasRunning = this.lifecycle.phase === "running" || this.lifecycle.phase === "starting";
		const run = wasRunning && this.deferred && !this.deferred.settled ? this.deferred : await this.beginRun(taskName);
		if (wasRunning) {
			this.taskName = taskName;
			this.syncDetails();
		}
		try {
			await this.rpc().request({ type: wasRunning ? "follow_up" : "prompt", message });
		} catch (cause) {
			const error = toError(cause);
			this.failRun(error);
			throw error;
		}
		if (background) {
			this.notifyWhenComplete(run);
			return this.snapshot("launched");
		}
		return this.waitForGeneration(run.generation, signal);
	}

	async wait(timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		if (!this.deferred || this.deferred.settled) return this.snapshot();
		return this.waitForGeneration(this.deferred.generation, signal, timeoutMs);
	}

	async interrupt(): Promise<void> {
		if (this.lifecycle.phase !== "running" && this.lifecycle.phase !== "starting") return;
		this.setLifecycle({ phase: "aborted", generation: this.lifecycle.generation });
		this.details.aborted = true;
		this.emit();
		try {
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
		const error = this.lifecycle.phase === "failed" ? this.lifecycle.error.message : this.details.assistantError;
		return {
			agent_id: this.id,
			agent: this.options.resolvedRun.agent,
			task_name: this.taskName,
			profile: this.options.resolvedRun.profile,
			model: this.options.resolvedRun.model,
			effective_thinking: this.options.resolvedRun.effectiveThinking,
			...(this.details.sessionFile ? { session_file: this.details.sessionFile } : {}),
			depth: this.depth,
			generation: this.lifecycle.generation,
			status,
			...(this.details.finalText ? { final_text: this.details.finalText } : {}),
			...(error ? { error } : {}),
		};
	}

	getDetails(): ReadonlyRunDetails {
		return this.snapshot();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isAvailable(): boolean {
		return (
			this.transport?.getState() === "open" && this.lifecycle.phase !== "closing" && this.lifecycle.phase !== "closed"
		);
	}

	private async beginRun(taskName: string): Promise<Deferred> {
		if (this.deferred && !this.deferred.settled) {
			this.settleDeferred(this.deferred, {
				kind: "reject",
				error: new Error("Agent received a newer run before the previous run settled."),
			});
		}
		const previousOutput = this.output;
		this.output = new OutputSpool();
		await previousOutput.close();
		const generation = this.lifecycle.generation + 1;
		this.taskName = taskName;
		this.setLifecycle({ phase: "starting", generation });
		this.details = this.freshDetails();
		const { promise, resolve, reject } = Promise.withResolvers<ReadonlyRunDetails>();
		void promise.catch(() => {});
		const deferred = { generation, promise, resolve, reject, settled: false };
		this.deferred = deferred;
		this.emit();
		return deferred;
	}

	private queueEvent(event: AgentEvent): void {
		const generation = this.lifecycle.generation;
		this.eventTail = this.eventTail
			.then(() => this.processEvent(event, generation))
			.catch((cause) => this.failRun(cause));
	}

	private async processEvent(event: AgentEvent, generation: number): Promise<void> {
		if (
			generation !== this.lifecycle.generation ||
			this.lifecycle.phase === "closing" ||
			this.lifecycle.phase === "closed"
		) {
			return;
		}
		await foldAgentEvent(event, this.details, this.output);
		if (generation !== this.lifecycle.generation) return;
		if (event.type === "agent_start" && this.lifecycle.phase === "starting") {
			this.setLifecycle({ phase: "running", generation });
		}
		if (event.type === "agent_settled") {
			if (this.deferred?.settled) return;
			this.details.endTime = Date.now();
			if (this.lifecycle.phase === "aborted") {
				this.settleCurrent({ kind: "resolve" });
			} else if (this.details.assistantError) {
				const error = new Error(this.details.assistantError);
				this.setLifecycle({ phase: "failed", generation, error });
				this.settleCurrent({ kind: "reject", error });
			} else {
				this.setLifecycle({ phase: "idle", generation });
				this.settleCurrent({ kind: "resolve" });
			}
		}
		this.syncDetails();
		this.emit();
	}

	private onExit(error: Error | undefined): void {
		if (this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") return;
		this.failRun(error ?? new Error("Subagent process exited."));
	}

	private failRun(cause: unknown): void {
		if (this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") return;
		const error = toError(cause);
		if (this.lifecycle.phase !== "failed") {
			this.setLifecycle({ phase: "failed", generation: this.lifecycle.generation, error });
		}
		this.details.exitCode = 1;
		this.details.stderr = error.message;
		this.details.endTime = Date.now();
		this.settleCurrent({ kind: "reject", error });
		this.syncDetails();
		this.emit();
	}

	private async closeInternal(): Promise<void> {
		if (this.lifecycle.phase === "closed") return;
		if (this.lifecycle.phase !== "closing") {
			this.setLifecycle({ phase: "closing", generation: this.lifecycle.generation });
			this.syncDetails();
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
				await this.output.close();
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
				this.setLifecycle({ phase: "closed", generation: this.lifecycle.generation });
				this.syncDetails();
				this.emit();
				this.listeners.clear();
			}
		}
		if (failures.length > 0) throw new CleanupAggregateError(`Agent ${this.id}`, failures);
	}

	private freshDetails(): MutableRunState {
		const details = initRunState({
			agent: this.options.agent,
			taskName: this.taskName,
			profile: this.options.resolvedRun.profile,
			model: this.options.resolvedRun.model,
			effectiveThinking: this.options.resolvedRun.effectiveThinking,
			...(this.details?.sessionFile === undefined ? {} : { sessionFile: this.details.sessionFile }),
			parentDepth: this.options.childContext.depth - 1,
		});
		details.agentId = this.id;
		details.generation = this.lifecycle.generation;
		details.status = lifecycleStatus(this.lifecycle);
		details.contextWindow = this.options.resolvedRun.contextWindow;
		return details;
	}

	private setLifecycle(next: AgentLifecycle): void {
		this.lifecycle = transitionLifecycle(this.lifecycle, next);
		this.syncDetails();
	}

	private syncDetails(): void {
		this.details.agentId = this.id;
		this.details.generation = this.lifecycle.generation;
		this.details.status = lifecycleStatus(this.lifecycle);
		this.details.taskName = this.taskName;
	}

	private emit(): void {
		const snapshot = this.snapshot();
		this.onUpdate?.(snapshot);
		for (const listener of this.listeners) listener();
	}

	private snapshot(status: RunStatus = lifecycleStatus(this.lifecycle)): ReadonlyRunDetails {
		return snapshotRunState(this.details, status);
	}

	private notifyWhenComplete(run: Deferred): void {
		if (this.notifiedGenerations.has(run.generation)) return;
		this.notifiedGenerations.add(run.generation);
		void run.promise.then(
			() => {
				const summary = this.summary();
				if (summary.status === "idle") this.options.onBackgroundComplete?.(summary);
			},
			(error: Error) => {
				if (
					this.lifecycle.phase !== "closed" &&
					this.lifecycle.phase !== "closing" &&
					this.lifecycle.phase !== "aborted"
				) {
					this.options.onBackgroundComplete?.({ ...this.summary(), status: "failed", error: error.message });
				}
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
		let timeout: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;
		const guards = new Promise<never>((_, reject) => {
			if (timeoutMs !== undefined) {
				timeout = setTimeout(() => reject(new Error(`Timed out waiting for agent ${this.id}.`)), timeoutMs);
			}
			if (signal) {
				abortHandler = () => reject(new Error(`Waiting for agent ${this.id} was aborted.`));
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});
		try {
			return await Promise.race([deferred.promise, guards]);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		}
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
		this.rpc();
	}

	private rpcArguments(sessionDir: string, promptPath: string | undefined): string[] {
		const args = [
			"--mode",
			"rpc",
			"--model",
			this.options.resolvedRun.model,
			"--thinking",
			this.options.resolvedRun.effectiveThinking,
			"--session-dir",
			sessionDir,
		];
		if (this.options.agent.tools?.length) args.push("--tools", this.options.agent.tools.join(","));
		else {
			const excluded = ["ask_question"];
			if (!this.options.subagentToolsEnabled) excluded.push(...SUBAGENT_TOOL_NAMES);
			args.push("--exclude-tools", excluded.join(","));
		}
		if (promptPath) args.push("--append-system-prompt", promptPath);
		return args;
	}
}

export function buildAgentSystemPrompt(basePrompt: string, context: ChildExecutionContext): string {
	const credits = context.delegationCredits;
	if (credits <= 0) return basePrompt;
	return `${basePrompt}\n\nThis execution was explicitly granted ${credits} delegation credit${credits === 1 ? "" : "s"}. Each accepted nested spawn permanently spends one credit; credits do not replenish when a child settles or closes.`;
}

export function childEnvironment(
	context: ChildExecutionContext,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) if (value !== undefined) environment[name] = value;
	environment[CHILD_CONTEXT_ENV] = serializeChildExecutionContext(context);
	return environment;
}
