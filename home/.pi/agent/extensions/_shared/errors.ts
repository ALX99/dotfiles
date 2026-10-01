import { Schema } from "effect";

/**
 * A filesystem operation Node refused. The operation and path are separate fields
 * so callers can report which access failed without re-parsing a message.
 */
export class FsError extends Schema.TaggedError<FsError>()("FsError", {
	operation: Schema.String,
	path: Schema.String,
	cause: Schema.Defect(),
}) {}

/** Convert a caught or otherwise unknown value without discarding Error metadata. */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** Narrow a Node operational error by its stable code instead of its message text. */
export function hasNodeErrorCode(value: unknown, code: string): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value && value.code === code;
}

/** Never suggest stealing a lock: a crash and a live writer are indistinguishable from its file alone. */
export function privateStoreErrorMessage(error: FsError): string {
	const detail =
		error.operation === "lock" && hasNodeErrorCode(error.cause, "EEXIST")
			? "another writer holds this lock; if its process crashed, inspect and remove the lock manually"
			: toError(error.cause).message;
	return `${error.operation} ${error.path}: ${detail}`;
}
