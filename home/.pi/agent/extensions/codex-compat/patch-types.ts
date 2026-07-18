/** Parsed shapes for the standalone Codex-compatible patch engine. */

export interface PatchChunk {
	/** Optional `@@ context` line used to begin the search after a landmark. */
	context?: string;
	oldLines: string[];
	newLines: string[];
	endOfFile: boolean;
	line: number;
}

interface PatchOperationBase {
	path: string;
	line: number;
}

export interface AddPatchOperation extends PatchOperationBase {
	kind: "add";
	content: string;
}

export interface DeletePatchOperation extends PatchOperationBase {
	kind: "delete";
}

export interface UpdatePatchOperation extends PatchOperationBase {
	kind: "update";
	moveTo?: string;
	chunks: PatchChunk[];
}

export type PatchOperation = AddPatchOperation | DeletePatchOperation | UpdatePatchOperation;

export interface ParsedPatch {
	raw: string;
	operations: PatchOperation[];
}

export type PatchParseErrorCode =
	| "invalid_envelope"
	| "empty_patch"
	| "invalid_header"
	| "invalid_hunk"
	| "empty_path";

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
