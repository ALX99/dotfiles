/** Convert a caught or otherwise unknown value without discarding Error metadata. */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** Narrow a Node operational error by its stable code instead of its message text. */
export function hasNodeErrorCode(value: unknown, code: string): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value && value.code === code;
}
