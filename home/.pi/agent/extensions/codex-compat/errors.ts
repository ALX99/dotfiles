export type PatchEngineErrorCode =
	| "cancelled"
	| "invalid_plan"
	| "invalid_workspace"
	| "unsafe_path"
	| "symlink_path"
	| "outside_workspace"
	| "path_conflict"
	| "missing_file"
	| "not_a_file"
	| "invalid_utf8"
	| "source_too_large"
	| "patch_mismatch"
	| "stale_source"
	| "target_exists"
	| "write_failed";

export interface PatchRollbackFailure {
	readonly operationIndex?: number;
	readonly path: string;
	readonly action: string;
	readonly message: string;
}

export interface PatchWriteFailureState {
	readonly phase: "staging" | "commit" | "rollback";
	readonly failedOperationIndex?: number;
	readonly applied: readonly AppliedChange[];
	readonly rolledBack: readonly AppliedChange[];
	readonly rollbackFailures: readonly PatchRollbackFailure[];
	readonly journalArtifacts: readonly string[];
	readonly createdDirectoriesRemaining: readonly string[];
}

export interface AppliedChange {
	readonly operationIndex: number;
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
	readonly moveTo?: string;
	readonly beforeHash?: string;
	readonly afterHash?: string;
}

export class PatchEngineError extends Error {
	readonly code: PatchEngineErrorCode;
	readonly operationIndex?: number;
	readonly patchPath?: string;
	readonly writeState?: PatchWriteFailureState;

	constructor(
		code: PatchEngineErrorCode,
		message: string,
		details: {
			readonly operationIndex?: number;
			readonly patchPath?: string;
			readonly cause?: unknown;
			readonly writeState?: PatchWriteFailureState;
		} = {},
	) {
		super(message, details.cause === undefined ? undefined : { cause: details.cause });
		this.name = "PatchEngineError";
		this.code = code;
		if (details.operationIndex !== undefined) this.operationIndex = details.operationIndex;
		if (details.patchPath !== undefined) this.patchPath = details.patchPath;
		if (details.writeState !== undefined) this.writeState = details.writeState;
	}
}

export function nodeErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}
