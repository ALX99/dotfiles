import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

export type RpcEvent = Record<string, unknown> & { type: string };
export type SpawnRpcProcess = typeof spawn;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface RpcTransportOptions {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	spawnProcess?: SpawnRpcProcess;
	onEvent: (event: RpcEvent) => void;
	onExit: (error: Error | undefined) => void;
}

/** Minimal bounded Pi RPC client. It deliberately cancels child UI requests:
 * subagents are non-interactive and must report questions to their parent. */
export class RpcTransport {
	private process?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private nextId = 1;
	private stderr = "";
	private closed = false;
	private failure?: Error;
	private readonly options: RpcTransportOptions;

	constructor(options: RpcTransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.process) throw new Error("RPC transport already started");
		const spawnProcess = this.options.spawnProcess ?? spawn;
		const child = spawnProcess(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.process = child;
		this.attachJsonl(child);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (Buffer.byteLength(this.stderr, "utf8") >= DEFAULT_MAX_BYTES) return;
			this.stderr = truncateHead(this.stderr + chunk, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			}).content;
		});
		child.stdin.on("error", (cause) => {
			this.reportFailure(new Error(`Subagent RPC stdin failed: ${cause.message}`, { cause }));
		});
		child.once("exit", (code, signal) => {
			if (this.closed) {
				this.rejectPending(new Error("Subagent RPC process closed."));
				this.options.onExit(undefined);
				return;
			}
			this.reportFailure(new Error(
				`Subagent RPC process exited (${signal ?? `code ${code ?? 1}`}).${this.stderr.trim() ? ` ${this.stderr.trim()}` : ""}`,
			));
		});
		child.once("error", (cause) => {
			this.reportFailure(new Error(`Could not start subagent RPC process: ${cause.message}`, { cause }));
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	}

	request(command: Record<string, unknown>): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		if (!this.process || this.closed || !this.process.stdin.writable) {
			return Promise.reject(new Error("Subagent RPC process is not available."));
		}
		const id = `subagent-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.process!.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const child = this.process;
		if (!child || child.exitCode !== null || child.pid === undefined) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
				resolve();
			}, 1_000).unref();
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private attachJsonl(child: ChildProcessWithoutNullStreams): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				this.handleLine(line);
			}
		});
		child.stdout.on("end", () => {
			buffer += decoder.end();
			if (buffer) this.handleLine(buffer.replace(/\r$/, ""));
		});
	}

	private handleLine(line: string): void {
		let event: RpcEvent;
		try {
			event = JSON.parse(line) as RpcEvent;
		} catch {
			return;
		}
		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (!pending) return;
			this.pending.delete(event.id);
			if (event.success === false) pending.reject(new Error(typeof event.error === "string" ? event.error : "RPC command failed."));
			else pending.resolve(event.data);
			return;
		}
		if (event.type === "extension_ui_request" && typeof event.id === "string") {
			this.process?.stdin.write(
				`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
				(error) => { if (error) this.reportFailure(error); },
			);
			return;
		}
		this.options.onEvent(event);
	}

	private reportFailure(error: Error): void {
		if (this.failure || this.closed) return;
		this.failure = error;
		this.rejectPending(error);
		this.options.onExit(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
