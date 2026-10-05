import * as nodeFs from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { FsError, hasNodeErrorCode } from "./errors.ts";

export interface WriteFileOptions {
	/** Create missing parent directories before writing. */
	readonly recursive?: boolean;
	/** Permission bits for a newly created file. */
	readonly mode?: number;
}

export const readFileString = (path: string): Effect.Effect<string, FsError> =>
	attempt("read", path, () => nodeFs.readFile(path, "utf8"));

/** A missing file resolves to `undefined`; every other failure stays an error. */
export const readFileStringIfExists = (path: string): Effect.Effect<string | undefined, FsError> =>
	readFileString(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));

export const writeFileString = (
	path: string,
	contents: string,
	options?: WriteFileOptions,
): Effect.Effect<void, FsError> =>
	attempt("write", path, async () => {
		if (options?.recursive) await nodeFs.mkdir(dirname(path), { recursive: true });
		await nodeFs.writeFile(path, contents, {
			encoding: "utf8",
			...(options?.mode === undefined ? {} : { mode: options.mode }),
		});
	});

export const makeDirectory = (path: string, mode?: number): Effect.Effect<void, FsError> =>
	attempt("mkdir", path, async () => {
		await nodeFs.mkdir(path, { recursive: true, ...(mode === undefined ? {} : { mode }) });
	});

/** Remove a file; a missing file resolves without error. */
export const removeFile = (path: string): Effect.Effect<void, FsError> =>
	attempt("remove", path, async () => {
		await nodeFs.rm(path, { force: true });
	});

/** Remove a directory tree; a missing directory resolves without error. */
export const removeTree = (path: string): Effect.Effect<void, FsError> =>
	attempt("remove", path, async () => {
		await nodeFs.rm(path, { recursive: true, force: true });
	});

/**
 * Remove a directory only when it is empty. A missing, non-empty, or otherwise
 * retained directory resolves without error; concurrent writers are expected,
 * so losing this race is not a failure.
 */
export const removeDirectoryIfEmpty = (path: string): Effect.Effect<void, FsError> =>
	attempt("rmdir", path, () => nodeFs.rmdir(path)).pipe(
		Effect.catchIf(
			(error) => ["ENOENT", "ENOTEMPTY", "EEXIST"].some((code) => hasNodeErrorCode(error.cause, code)),
			() => Effect.void,
		),
	);

/** Recover from a missing file only; other failures keep their original error. */
function isNotFound(error: FsError): boolean {
	return hasNodeErrorCode(error.cause, "ENOENT");
}

function attempt<A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, FsError> {
	return Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path, cause }) });
}
