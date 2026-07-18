import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { parseJson } from "../_shared/json.ts";
import type { AgentEvent } from "./event-schema.ts";
import { parseRpcRecord, type RpcEvent } from "./protocol.ts";

export const DEFAULT_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_RPC_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_RPC_MAX_STDERR_LINES = 200;
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_CLOSE_GRACE_MS = 1_000;
export const DEFAULT_RPC_MAX_QUEUED_WRITE_BYTES = 1024 * 1024;

export type SpawnRpcProcess = typeof spawn;
export type RpcTransportState = "created" | "starting" | "open" | "closing" | "closed" | "failed";

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
	readonly signal: AbortSignal | undefined;
	readonly abortHandler: (() => void) | undefined;
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
}

/** Bounded JSONL client for one child process. This class owns the child,
 * stream listeners, request timers, abort listeners, and write queue. */
export class RpcTransport {
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private nextId = 1;
	private stderr = "";
	private state: RpcTransportState = "created";
	private failure: Error | undefined;
	private closePromise: Promise<void> | undefined;
	private teardownPromise: Promise<void> | undefined;
	private exitPromise: Promise<void> | undefined;
	private resolveExit: (() => void) | undefined;
	private exitObserved = false;
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
		const spawnProcess = this.options.spawnProcess ?? spawn;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawnProcess(this.options.command, [...this.options.args], {
				cwd: this.options.cwd,
				env: this.options.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (cause) {
			const error = new Error("Could not start subagent RPC process.", { cause });
			this.fail(error);
			throw error;
		}
		this.process = child;
		this.exitPromise = new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
		this.attachJsonl(child);
		this.attachStderr(child);
		child.stdin.on("error", (cause) => {
			this.fail(new Error(`Subagent RPC stdin failed: ${cause.message}`, { cause }));
		});
		child.once("exit", (code, signal) => this.handleExit(code, signal));
		child.once("error", (cause) => {
			const error = new Error(`Could not start subagent RPC process: ${cause.message}`, { cause });
			this.fail(error);
			this.observeExit();
		});

		try {
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
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
		if (options.signal?.aborted) return Promise.reject(abortError("RPC request was aborted."));

		const id = `subagent-${this.nextId++}`;
		let frame: Buffer;
		try {
			frame = Buffer.from(`${JSON.stringify({ ...command, id })}\n`, "utf8");
		} catch (cause) {
			return Promise.reject(new Error("Could not serialize subagent RPC request.", { cause }));
		}
		return new Promise<unknown>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
			const timer = setTimeout(() => {
				this.rejectRequest(id, new Error(`RPC request '${id}' timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			timer.unref();
			const abortHandler =
				options.signal === undefined
					? undefined
					: () => this.rejectRequest(id, abortError(`RPC request '${id}' was aborted.`));
			if (abortHandler) options.signal?.addEventListener("abort", abortHandler, { once: true });
			this.pending.set(id, {
				resolve,
				reject,
				timer,
				signal: options.signal,
				abortHandler,
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
		await this.teardownChild();
		await this.writeTail.catch(() => {});
		this.process = undefined;
		this.state = "closed";
	}

	private attachJsonl(child: ChildProcessWithoutNullStreams): void {
		let segments: Buffer[] = [];
		let bufferedBytes = 0;
		child.stdout.on("data", (raw: Buffer | string) => {
			if (this.state === "failed" || this.state === "closed") return;
			const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
			let offset = 0;
			while (offset < chunk.byteLength) {
				const newline = chunk.indexOf(0x0a, offset);
				const end = newline < 0 ? chunk.byteLength : newline;
				const segment = chunk.subarray(offset, end);
				if (bufferedBytes + segment.byteLength > this.maxFrameBytes()) {
					this.fail(new Error(`Subagent RPC frame exceeds the ${this.maxFrameBytes()} byte limit.`));
					return;
				}
				if (segment.byteLength > 0) {
					segments.push(segment);
					bufferedBytes += segment.byteLength;
				}
				if (newline < 0) break;
				let line = Buffer.concat(segments, bufferedBytes);
				if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
				segments = [];
				bufferedBytes = 0;
				this.handleLine(line.toString("utf8"));
				if (this.isFailed()) return;
				offset = newline + 1;
			}
		});
		child.stdout.on("end", () => {
			if (bufferedBytes === 0 || this.state === "failed" || this.state === "closed") return;
			let line = Buffer.concat(segments, bufferedBytes);
			if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
			this.handleLine(line.toString("utf8"));
		});
	}

	private attachStderr(child: ChildProcessWithoutNullStreams): void {
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
		await new Promise<void>((resolve, reject) => {
			let drained = true;
			let callbackDone = false;
			let settled = false;
			const finish = (): void => {
				if (!settled && drained && callbackDone) {
					settled = true;
					child.stdin.off("drain", onDrain);
					resolve();
				}
			};
			const onDrain = (): void => {
				drained = true;
				finish();
			};
			const writable = child.stdin.write(frame, (error) => {
				if (error) {
					if (!settled) {
						settled = true;
						child.stdin.off("drain", onDrain);
						reject(error);
					}
					return;
				}
				callbackDone = true;
				finish();
			});
			if (!writable) {
				drained = false;
				child.stdin.once("drain", onDrain);
			}
		});
	}

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.observeExit();
		if (this.state === "closing" || this.state === "closed") {
			this.reportExit(undefined);
			return;
		}
		const suffix = this.stderr.trim() ? ` ${this.stderr.trim()}` : "";
		this.fail(new Error(`Subagent RPC process exited (${signal ?? `code ${code ?? 1}`}).${suffix}`));
	}

	private observeExit(): void {
		if (this.exitObserved) return;
		this.exitObserved = true;
		this.resolveExit?.();
		this.resolveExit = undefined;
	}

	private fail(error: Error): void {
		if (this.state === "failed" || this.state === "closed" || this.state === "closing") return;
		this.failure = error;
		this.state = "failed";
		this.rejectPending(error);
		void this.teardownChild().then(
			() => this.reportExit(error),
			(cause) => {
				this.reportExit(new AggregateError([error, cause], "Subagent RPC transport failed and child teardown failed."));
			},
		);
	}

	private teardownChild(): Promise<void> {
		if (this.teardownPromise) return this.teardownPromise;
		this.teardownPromise = this.teardownChildInternal();
		return this.teardownPromise;
	}

	private async teardownChildInternal(): Promise<void> {
		const child = this.process;
		if (!child || this.exitObserved || child.pid === undefined) return;
		child.kill("SIGTERM");
		const graceMs = this.options.closeGraceMs ?? DEFAULT_RPC_CLOSE_GRACE_MS;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.exitPromise,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, graceMs);
					timer.unref();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (!this.exitObserved) {
			child.kill("SIGKILL");
			await this.exitPromise;
		}
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
		this.clearPendingGuards(pending);
		return pending;
	}

	private rejectRequest(id: string, error: Error): void {
		const pending = this.takePending(id);
		pending?.reject(error);
	}

	private rejectPending(error: Error): void {
		for (const id of this.pending.keys()) this.rejectRequest(id, error);
	}

	private clearPendingGuards(pending: PendingRequest): void {
		clearTimeout(pending.timer);
		if (pending.abortHandler) pending.signal?.removeEventListener("abort", pending.abortHandler);
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

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function isBlockingUiMethod(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}
