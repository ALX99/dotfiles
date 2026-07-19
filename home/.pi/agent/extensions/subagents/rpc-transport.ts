import { truncateTail } from "@earendil-works/pi-coding-agent";
import { execa } from "execa";
import { composeAbortSignal, onAbort } from "../_shared/abort.ts";
import { parseJson } from "../_shared/json.ts";
import { ByteBoundedJsonlFramer } from "../_shared/jsonl.ts";
import type { AgentEvent } from "./event-schema.ts";
import { parseRpcRecord, type RpcEvent } from "./protocol.ts";

export const DEFAULT_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_RPC_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_RPC_MAX_STDERR_LINES = 200;
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_CLOSE_GRACE_MS = 1_000;
export const DEFAULT_RPC_MAX_QUEUED_WRITE_BYTES = 1024 * 1024;

interface SpawnRpcProcessOptions {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly cancelSignal: AbortSignal;
	readonly forceKillAfterDelay: number;
}

export function spawnRpcProcess(command: string, args: readonly string[], options: SpawnRpcProcessOptions) {
	return execa(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		buffer: false,
		cancelSignal: options.cancelSignal,
		cleanup: true,
		killDescendants: true,
		forceKillAfterDelay: options.forceKillAfterDelay,
		reject: false,
	});
}

export type SpawnRpcProcess = typeof spawnRpcProcess;
type RpcSubprocess = ReturnType<SpawnRpcProcess>;
export type RpcTransportState = "created" | "starting" | "open" | "closing" | "closed" | "failed";

export interface RpcWritable {
	write(frame: Buffer, callback: (error?: Error | null) => void): boolean;
	once(event: "drain", listener: () => void): unknown;
	off(event: "drain", listener: () => void): unknown;
}

export type WriteRpcFrame = (stdin: RpcWritable, frame: Buffer) => Promise<void>;

/** Wait for both stream acceptance and the write callback, in either order. */
export const writeRpcFrame: WriteRpcFrame = async (stdin, frame) => {
	await new Promise<void>((resolve, reject) => {
		let drained = true;
		let callbackDone = false;
		let settled = false;
		const finish = (): void => {
			if (!settled && drained && callbackDone) {
				settled = true;
				stdin.off("drain", onDrain);
				resolve();
			}
		};
		const onDrain = (): void => {
			drained = true;
			finish();
		};
		const writable = stdin.write(frame, (error) => {
			if (error) {
				if (!settled) {
					settled = true;
					stdin.off("drain", onDrain);
					reject(error);
				}
				return;
			}
			callbackDone = true;
			finish();
		});
		if (!writable) {
			drained = false;
			stdin.once("drain", onDrain);
		}
	});
};

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly abortSubscription: Disposable;
}

export interface RpcRequestOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface RpcTransportOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly spawnProcess?: SpawnRpcProcess;
	readonly onEvent: (event: RpcEvent) => void;
	readonly onAgentEvent?: (event: AgentEvent) => void;
	readonly onExit: (error: Error | undefined) => void;
	readonly maxFrameBytes?: number;
	readonly maxStderrBytes?: number;
	readonly maxStderrLines?: number;
	readonly requestTimeoutMs?: number;
	readonly closeGraceMs?: number;
	readonly maxQueuedWriteBytes?: number;
	readonly writeFrame?: WriteRpcFrame;
}

/** Bounded JSONL client for one child process. This class owns the child,
 * stream listeners, request cancellation, abort listeners, and write queue. */
export class RpcTransport {
	private process: RpcSubprocess | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly lifetime = new AbortController();
	private nextId = 1;
	private stderr = "";
	private state: RpcTransportState = "created";
	private failure: Error | undefined;
	private closePromise: Promise<void> | undefined;
	private processResult: Promise<Awaited<RpcSubprocess>> | undefined;
	private exitReported = false;
	private writeTail: Promise<void> = Promise.resolve();
	private queuedWriteBytes = 0;
	private readonly options: RpcTransportOptions;

	constructor(options: RpcTransportOptions) {
		this.options = options;
	}

	getState(): RpcTransportState {
		return this.state;
	}

	pendingRequestCount(): number {
		return this.pending.size;
	}

	async start(): Promise<void> {
		if (this.state !== "created") throw new Error(`RPC transport cannot start from '${this.state}'.`);
		this.state = "starting";
		const spawnProcess = this.options.spawnProcess ?? spawnRpcProcess;
		let child: RpcSubprocess;
		try {
			child = spawnProcess(this.options.command, [...this.options.args], {
				cwd: this.options.cwd,
				env: this.options.env,
				cancelSignal: this.lifetime.signal,
				forceKillAfterDelay: this.options.closeGraceMs ?? DEFAULT_RPC_CLOSE_GRACE_MS,
			});
		} catch (cause) {
			const error = new Error("Could not start subagent RPC process.", { cause });
			this.fail(error);
			throw error;
		}
		this.process = child;
		this.attachJsonl(child);
		this.attachStderr(child);
		child.stdin.on("error", (cause) => {
			this.fail(new Error(`Subagent RPC stdin failed: ${cause.message}`, { cause }));
		});
		this.processResult = this.monitorProcess(child);

		try {
			await new Promise<void>((resolve, reject) => {
				child.nodeChildProcess.once("spawn", resolve);
				child.nodeChildProcess.once("error", reject);
			});
		} catch (cause) {
			const error = this.failure ?? new Error("Could not start subagent RPC process.", { cause });
			this.fail(error);
			throw error;
		}
		if (this.state !== "starting") throw this.failure ?? new Error("RPC transport closed during startup.");
		this.state = "open";
	}

	request(command: Readonly<Record<string, unknown>>, options: RpcRequestOptions = {}): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.state !== "open" || !this.process?.stdin.writable) {
			return Promise.reject(new Error("Subagent RPC process is not available."));
		}
		if (options.signal?.aborted) {
			return Promise.reject(abortError("RPC request was aborted.", options.signal.reason));
		}

		const id = `subagent-${this.nextId++}`;
		let frame: Buffer;
		try {
			frame = Buffer.from(`${JSON.stringify({ ...command, id })}\n`, "utf8");
		} catch (cause) {
			return Promise.reject(new Error("Could not serialize subagent RPC request.", { cause }));
		}
		return new Promise<unknown>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
			const guard = composeAbortSignal(options.signal, timeoutMs)!;
			const abortSubscription = onAbort(guard.signal, () => {
				const error = guard.timedOut()
					? new Error(`RPC request '${id}' timed out after ${timeoutMs}ms.`)
					: abortError(`RPC request '${id}' was aborted.`, guard.signal.reason);
				this.rejectRequest(id, error);
			});
			this.pending.set(id, {
				resolve,
				reject,
				abortSubscription,
			});
			this.enqueueWrite(frame, id);
		});
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		if (this.state === "closed") return;
		this.state = "closing";
		this.rejectPending(new Error("Subagent RPC transport closed."));
		this.lifetime.abort();
		await this.processResult;
		await this.writeTail.catch(() => {});
		this.process = undefined;
		this.state = "closed";
	}

	private attachJsonl(child: RpcSubprocess): void {
		const framer = new ByteBoundedJsonlFramer(this.maxFrameBytes());
		child.stdout.on("data", (raw: Buffer | string) => {
			if (this.state === "failed" || this.state === "closed") return;
			try {
				for (const line of framer.push(raw)) {
					this.handleLine(line);
					if (this.isFailed()) return;
				}
			} catch {
				this.fail(new Error(`Subagent RPC frame exceeds the ${this.maxFrameBytes()} byte limit.`));
			}
		});
		child.stdout.on("end", () => {
			if (this.state === "failed" || this.state === "closed") return;
			for (const line of framer.end()) this.handleLine(line);
		});
	}

	private attachStderr(child: RpcSubprocess): void {
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = truncateTail(this.stderr + chunk, {
				maxBytes: this.options.maxStderrBytes ?? DEFAULT_RPC_MAX_STDERR_BYTES,
				maxLines: this.options.maxStderrLines ?? DEFAULT_RPC_MAX_STDERR_LINES,
			}).content;
		});
	}

	private handleLine(line: string): void {
		if (!line) return;
		const json = parseJson(line, "subagent RPC");
		if (!json.ok) {
			this.fail(new Error(json.diagnostic.message, { cause: json.diagnostic.cause }));
			return;
		}
		const parsed = parseRpcRecord(json.value);
		switch (parsed.kind) {
			case "error":
				this.fail(parsed.error);
				return;
			case "response": {
				const pending = this.takePending(parsed.response.id);
				if (!pending) return;
				if (parsed.response.success) pending.resolve(parsed.response.data);
				else pending.reject(new Error(parsed.response.error));
				return;
			}
			case "ui-request":
				if (isBlockingUiMethod(parsed.request.method)) {
					this.enqueueWrite(
						Buffer.from(
							`${JSON.stringify({
								type: "extension_ui_response",
								id: parsed.request.id,
								cancelled: true,
							})}\n`,
						),
					);
				}
				return;
			case "event":
				this.options.onEvent(parsed.event);
				return;
			case "agent-event":
				if (this.options.onAgentEvent) this.options.onAgentEvent(parsed.event);
				else this.options.onEvent(parsed.event);
				return;
		}
	}

	private enqueueWrite(frame: Buffer, requestId?: string): void {
		const boundError =
			frame.byteLength > this.maxFrameBytes()
				? new Error(`RPC write exceeds the ${this.maxFrameBytes()} byte frame limit.`)
				: this.queuedWriteBytes + frame.byteLength > this.maxQueuedWriteBytes()
					? new Error(`RPC write queue exceeds the ${this.maxQueuedWriteBytes()} byte backpressure limit.`)
					: undefined;
		if (boundError) {
			if (requestId === undefined) this.fail(boundError);
			else this.rejectRequest(requestId, boundError);
			return;
		}
		this.queuedWriteBytes += frame.byteLength;
		const operation = this.writeTail.then(async () => {
			if (requestId !== undefined && !this.pending.has(requestId)) return;
			await this.writeFrame(frame);
		});
		this.writeTail = operation
			.catch((cause) => {
				const error = new Error("Subagent RPC write failed.", { cause });
				if (requestId !== undefined) this.rejectRequest(requestId, error);
				this.fail(error);
			})
			.finally(() => {
				this.queuedWriteBytes -= frame.byteLength;
			});
	}

	private async writeFrame(frame: Buffer): Promise<void> {
		const child = this.process;
		if (this.state !== "open" || !child?.stdin.writable) {
			throw new Error("Subagent RPC process is not available.");
		}
		await (this.options.writeFrame ?? writeRpcFrame)(child.stdin, frame);
	}

	private async monitorProcess(child: RpcSubprocess): Promise<Awaited<RpcSubprocess>> {
		const result = await child;
		if (this.state === "closing" || this.state === "closed") {
			this.reportExit(undefined);
			return result;
		}
		if (this.state === "failed") {
			this.reportExit(this.failure);
			return result;
		}
		const suffix = this.stderr.trim() ? ` ${this.stderr.trim()}` : "";
		const error = new Error(
			`Subagent RPC process exited (${result.signal ?? `code ${result.exitCode ?? 1}`}).${suffix}`,
			{ cause: result.cause },
		);
		this.failure = error;
		this.state = "failed";
		this.rejectPending(error);
		this.reportExit(error);
		return result;
	}

	private fail(error: Error): void {
		if (this.state === "failed" || this.state === "closed" || this.state === "closing") return;
		this.failure = error;
		this.state = "failed";
		this.rejectPending(error);
		this.lifetime.abort(error);
	}

	private reportExit(error: Error | undefined): void {
		if (this.exitReported) return;
		this.exitReported = true;
		this.options.onExit(error);
	}

	private takePending(id: string): PendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.pending.delete(id);
		pending.abortSubscription[Symbol.dispose]();
		return pending;
	}

	private rejectRequest(id: string, error: Error): void {
		const pending = this.takePending(id);
		pending?.reject(error);
	}

	private rejectPending(error: Error): void {
		for (const id of this.pending.keys()) this.rejectRequest(id, error);
	}

	private maxFrameBytes(): number {
		return this.options.maxFrameBytes ?? DEFAULT_RPC_MAX_FRAME_BYTES;
	}

	private maxQueuedWriteBytes(): number {
		return this.options.maxQueuedWriteBytes ?? DEFAULT_RPC_MAX_QUEUED_WRITE_BYTES;
	}

	private isFailed(): boolean {
		return this.state === "failed";
	}
}

function abortError(message: string, cause?: unknown): Error {
	const error = new Error(message, { cause });
	error.name = "AbortError";
	return error;
}

function isBlockingUiMethod(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}
