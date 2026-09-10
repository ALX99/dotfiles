import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	APPLY_PATCH_OPENAI_LARK_GRAMMAR,
	APPLY_PATCH_TOOL_DESCRIPTION,
	APPLY_PATCH_TOOL_GUIDELINES,
	APPLY_PATCH_TOOL_NAME,
	APPLY_PATCH_TOOL_SNIPPET,
} from "./types.ts";

const APPLY_PATCH_PARAMETERS = Type.Object(
	{
		patch: Type.String({
			description: "Raw *** Begin Patch ... *** End Patch text.",
		}),
	},
	{ additionalProperties: false },
);

/** Each stream is bounded so a failed child cannot flood the model context. */
export const MAX_CAPTURED_OUTPUT_BYTES = 24 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export interface ApplyPatchToolDetails {
	readonly exitCode: 0;
}

export interface ApplyPatchSpawnOptions {
	readonly argv0: "apply_patch";
	readonly cwd: string;
	readonly shell: false;
	readonly stdio: ["pipe", "pipe", "pipe"];
	readonly windowsHide: true;
}

export type SpawnApplyPatchProcess = (
	executable: string,
	args: readonly string[],
	options: ApplyPatchSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface ApplyPatchToolOptions {
	/** Test seam for a fake executable. Production resolves `codex` through PATH. */
	readonly executable?: string;
	/** Test seam for process lifecycle failures. Production uses node:child_process.spawn. */
	readonly spawnProcess?: SpawnApplyPatchProcess;
}

interface CapturedProcess {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

class BoundedOutput {
	readonly #chunks: Buffer[] = [];
	readonly #name: "stdout" | "stderr";
	readonly #maxBytes: number;
	#capturedBytes = 0;
	#totalBytes = 0;

	constructor(name: "stdout" | "stderr", maxBytes: number) {
		this.#name = name;
		this.#maxBytes = maxBytes;
	}

	append(value: Buffer | string): void {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		this.#totalBytes += chunk.byteLength;
		const remaining = this.#maxBytes - this.#capturedBytes;
		if (remaining <= 0) return;
		const captured = chunk.subarray(0, remaining);
		this.#chunks.push(captured);
		this.#capturedBytes += captured.byteLength;
	}

	toString(): string {
		const output = Buffer.concat(this.#chunks, this.#capturedBytes).toString("utf8");
		if (this.#totalBytes <= this.#capturedBytes) return output;
		return `${output}\n[${this.#name} truncated: captured ${this.#capturedBytes} of ${this.#totalBytes} bytes]\n`;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A rejected patch is the engine's own diagnostic plus the exit status, matching what Codex
 * prints when the same patch runs outside its pre-verified handler. Process-level failures keep
 * the labeled capture below because those streams are Pi's only view of what went wrong.
 */
function patchFailure(output: Pick<CapturedProcess, "stdout" | "stderr" | "code" | "signal">): Error {
	const status =
		output.code === null ? `terminated by signal ${output.signal ?? "unknown"}` : `exited with status ${output.code}`;
	const diagnostic = [output.stderr.trim(), output.stdout.trim()].filter((text) => text.length > 0).join("\n");
	return new Error(diagnostic.length > 0 ? `${diagnostic}\napply_patch ${status}` : `apply_patch ${status}`);
}

function processFailure(headline: string, output: Pick<CapturedProcess, "stdout" | "stderr">, cause?: unknown): Error {
	const message = [headline, "", "stdout:", output.stdout || "(empty)", "", "stderr:", output.stderr || "(empty)"].join(
		"\n",
	);
	return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function captureStream(stream: Readable, output: BoundedOutput, onError: (error: Error) => void): void {
	stream.on("data", (chunk: Buffer | string) => output.append(chunk));
	stream.once("error", onError);
}

const defaultSpawnProcess: SpawnApplyPatchProcess = (executable, args, options) =>
	spawn(executable, [...args], options);

/** Run Codex in its apply_patch multicall mode: no shell, wrapper, or sandbox. */
export async function runApplyPatchProcess(
	executable: string,
	patch: string,
	cwd: string,
	signal: AbortSignal | undefined,
	spawnProcess: SpawnApplyPatchProcess = defaultSpawnProcess,
): Promise<CapturedProcess> {
	if (signal?.aborted) {
		throw processFailure("apply_patch was cancelled before it started", { stdout: "", stderr: "" });
	}

	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawnProcess(executable, [], {
			argv0: "apply_patch",
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (cause) {
		throw processFailure(`Could not start apply_patch: ${errorMessage(cause)}`, { stdout: "", stderr: "" }, cause);
	}

	const stdout = new BoundedOutput("stdout", MAX_CAPTURED_OUTPUT_BYTES);
	const stderr = new BoundedOutput("stderr", MAX_CAPTURED_OUTPUT_BYTES);
	let childError: Error | undefined;
	let stdinError: Error | undefined;
	let stdoutError: Error | undefined;
	let stderrError: Error | undefined;
	let cancelled = false;
	let closed = false;
	let forceKillTimer: NodeJS.Timeout | undefined;
	const completion = new Promise<CapturedProcess>((resolve) => {
		child.once("close", (code, closeSignal) => {
			closed = true;
			resolve({
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				code,
				signal: closeSignal,
			});
		});
	});

	const terminate = (): void => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// The close/error events below remain authoritative.
		}
		if (child.pid !== undefined && forceKillTimer === undefined) {
			forceKillTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					try {
						child.kill("SIGKILL");
					} catch {
						// The close/error events below remain authoritative.
					}
				}
			}, FORCE_KILL_DELAY_MS);
			forceKillTimer.unref();
		}
	};
	const onAbort = (): void => {
		if (closed) return;
		cancelled = true;
		terminate();
	};

	child.once("error", (error) => {
		childError = error;
	});
	child.stdin.once("error", (error) => {
		stdinError = error;
		terminate();
	});
	captureStream(child.stdout, stdout, (error) => {
		stdoutError = error;
		terminate();
	});
	captureStream(child.stderr, stderr, (error) => {
		stderrError = error;
		terminate();
	});
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();

	if (!cancelled) {
		try {
			child.stdin.end(patch, "utf8");
		} catch (error) {
			stdinError = error instanceof Error ? error : new Error(String(error));
			terminate();
		}
	} else {
		child.stdin.destroy();
	}

	const result = await completion;

	signal?.removeEventListener("abort", onAbort);
	if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);

	if (cancelled) throw processFailure("apply_patch was cancelled", result);
	if (childError !== undefined) {
		throw processFailure(`Could not run apply_patch: ${childError.message}`, result, childError);
	}
	if (stdinError !== undefined) {
		throw processFailure(`Could not send the patch to apply_patch: ${stdinError.message}`, result, stdinError);
	}
	if (stdoutError !== undefined) {
		throw processFailure(`Could not read apply_patch stdout: ${stdoutError.message}`, result, stdoutError);
	}
	if (stderrError !== undefined) {
		throw processFailure(`Could not read apply_patch stderr: ${stderrError.message}`, result, stderrError);
	}
	if (result.code !== 0) throw patchFailure(result);
	return result;
}

export function createApplyPatchTool(
	options: ApplyPatchToolOptions = {},
): ToolDefinition<typeof APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails> {
	return {
		name: APPLY_PATCH_TOOL_NAME,
		label: "Apply Patch",
		description: APPLY_PATCH_TOOL_DESCRIPTION,
		promptSnippet: APPLY_PATCH_TOOL_SNIPPET,
		promptGuidelines: APPLY_PATCH_TOOL_GUIDELINES,
		parameters: APPLY_PATCH_PARAMETERS,
		// Codex registers apply_patch as an OpenAI custom/freeform tool. Keep
		// that transport while leaving complete syntax validation to Codex.
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: APPLY_PATCH_OPENAI_LARK_GRAMMAR },
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const executable = options.executable ?? "codex";
			const result = await runApplyPatchProcess(executable, params.patch, ctx.cwd, signal, options.spawnProcess);
			return {
				content: [{ type: "text", text: result.stdout }],
				details: { exitCode: 0 },
			};
		},
	};
}

/**
 * Codex registers `apply_patch` from model metadata (`apply_patch_tool_type == "freeform"`),
 * never from the model name. The Pi equivalent is the compat flag that makes the provider emit
 * OpenAI custom tools with a Lark grammar; without it the tool would reach the model as an
 * ordinary JSON function tool, which Codex has no equivalent of.
 */
export function supportsApplyPatchTransport(model: { compat?: unknown } | undefined): boolean {
	const compat = model?.compat;
	if (typeof compat !== "object" || compat === null) return false;
	return (compat as { supportsOpenAIGrammarTools?: unknown }).supportsOpenAIGrammarTools === true;
}

export function registerCodexCompat(pi: ExtensionAPI, options: ApplyPatchToolOptions = {}): void {
	pi.registerTool(createApplyPatchTool(options));

	const suppressedBuiltinTools: string[] = [];
	const setCodexCompatToolsActive = (enabled: boolean): void => {
		const active = pi.getActiveTools();
		let next = active;
		if (enabled) {
			if (!next.includes(APPLY_PATCH_TOOL_NAME)) next = [...next, APPLY_PATCH_TOOL_NAME];
			if (active.some((name) => name === "edit" || name === "write")) {
				for (const name of active) {
					if ((name === "edit" || name === "write") && !suppressedBuiltinTools.includes(name)) {
						suppressedBuiltinTools.push(name);
					}
				}
				next = next.filter((tool) => tool !== "edit" && tool !== "write");
			}
		} else {
			if (next.includes(APPLY_PATCH_TOOL_NAME)) next = next.filter((tool) => tool !== APPLY_PATCH_TOOL_NAME);
			for (const name of suppressedBuiltinTools) {
				if (!next.includes(name)) next = [...next, name];
			}
			suppressedBuiltinTools.length = 0;
		}
		if (next !== active) pi.setActiveTools(next);
	};

	pi.on("session_start", (_event, ctx) => setCodexCompatToolsActive(supportsApplyPatchTransport(ctx.model)));
	pi.on("model_select", (event) => setCodexCompatToolsActive(supportsApplyPatchTransport(event.model)));
}

export default function codexCompatExtension(pi: ExtensionAPI): void {
	registerCodexCompat(pi);
}
