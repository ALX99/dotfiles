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

/** The directory-entry facts callers act on, without exposing Node's Dirent. */
export interface DirectoryEntry {
	readonly name: string;
	readonly isFile: boolean;
	readonly isSymbolicLink: boolean;
}

/** The link and ownership facts managed storage is validated against. */
export interface FileStatus {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
	readonly uid: number;
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

/** Directory entries in Node's order; callers sort when order is observable. */
export const readDirectory = (path: string): Effect.Effect<readonly DirectoryEntry[], FsError> =>
	attempt("readdir", path, async () => {
		const entries = await nodeFs.readdir(path, { withFileTypes: true });
		return entries.map(
			(entry): DirectoryEntry => ({
				name: entry.name,
				isFile: entry.isFile(),
				isSymbolicLink: entry.isSymbolicLink(),
			}),
		);
	});

export const realpath = (path: string): Effect.Effect<string, FsError> =>
	attempt("realpath", path, () => nodeFs.realpath(path));

export const lstat = (path: string): Effect.Effect<FileStatus, FsError> =>
	attempt("lstat", path, async () => {
		const stats = await nodeFs.lstat(path);
		return {
			isFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			isSymbolicLink: stats.isSymbolicLink(),
			uid: stats.uid,
		};
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
