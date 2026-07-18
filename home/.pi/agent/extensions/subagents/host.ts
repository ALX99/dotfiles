import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { ProfilesConfig, ResolvedRun } from "./profiles.ts";
import {
	CHILD_CONTEXT_ENV,
	getPiInvocation,
	ingestLine,
	initDetails,
	serializeChildExecutionContext,
	writeTempPrompt,
	type ChildExecutionContext,
	type RunDetails,
} from "./process.ts";
import { RpcTransport, type RpcEvent, type SpawnRpcProcess } from "./rpc.ts";

export type AgentStatus = "starting" | "running" | "idle" | "failed" | "aborted" | "closed";

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

export interface AgentSummary {
	agent_id: string;
	agent: string;
	task_name: string;
	profile: string;
	model: string;
	effective_thinking: string;
	session_file?: string;
	depth: number;
	generation: number;
	status: AgentStatus;
	final_text?: string;
	error?: string;
}

interface Deferred {
	generation: number;
	promise: Promise<RunDetails>;
	resolve: (details: RunDetails) => void;
	reject: (error: Error) => void;
	settled: boolean;
}

export interface ManagedAgentOptions {
	id?: string;
	defaultCwd: string;
	cwd?: string;
	agent: AgentConfig;
	resolvedRun: ResolvedRun;
	childContext: ChildExecutionContext;
	subagentToolsEnabled: boolean;
	spawnProcess?: SpawnRpcProcess;
	onUpdate?: (details: RunDetails) => void;
	onBackgroundComplete?: (summary: AgentSummary) => void;
}

export class ManagedAgent {
	readonly id: string;
	readonly depth: number;
	private transport?: RpcTransport;
	private promptDir?: string;
	private deferred?: Deferred;
	private generation = 0;
	private status: AgentStatus = "starting";
	private taskName = "";
	private details: RunDetails;
	private error?: string;
	private closing = false;
	private readonly notifiedGenerations = new Set<number>();
	private readonly listeners = new Set<() => void>();
	private onUpdate?: (details: RunDetails) => void;
	private readonly options: ManagedAgentOptions;

	constructor(options: ManagedAgentOptions) {
		this.options = options;
		this.id = options.id ?? `agent-${nextAgentId++}`;
		this.depth = options.childContext.depth;
		this.onUpdate = options.onUpdate;
		this.details = this.freshDetails("starting");
	}

	async start(message: string, handoff: string | undefined, taskName: string, background: boolean, signal?: AbortSignal): Promise<RunDetails> {
		if (this.transport) throw new Error("Subagent already started.");
		let promptPath: string | undefined;
		if (this.options.agent.systemPrompt) {
			const written = await writeTempPrompt(
				this.options.agent.name,
				buildAgentSystemPrompt(this.options.agent.systemPrompt, this.options.childContext),
			);
			this.promptDir = written.dir;
			promptPath = written.path;
		}
		const sessionDir = path.join(getAgentDir(), "subagent-sessions");
		await fs.promises.mkdir(sessionDir, { recursive: true });
		const args = [
			"--mode", "rpc",
			"--model", this.options.resolvedRun.model,
			"--thinking", this.options.resolvedRun.effectiveThinking,
			"--session-dir", sessionDir,
		];
		if (this.options.agent.tools?.length) args.push("--tools", this.options.agent.tools.join(","));
		else {
			const excluded = ["ask_question"];
			if (!this.options.subagentToolsEnabled) excluded.push(...SUBAGENT_TOOL_NAMES);
			args.push("--exclude-tools", excluded.join(","));
		}
		if (promptPath) args.push("--append-system-prompt", promptPath);
		const invocation = getPiInvocation(args);
		this.transport = new RpcTransport({
			command: invocation.command,
			args: invocation.args,
			cwd: this.options.cwd ?? this.options.defaultCwd,
			env: {
				...process.env,
				[CHILD_CONTEXT_ENV]: serializeChildExecutionContext(this.options.childContext),
			} as Record<string, string>,
			spawnProcess: this.options.spawnProcess,
			onEvent: (event) => this.onEvent(event),
			onExit: (error) => this.onExit(error),
		});
		let run: Deferred;
		try {
			await this.transport.start();
			const state = await this.transport.request({ type: "get_state" });
			if (!isRecord(state) || typeof state.sessionFile !== "string" || !state.sessionFile.trim()) {
				throw new Error(`Agent ${this.id} returned an invalid session state.`);
			}
			this.details.sessionFile = state.sessionFile;
			const task = handoff?.trim()
				? `Task: ${message}\n\nParent handoff (trusted context; verify if needed):\n${handoff.trim()}`
				: `Task: ${message}`;
			run = this.beginRun(taskName);
			await this.transport.request({ type: "prompt", message: task });
		} catch (error) {
			this.failRun(error);
			await this.close();
			throw error;
		}
		if (background) {
			this.notifyWhenComplete(run);
			return this.snapshot("launched");
		}
		return this.waitForGeneration(run.generation, signal);
	}

	async steer(message: string): Promise<void> {
		if (this.status !== "running" && this.status !== "starting") throw new Error(`Agent ${this.id} is not running.`);
		await this.rpc().request({ type: "steer", message });
	}

	async getMessages(): Promise<unknown[]> {
		const response = await this.rpc().request({ type: "get_messages" });
		if (!isRecord(response) || !Array.isArray(response.messages)) {
			throw new Error(`Agent ${this.id} returned an invalid transcript response.`);
		}
		return response.messages;
	}

	async followUp(message: string, taskName: string, background: boolean, signal?: AbortSignal): Promise<RunDetails> {
		this.assertOpen();
		if (this.status === "aborted" && this.deferred && !this.deferred.settled) {
			await this.deferred.promise.catch(() => {});
		}
		const wasRunning = this.status === "running" || this.status === "starting";
		const run = wasRunning && this.deferred && !this.deferred.settled
			? this.deferred
			: this.beginRun(taskName);
		if (wasRunning) {
			// Pi emits one agent_settled only after the full follow-up queue drains.
			this.taskName = taskName;
			this.syncStatus();
		}
		try {
			await this.rpc().request({ type: wasRunning ? "follow_up" : "prompt", message });
		} catch (error) {
			this.failRun(error);
			throw error;
		}
		if (background) {
			this.notifyWhenComplete(run);
			return this.snapshot("launched");
		}
		return this.waitForGeneration(run.generation, signal);
	}

	async wait(timeoutMs?: number, signal?: AbortSignal): Promise<RunDetails> {
		if (!this.deferred || this.deferred.settled) return this.details;
		return this.waitForGeneration(this.deferred.generation, signal, timeoutMs);
	}

	async interrupt(): Promise<void> {
		this.assertOpen();
		if (this.status !== "running" && this.status !== "starting") return;
		this.status = "aborted";
		this.syncStatus();
		this.emit();
		await this.rpc().request({ type: "abort" });
	}

	async close(): Promise<void> {
		if (this.status === "closed") return;
		this.closing = true;
		this.status = "closed";
		this.syncStatus();
		this.emit();
		this.rejectCurrent(new Error(`Agent ${this.id} was closed.`));
		await this.transport?.close();
		this.transport = undefined;
		if (this.promptDir) await fs.promises.rm(this.promptDir, { recursive: true, force: true });
		this.promptDir = undefined;
	}

	summary(): AgentSummary {
		return {
			agent_id: this.id,
			agent: this.options.resolvedRun.agent,
			task_name: this.taskName,
			profile: this.options.resolvedRun.profile,
			model: this.options.resolvedRun.model,
			effective_thinking: this.options.resolvedRun.effectiveThinking,
			...(this.details.sessionFile ? { session_file: this.details.sessionFile } : {}),
			depth: this.depth,
			generation: this.generation,
			status: this.status,
			...(this.details.finalText ? { final_text: this.details.finalText } : {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	getDetails(): RunDetails {
		return this.snapshot();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isAvailable(): boolean {
		return this.transport !== undefined && this.status !== "closed";
	}

	setOnUpdate(onUpdate: ((details: RunDetails) => void) | undefined): void {
		this.onUpdate = onUpdate;
	}

	private beginRun(taskName: string): Deferred {
		if (this.deferred && !this.deferred.settled) this.deferred.reject(new Error("Agent received a newer run before the previous run settled."));
		this.generation += 1;
		this.taskName = taskName;
		this.status = "starting";
		this.error = undefined;
		this.details = this.freshDetails("starting");
		let resolve!: (details: RunDetails) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<RunDetails>((res, rej) => { resolve = res; reject = rej; });
		void promise.catch(() => {}); // A command-acceptance failure can precede the caller's waiter.
		this.deferred = { generation: this.generation, promise, resolve, reject, settled: false };
		this.emit();
		return this.deferred;
	}

	private onEvent(event: RpcEvent): void {
		if (this.closing) return;
		ingestLine(JSON.stringify(event), this.details);
		if (event.type === "agent_start" && this.status !== "aborted") this.status = "running";
		if (event.type === "agent_settled") {
			if (this.status !== "aborted") {
				this.status = this.details.assistantError ? "failed" : "idle";
				this.error = this.details.assistantError;
			}
			this.details.endTime = Date.now();
			this.syncStatus();
			if (this.status === "failed") this.rejectCurrent(new Error(this.error ?? "Subagent failed."));
			else this.resolveCurrent();
		}
		this.syncStatus();
		this.emit();
	}

	private onExit(error: Error | undefined): void {
		if (this.closing) return;
		this.failRun(error ?? new Error("Subagent process exited."));
	}

	private failRun(cause: unknown): void {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		this.error = error.message;
		this.status = "failed";
		this.details.exitCode = 1;
		this.details.stderr = error.message;
		this.details.endTime = Date.now();
		this.syncStatus();
		this.rejectCurrent(error);
		this.emit();
	}

	private freshDetails(status: AgentStatus): RunDetails {
		const details = initDetails({
			agent: this.options.agent,
			taskName: this.taskName,
			profile: this.options.resolvedRun.profile,
			model: this.options.resolvedRun.model,
			effectiveThinking: this.options.resolvedRun.effectiveThinking,
			sessionFile: this.details?.sessionFile,
			parentDepth: this.options.childContext.depth - 1,
		});
		details.agentId = this.id;
		details.generation = this.generation;
		details.status = status;
		details.contextWindow = this.options.resolvedRun.contextWindow;
		return details;
	}

	private syncStatus(): void {
		this.details.agentId = this.id;
		this.details.generation = this.generation;
		this.details.status = this.status;
		this.details.taskName = this.taskName;
	}

	private emit(): void {
		this.onUpdate?.(this.snapshot());
		for (const listener of this.listeners) listener();
	}

	private snapshot(status: string = this.status): RunDetails {
		return {
			...this.details,
			status,
			recentTools: [...this.details.recentTools],
			nestedRuns: [...this.details.nestedRuns],
		};
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
				// Closing and interrupting are deliberate cancellation, not failures to report back.
				if (this.status !== "closed") this.options.onBackgroundComplete?.({ ...this.summary(), status: "failed", error: error.message });
			},
		);
	}

	private resolveCurrent(): void {
		if (!this.deferred || this.deferred.settled) return;
		this.deferred.settled = true;
		this.deferred.resolve(this.details);
	}

	private rejectCurrent(error: Error): void {
		if (!this.deferred || this.deferred.settled) return;
		this.deferred.settled = true;
		this.deferred.reject(error);
	}

	private async waitForGeneration(generation: number, signal?: AbortSignal, timeoutMs?: number): Promise<RunDetails> {
		const deferred = this.deferred;
		if (!deferred || deferred.generation !== generation) return this.details;
		let timeout: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;
		const guards = new Promise<never>((_, reject) => {
			if (timeoutMs !== undefined) timeout = setTimeout(() => reject(new Error(`Timed out waiting for agent ${this.id}.`)), timeoutMs);
			if (signal) {
				abortHandler = () => {
					reject(new Error(`Waiting for agent ${this.id} was aborted.`));
				};
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
		if (!this.transport) throw new Error(`Agent ${this.id} is not available.`);
		return this.transport;
	}

	private assertOpen(): void {
		if (this.status === "closed") throw new Error(`Agent ${this.id} is closed.`);
		this.rpc();
	}
}

export interface AgentView {
	summary: AgentSummary;
	details: RunDetails;
}

export interface SpawnAdmissionRequest {
	agent: string;
	profile: string;
	delegationCredits?: number;
}

/**
 * Stateful launch-time admission for one process. Its counters deliberately
 * survive follow-up generations and never inspect usage or elapsed time.
 */
export class SpawnAdmissionController {
	private remainingCredits: number;
	private createdChildren = 0;
	private readonly config: ProfilesConfig;
	private readonly registry: AgentRegistry;
	private readonly treeId: string;
	private readonly executionContext?: ChildExecutionContext;

	constructor(
		config: ProfilesConfig,
		registry: AgentRegistry,
		treeId: string,
		executionContext?: ChildExecutionContext,
	) {
		this.config = config;
		this.registry = registry;
		this.treeId = treeId;
		this.executionContext = executionContext;
		this.remainingCredits = executionContext?.delegationCredits ?? 0;
	}

	canExposeSubagentTools(): boolean {
		return this.executionContext === undefined || executionCanDelegate(this.config, this.executionContext);
	}

	remainingDelegationCredits(): number {
		return this.remainingCredits;
	}

	admit(request: SpawnAdmissionRequest): ChildExecutionContext {
		const policy = this.config.agentPolicies[request.agent];
		const profile = this.config.profiles[request.profile];
		if (!policy) throw new Error(`No agent policy is configured for '${request.agent}'.`);
		if (!profile) throw new Error(`No profile policy is configured for '${request.profile}'.`);

		if (!this.executionContext) {
			const grant = request.delegationCredits ?? 0;
			assertGrant(grant, this.config.rootPolicy.maxDelegationGrant);
			if (grant > 0 && policy.delegation.mode !== "grant-required") {
				throw new Error(`Agent '${request.agent}' is a leaf and cannot receive delegation credits. Omit delegation_credits.`);
			}
			if (grant > 0 && !profile.delegationEnabled) {
				throw new Error(`Profile '${request.profile}' disables delegation and cannot receive delegation credits. Omit delegation_credits or choose a delegation-enabled profile.`);
			}

			const nonClosed = this.registry.list().filter((agent) => agent.status !== "closed");
			if (nonClosed.length >= this.config.rootPolicy.maxDirectAgents) {
				throw new Error(
					`Direct-agent cap (${this.config.rootPolicy.maxDirectAgents}) reached. Use followup_agent with an existing agent, close an agent that is no longer needed, or perform the remaining work in the current session.`,
				);
			}
			if (profile.countsTowardDeepAgentCap) {
				const existingDeep = nonClosed.filter((agent) => this.config.profiles[agent.profile]?.countsTowardDeepAgentCap);
				if (existingDeep.length >= this.config.rootPolicy.maxDeepAgents) {
					throw new Error(`Deep-agent cap (${this.config.rootPolicy.maxDeepAgents}) reached. Use followup_agent with the existing deep agent (${existingDeep.map((agent) => agent.agent_id).join(", ")}) instead of creating another one.`);
				}
			}
			return Object.freeze({
				treeId: this.treeId,
				depth: 1,
				agent: request.agent,
				profile: request.profile,
				delegationCredits: grant,
			});
		}

		if (request.delegationCredits !== undefined) {
			throw new Error("Nested agents cannot transfer or re-grant delegation credits; remove delegation_credits.");
		}
		const parent = this.executionContext;
		if (!executionCanDelegate(this.config, parent)) {
			throw new Error("This execution is a leaf and cannot spawn subagents. Perform the work in the current process.");
		}
		const parentPolicy = this.config.agentPolicies[parent.agent]!.delegation;
		if (parentPolicy.mode !== "grant-required") {
			throw new Error("This execution's agent policy does not permit nested delegation.");
		}
		if (!parentPolicy.allowedChildAgents.includes(request.agent)) {
			throw new Error(`Nested delegation may spawn only: ${parentPolicy.allowedChildAgents.join(", ")}.`);
		}
		if (!parentPolicy.allowedChildProfiles.includes(request.profile)) {
			throw new Error(`Nested delegation may use only profiles: ${parentPolicy.allowedChildProfiles.join(", ")}.`);
		}
		if (this.createdChildren >= parentPolicy.maxDirectChildren) {
			throw new Error(`Nested direct-agent cap (${parentPolicy.maxDirectChildren}) reached. Reuse an existing scout with followup_agent or perform the remaining reconnaissance here.`);
		}
		if (this.remainingCredits <= 0) {
			throw new Error("No delegation credits remain. Reuse an existing scout with followup_agent or perform the remaining reconnaissance here.");
		}

		// Accepted nested launches spend their grant before ManagedAgent starts.
		this.remainingCredits -= 1;
		this.createdChildren += 1;
		return Object.freeze({
			treeId: parent.treeId,
			depth: parent.depth + 1,
			agent: request.agent,
			profile: request.profile,
			delegationCredits: 0,
		});
	}
}

export function executionCanDelegate(config: ProfilesConfig, context: ChildExecutionContext): boolean {
	if (context.depth >= 2 || context.delegationCredits <= 0) return false;
	const agentPolicy = config.agentPolicies[context.agent];
	const profile = config.profiles[context.profile];
	return agentPolicy?.delegation.mode === "grant-required" && profile?.delegationEnabled === true;
}

export function buildAgentSystemPrompt(basePrompt: string, context: ChildExecutionContext): string {
	const credits = context.delegationCredits;
	if (credits <= 0) return basePrompt;
	return `${basePrompt}\n\nThis execution was explicitly granted ${credits} delegation credit${credits === 1 ? "" : "s"}. Each accepted nested spawn permanently spends one credit; credits do not replenish when a child settles or closes.`;
}

export class AgentRegistry {
	private readonly agents = new Map<string, ManagedAgent>();
	private readonly agentUnsubscribers = new Map<string, () => void>();
	private readonly listeners = new Set<() => void>();

	add(agent: ManagedAgent): void {
		this.agentUnsubscribers.get(agent.id)?.();
		this.agents.set(agent.id, agent);
		this.agentUnsubscribers.set(agent.id, agent.subscribe(() => this.emit()));
		this.emit();
	}

	get(id: string): ManagedAgent {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Unknown agent_id '${id}'.`);
		return agent;
	}

	list(): AgentSummary[] {
		return [...this.agents.values()].map((agent) => agent.summary());
	}

	views(): AgentView[] {
		return [...this.agents.values()].map((agent) => ({ summary: agent.summary(), details: agent.getDetails() }));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(id: string): Promise<void> {
		const agent = this.get(id);
		await agent.close();
	}

	delete(id: string): void {
		this.agentUnsubscribers.get(id)?.();
		this.agentUnsubscribers.delete(id);
		this.agents.delete(id);
		this.emit();
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.agents.values()].map((agent) => agent.close()));
		for (const unsubscribe of this.agentUnsubscribers.values()) unsubscribe();
		this.agentUnsubscribers.clear();
		this.agents.clear();
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertGrant(grant: number, maximum: number): void {
	if (!Number.isInteger(grant) || grant < 0 || grant > maximum) {
		throw new Error(`delegation_credits must be an integer from 0 to ${maximum}.`);
	}
}
