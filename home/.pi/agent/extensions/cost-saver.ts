/**
 * Cost Saver Extension for pi.
 *
 * Full reads are guarded by size and deduplicated by a short SHA-256
 * fingerprint. This is deliberately a cost heuristic, not a transactional
 * read guarantee: a file can change after preflight and before the read tool
 * consumes it. A successful result therefore records the fingerprint observed
 * at preflight; a later preflight will conservatively allow a read if the file
 * has changed since then.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord } from "./_shared/json.ts";

const MAX_FULL_READ_BYTES = 50 * 1024;

interface FileInfo {
	readonly size: number;
	isFile(): boolean;
}

export interface CostSaverFileSystem {
	stat(path: string): Promise<FileInfo>;
	readFile(path: string): Promise<Buffer>;
}

export interface FullReadCall {
	readonly toolCallId: string;
	readonly cwd: string;
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
}

export interface ToolResult {
	readonly toolCallId: string;
	readonly cwd: string;
	readonly input: unknown;
	readonly isError: boolean;
}

interface FileFingerprint {
	readonly path: string;
	readonly hash: string;
}

interface FullReadInput {
	readonly path: string;
	readonly offset?: unknown;
	readonly limit?: unknown;
}

interface CostSaverBlock {
	readonly block: true;
	readonly reason: string;
}

function sha256Short(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function parseFullReadInput(input: unknown): FullReadInput | undefined {
	if (!isRecord(input) || typeof input.path !== "string" || input.path.trim() === "") return undefined;
	if (input.offset !== undefined || input.limit !== undefined) return undefined;
	return { path: input.path };
}

/**
 * Owns session-local deduplication state. Fingerprints are keyed by a tool
 * call ID until the corresponding successful result arrives, preventing a
 * later result from recording another call's preflight observation.
 */
export class CostSaverController {
	private readonly fileHashCache = new Map<string, string>();
	private readonly pendingFingerprints = new Map<string, FileFingerprint>();
	private readonly fs: CostSaverFileSystem;

	constructor(fs: CostSaverFileSystem = { stat, readFile }) {
		this.fs = fs;
	}

	async preflight(call: FullReadCall): Promise<CostSaverBlock | undefined> {
		if (call.path.trim() === "") {
			return {
				block: true,
				reason: "A read path must not be blank.",
			};
		}
		if (call.offset !== undefined || call.limit !== undefined) return undefined;

		const absPath = resolve(call.cwd, call.path);
		let fileStats: FileInfo;
		try {
			fileStats = await this.fs.stat(absPath);
		} catch {
			return undefined;
		}
		if (!fileStats.isFile()) return;
		if (fileStats.size > MAX_FULL_READ_BYTES) {
			return {
				block: true,
				reason:
					`File size is ${(fileStats.size / 1024).toFixed(0)}KB, which exceeds the ${MAX_FULL_READ_BYTES / 1024}KB limit for full-file reads. ` +
					"Do not retry a full read. First, use grep to find concrete words, symbols, or error text relevant to your task. " +
					"Then read only the matching ranges and their surrounding context with offset/limit.",
			};
		}

		let fingerprint: FileFingerprint;
		try {
			fingerprint = { path: absPath, hash: sha256Short(await this.fs.readFile(absPath)) };
		} catch {
			return undefined;
		}

		if (this.fileHashCache.get(absPath) === fingerprint.hash) {
			return {
				block: true,
				reason:
					`No changes have been made to the file since your last read (hash: ${fingerprint.hash}). ` +
					"Use offset/limit if you need to re-examine specific sections.",
			};
		}

		this.pendingFingerprints.set(call.toolCallId, fingerprint);
		return undefined;
	}

	rememberResult(result: ToolResult): void {
		const fingerprint = this.pendingFingerprints.get(result.toolCallId);
		this.pendingFingerprints.delete(result.toolCallId);
		if (result.isError || !fingerprint) return;

		const input = parseFullReadInput(result.input);
		if (!input || resolve(result.cwd, input.path) !== fingerprint.path) return;
		this.fileHashCache.set(fingerprint.path, fingerprint.hash);
	}

	clear(): void {
		this.fileHashCache.clear();
		this.pendingFingerprints.clear();
	}
}

export default function costSaver(pi: ExtensionAPI): void {
	const controller = new CostSaverController();

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;
		return controller.preflight({
			toolCallId: event.toolCallId,
			cwd: ctx.cwd,
			path: event.input.path,
			...(event.input.offset === undefined ? {} : { offset: event.input.offset }),
			...(event.input.limit === undefined ? {} : { limit: event.input.limit }),
		});
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read") return;
		controller.rememberResult({
			toolCallId: event.toolCallId,
			cwd: ctx.cwd,
			input: event.input,
			isError: event.isError,
		});
	});

	pi.on("session_compact", () => controller.clear());
	pi.on("session_shutdown", () => controller.clear());
}
