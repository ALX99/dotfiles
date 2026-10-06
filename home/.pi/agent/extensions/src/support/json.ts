import { Result } from "effect";
import { toError } from "./errors.ts";

export interface JsonDiagnostic {
	readonly source: string;
	readonly message: string;
	readonly cause: Error;
}

/** Parse untrusted JSON without asserting a domain type and retain its source in diagnostics. */
export function parseJson(source: string, sourceName: string): Result.Result<unknown, JsonDiagnostic> {
	try {
		return Result.succeed(JSON.parse(source));
	} catch (cause) {
		const error = toError(cause);
		return Result.fail({
			source: sourceName,
			message: `${sourceName}: invalid JSON: ${error.message}`,
			cause: error,
		});
	}
}
