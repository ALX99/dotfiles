import { toError } from "./errors.ts";

export interface JsonDiagnostic {
	readonly source: string;
	readonly message: string;
	readonly cause: Error;
}

export type JsonParseResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly diagnostic: JsonDiagnostic };

/** Parse untrusted JSON without asserting a domain type and retain its source in diagnostics. */
export function parseJson(source: string, sourceName: string): JsonParseResult {
	try {
		return { ok: true, value: JSON.parse(source) };
	} catch (cause) {
		const error = toError(cause);
		return {
			ok: false,
			diagnostic: {
				source: sourceName,
				message: `${sourceName}: invalid JSON: ${error.message}`,
				cause: error,
			},
		};
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
