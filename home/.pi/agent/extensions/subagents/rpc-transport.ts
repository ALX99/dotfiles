import { truncateTail } from "@earendil-works/pi-coding-agent";
import { execa } from "execa";
import { composeAbortSignal, onAbort } from "../_shared/abort.ts";
import { parseJson } from "../_shared/json.ts";
import type { AgentEvent } from "./event-schema.ts";
import { parseRpcRecord, type ExtensionUiRequest, type RpcEvent } from "./protocol.ts";

export const DEFAULT_RPC_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RPC_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_RPC_MAX_STDERR_LINES = 200;
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_CLOSE_GRACE_MS = 1_000;
export const DEFAULT_RPC_MAX_QUEUED_WRITE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RPC_SPAWN_TIMEOUT_MS = 30_000;

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

export type ExtensionUiResponse =
	| { readonly value: string }
	| { readonly confirmed: boolean }
	| { readonly cancelled: true };

export interface RpcTransportOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly spawnProcess?: SpawnRpcProcess;
	readonly onEvent: (event: RpcEvent) => void;
	readonly onAgentEvent?: (event: AgentEvent) => void;
	readonly onUiRequest?: (request: ExtensionUiRequest) => boolean;
	readonly onOversizedRecord?: () => void;
	readonly onExit: (error: Error | undefined) => void;
	readonly maxFrameBytes?: number;
	readonly maxStderrBytes?: number;
	readonly maxStderrLines?: number;
	readonly requestTimeoutMs?: number;
	readonly closeGraceMs?: number;
	readonly spawnTimeoutMs?: number;
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
				const timer = setTimeout(() => {
					reject(new Error(`Subagent RPC process did not spawn within ${this.spawnTimeoutMs()}ms.`));
				}, this.spawnTimeoutMs());
				const onSpawn = (): void => {
					clearTimeout(timer);
					resolve();
				};
				const onError = (cause: Error): void => {
					clearTimeout(timer);
					reject(cause);
				};
				child.nodeChildProcess.once("spawn", onSpawn);
				child.nodeChildProcess.once("error", onError);
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

	async respondToUi(requestId: string, response: ExtensionUiResponse): Promise<void> {
		if (this.failure) throw this.failure;
		if (this.state !== "open" || !this.process?.stdin.writable) {
			throw new Error("Subagent RPC process is not available.");
		}
		let frame: Buffer;
		try {
			frame = Buffer.from(
				`${JSON.stringify({
					type: "extension_ui_response",
					id: requestId,
					...response,
				})}\n`,
				"utf8",
			);
		} catch (cause) {
			throw new Error("Could not serialize subagent extension UI response.", { cause });
		}
		this.enqueueWrite(frame);
		await this.writeTail;
		if (this.failure) throw this.failure;
		if (this.state !== "open") throw new Error("Subagent RPC process is not available.");
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
		const framer = new RecoveringJsonlFramer(this.maxFrameBytes());
		child.stdout.on("data", (raw: Buffer | string) => {
			if (this.state === "failed" || this.state === "closed") return;
			const framed = framer.push(raw);
			for (let omitted = 0; omitted < framed.omittedRecords; omitted++) {
				this.options.onOversizedRecord?.();
			}
			for (const line of framed.lines) {
				this.handleLine(line);
				if (this.isFailed()) return;
			}
		});
		child.stdout.on("end", () => {
			if (this.state === "failed" || this.state === "closed") return;
			const framed = framer.end();
			for (let omitted = 0; omitted < framed.omittedRecords; omitted++) {
				this.options.onOversizedRecord?.();
			}
			for (const line of framed.lines) this.handleLine(line);
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
				try {
					if (this.options.onUiRequest?.(parsed.request) === true) return;
				} catch (cause) {
					this.fail(new Error("Subagent extension UI request handler failed.", { cause }));
					return;
				}
				if (isBlockingUiMethod(parsed.request.method)) {
					void this.respondToUi(parsed.request.id, { cancelled: true }).catch(() => {});
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

	private spawnTimeoutMs(): number {
		return this.options.spawnTimeoutMs ?? DEFAULT_RPC_SPAWN_TIMEOUT_MS;
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

export interface FramedJsonl {
	readonly lines: readonly string[];
	readonly omittedRecords: number;
}

/** Byte-bounded LF framer that drops one oversized record through its newline,
 * then resumes at the next record without decoding partial UTF-8. */
export class RecoveringJsonlFramer {
	private segments: Buffer[] = [];
	private bufferedBytes = 0;
	private discarding = false;
	private readonly maxFrameBytes: number;

	constructor(maxFrameBytes: number) {
		if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
			throw new Error("maxFrameBytes must be a positive integer.");
		}
		this.maxFrameBytes = maxFrameBytes;
	}

	push(raw: Buffer | string): FramedJsonl {
		const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
		const lines: string[] = [];
		let omittedRecords = 0;
		let offset = 0;
		while (offset < chunk.byteLength) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline < 0 ? chunk.byteLength : newline;
			if (!this.discarding) {
				const segment = chunk.subarray(offset, end);
				if (this.bufferedBytes + segment.byteLength > this.maxFrameBytes) {
					this.segments = [];
					this.bufferedBytes = 0;
					this.discarding = true;
					omittedRecords++;
				} else if (segment.byteLength > 0) {
					this.segments.push(segment);
					this.bufferedBytes += segment.byteLength;
				}
			}
			if (newline < 0) break;
			if (this.discarding) {
				this.discarding = false;
			} else {
				lines.push(this.takeLine());
			}
			offset = newline + 1;
		}
		return { lines, omittedRecords };
	}

	end(): FramedJsonl {
		if (this.discarding) {
			this.discarding = false;
			return { lines: [], omittedRecords: 0 };
		}
		return {
			lines: this.bufferedBytes === 0 ? [] : [this.takeLine()],
			omittedRecords: 0,
		};
	}

	private takeLine(): string {
		let line = Buffer.concat(this.segments, this.bufferedBytes);
		if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
		this.segments = [];
		this.bufferedBytes = 0;
		return line.toString("utf8");
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
