/** Parsed shapes for the standalone Codex-compatible patch engine. */

export interface PatchChunk {
	/** Optional `@@ context` line used to begin the search after a landmark. */
	readonly context?: string;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
	readonly endOfFile: boolean;
	readonly line: number;
}

interface PatchOperationBase {
	readonly path: string;
	readonly line: number;
}

export interface AddPatchOperation extends PatchOperationBase {
	readonly kind: "add";
	readonly content: string;
}

export interface DeletePatchOperation extends PatchOperationBase {
	readonly kind: "delete";
}

export interface UpdatePatchOperation extends PatchOperationBase {
	readonly kind: "update";
	readonly moveTo?: string;
	readonly chunks: readonly PatchChunk[];
}

export type PatchOperation = AddPatchOperation | DeletePatchOperation | UpdatePatchOperation;

export interface ParsedPatch {
	readonly raw: string;
	readonly operations: readonly PatchOperation[];
}

export type PatchParseErrorCode = "invalid_envelope" | "empty_patch" | "invalid_header" | "invalid_hunk" | "empty_path";

export class PatchParseError extends Error {
	readonly code: PatchParseErrorCode;
	readonly line: number;

	constructor(code: PatchParseErrorCode, line: number, message: string) {
		super(`Invalid patch at line ${line}: ${message}`);
		this.name = "PatchParseError";
		this.code = code;
		this.line = line;
	}
}
