import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import {
	CHILD_CONTEXT_ENV,
	composeRoleSystemPrompt,
	getPiInvocation,
	serializeChildExecutionContext,
	writeTempPrompt,
	type ChildExecutionContext,
} from "./child-process.ts";
import type { AgentEvent } from "./event-schema.ts";
import { SessionResultRecorder } from "./session-result-recorder.ts";
import type { ResolvedRun } from "./profiles.ts";
import type { ExtensionUiRequest } from "./protocol.ts";
import {
	RpcTransport,
	type ExtensionUiResponse,
	type RpcRequestOptions,
	type RpcTransportEvent,
	type RpcTransportState,
	type SpawnRpcProcess,
} from "./rpc-transport.ts";
import { parseChildSessionIdentity, type ChildSessionIdentity } from "./session-cursors.ts";
import type { CapturedGeneration } from "./result-store.ts";

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

export type ChildSessionEvent =
	| { readonly kind: "agent-event"; readonly event: AgentEvent }
	| { readonly kind: "ui-request"; readonly request: ExtensionUiRequest }
	| { readonly kind: "oversized-record" }
	| { readonly kind: "exit"; readonly error: Error | undefined };

export interface ChildSessionOptions {
	readonly agentId: string;
	readonly agentDir: string;
	readonly defaultCwd: string;
	readonly cwd?: string;
	readonly agent: AgentConfig;
	readonly resolvedRun: ResolvedRun;
	readonly childContext: ChildExecutionContext;
	readonly spawnProcess?: SpawnRpcProcess;
	readonly validateSessionIdentity?: (
		identity: ChildSessionIdentity,
		agentDir: string,
	) => Promise<ChildSessionIdentity>;
	readonly onEvent: (event: ChildSessionEvent) => boolean | void;
}

/**
 * Owns one retained child process and its native Pi session.
 *
 * This class intentionally knows nothing about prompts as generations,
 * background completion, or UI policy. It only turns process records into a
 * single ordered event channel and exposes the session operations a generation
 * needs.
 */
export class ChildSession {
	private transport: RpcTransport | undefined;
	private promptDir: string | undefined;
	private closePromise: Promise<void> | undefined;
	private openPromise: Promise<ChildSessionIdentity> | undefined;
	private closing = false;
	private identity: ChildSessionIdentity | undefined;
	private readonly capture: SessionResultRecorder;
	private readonly options: ChildSessionOptions;

	constructor(options: ChildSessionOptions) {
		this.options = options;
		this.capture = new SessionResultRecorder({
			agentId: options.agentId,
			agentDir: options.agentDir,
			...(options.validateSessionIdentity === undefined
				? {}
				: { validateSessionIdentity: options.validateSessionIdentity }),
		});
	}

	get state(): RpcTransportState | "created" {
		return this.transport?.getState() ?? "created";
	}

	get sessionIdentity(): ChildSessionIdentity | undefined {
		return this.identity;
	}

	get isOpen(): boolean {
		return !this.closing && this.transport?.getState() === "open";
	}

	open(): Promise<ChildSessionIdentity> {
		if (this.openPromise) return this.openPromise;
		this.openPromise = this.openInternal();
		return this.openPromise;
	}

	async prepareGeneration(): Promise<void> {
		await this.capture.prepareGeneration(this.rpc());
	}

	async captureSettlement(generation: number, resultId: string): Promise<CapturedGeneration> {
		return this.capture.captureSettlement(this.rpc(), generation, resultId);
	}

	async captureFailedGeneration(generation: number, resultId: string): Promise<CapturedGeneration | undefined> {
		return this.capture.captureFailedGeneration(this, generation, resultId);
	}

	request(command: Readonly<Record<string, unknown>>, options?: RpcRequestOptions): Promise<unknown> {
		return this.rpc().request(command, options);
	}

	async sendPrompt(content: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_DIRECT_RPC_PROMPT_BYTES) {
			throw new Error(
				`Subagent RPC prompt is ${bytes} UTF-8 bytes; the direct prompt limit is ${MAX_DIRECT_RPC_PROMPT_BYTES}.`,
			);
		}
		await this.rpc().request({
			type: "prompt",
			message: content,
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		});
	}

	respondToUi(requestId: string, response: ExtensionUiResponse): Promise<void> {
		return this.rpc().respondToUi(requestId, response);
	}

	abort(): Promise<unknown> {
		return this.rpc().request({ type: "abort" });
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async openInternal(): Promise<ChildSessionIdentity> {
		if (this.closing) throw new Error(`Agent ${this.options.agentId} was closed during startup.`);
		let promptPath: string | undefined;
		if (this.options.agent.systemPrompt) {
			const prompt = composeRoleSystemPrompt(
				this.options.agent.systemPrompt,
				this.options.cwd ?? this.options.defaultCwd,
				this.options.agentDir,
			);
			const written = await writeTempPrompt(this.options.agent.name, prompt);
			if (this.closing) {
				await fs.promises.rm(written.dir, { recursive: true, force: true });
				throw new Error(`Agent ${this.options.agentId} was closed during startup.`);
			}
			this.promptDir = written.dir;
			promptPath = written.path;
		}

		const sessionDir = path.join(this.options.agentDir, "subagent-sessions");
		// Session JSONL files intentionally outlive this process.
		await fs.promises.mkdir(sessionDir, { recursive: true });
		if (this.closing) throw new Error(`Agent ${this.options.agentId} was closed during startup.`);

		const args = childRpcArguments(this.options.agent, this.options.resolvedRun, sessionDir, promptPath);
		const invocation = getPiInvocation(args);
		const transport = new RpcTransport({
			command: invocation.command,
			args: invocation.args,
			cwd: this.options.cwd ?? this.options.defaultCwd,
			env: childEnvironment({ ...this.options.childContext, agentId: this.options.agentId }),
			...(this.options.spawnProcess === undefined ? {} : { spawnProcess: this.options.spawnProcess }),
			onRecord: (event) => this.handleTransportEvent(event),
		});
		this.transport = transport;
		await transport.start();
		if (this.closing || this.transport !== transport || transport.getState() !== "open") {
			await transport.close();
			throw new Error(`Agent ${this.options.agentId} was closed during startup.`);
		}
		const state = await transport.request({ type: "get_state" });
		const identity = await this.capture.setIdentity(parseChildSessionIdentity(state));
		this.assertOpen(transport);
		this.identity = identity;
		return identity;
	}

	private async closeInternal(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		try {
			await transport?.close();
		} finally {
			await this.openPromise?.catch(() => {});
			if (this.promptDir) await fs.promises.rm(this.promptDir, { recursive: true, force: true });
			this.promptDir = undefined;
		}
	}

	private handleTransportEvent(event: RpcTransportEvent): boolean | void {
		switch (event.kind) {
			case "agent-event":
				this.options.onEvent(event);
				return;
			case "ui-request":
				return this.options.onEvent(event) === true;
			case "oversized-record":
			case "exit":
				this.options.onEvent(event);
				return;
			case "event":
				// Unknown protocol events are intentionally harmless. They remain
				// observable to direct RpcTransport consumers without becoming
				// subagent lifecycle state.
				return;
		}
	}

	private rpc(): RpcTransport {
		if (!this.transport || this.transport.getState() !== "open") {
			throw new Error(`Agent ${this.options.agentId} is not available.`);
		}
		return this.transport;
	}

	private assertOpen(transport: RpcTransport): void {
		if (this.closing || this.transport !== transport || transport.getState() !== "open") {
			throw new Error(`Agent ${this.options.agentId} was closed during startup.`);
		}
	}
}

function childRpcArguments(
	agent: AgentConfig,
	resolvedRun: ResolvedRun,
	sessionDir: string,
	promptPath: string | undefined,
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
	const tools = new Set(agent.tools);
	if (tools.size > 0) args.push("--tools", [...tools].join(","));
	else args.push("--no-tools");
	if (promptPath) args.push("--append-system-prompt", promptPath);
	return args;
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
